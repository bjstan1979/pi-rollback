import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import rollbackExtension, {
  capture as captureSnapshot,
  parseRollbackArgs,
  resolveLabelQuery,
  restore as restoreSnapshot,
  ROLLBACK_RESULT_EVENT,
  safeHash,
  sessionStore as sessionSnapshotStore,
  snapshotDir as snapshotDirectory,
} from "./index.js";
import {
  bashPathHints,
  captureFileState as captureState,
  isDestructiveCommand,
  isHcomSandbox,
  mutationPaths,
  restoreFileState as restoreState,
  type FileState,
} from "./journal.js";

const cleanup: string[] = [];
const testLayouts = new Map<string, string>();

function testLayout(name = "default"): string {
  let path = testLayouts.get(name);
  if (!path) {
    path = mkdtempSync(join(tmpdir(), "pi-rollback-test-store-"));
    testLayouts.set(name, path);
    cleanup.push(path);
  }
  return path;
}

function snapshotDir(cwd: string, storeBase = testLayout()): string {
  return snapshotDirectory(cwd, storeBase);
}

function sessionStore(sessionId: string): string {
  return sessionSnapshotStore(sessionId, testLayout("sessions"));
}

function capture(pi: ExtensionAPI, cwd: string, storeBase = testLayout()): Promise<string> {
  return captureSnapshot(pi, cwd, storeBase);
}

function restore(pi: ExtensionAPI, cwd: string, target: string, storeBase = testLayout()): Promise<{ files: number; before: string }> {
  return restoreSnapshot(pi, cwd, target, storeBase);
}

function captureFileState(path: string): FileState {
  return captureState(path, testLayout("blobs"));
}

function restoreFileState(path: string, state: FileState): void {
  restoreState(path, state, testLayout("blobs"));
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  testLayouts.clear();
});
test("parses human-friendly rollback commands and retains JSON compatibility", () => {
  assert.deepEqual(parseRollbackArgs("before-refactor"), { labelQuery: "before-refactor" });
  assert.deepEqual(parseRollbackArgs("before the big refactor"), { labelQuery: "before the big refactor" });
  assert.deepEqual(parseRollbackArgs("label:run 2"), { labelQuery: "run 2" });
  assert.deepEqual(parseRollbackArgs("before-refactor -- Try the smaller fix."), {
    labelQuery: "before-refactor",
    continuePrompt: "Try the smaller fix.",
  });
  assert.deepEqual(parseRollbackArgs("entry:message-42"), { targetEntryId: "message-42" });
  assert.deepEqual(parseRollbackArgs("2 -- Retry carefully."), { count: 2, continuePrompt: "Retry carefully." });
  assert.deepEqual(parseRollbackArgs("run 2"), { runCount: 2 });
  assert.deepEqual(parseRollbackArgs("Runs 1 -- Start over"), { runCount: 1, continuePrompt: "Start over" });
  assert.deepEqual(parseRollbackArgs('{"runCount":1,"requestId":"remote"}'), { runCount: 1, requestId: "remote" });
  assert.deepEqual(parseRollbackArgs('{"targetLabel":"before-refactor"}'), { targetLabel: "before-refactor" });
  assert.throws(() => parseRollbackArgs("before-refactor --"), /Missing continuation prompt/);
  assert.throws(() => parseRollbackArgs('{"continuePrompt":1}'), /continuePrompt must be a string/);
  assert.throws(() => parseRollbackArgs('{"count":0}'), /count must be a positive integer/);
  assert.throws(() => parseRollbackArgs('{"typo":1}'), /Unknown rollback option/);
});

test("resolves free-form checkpoint label queries", () => {
  const base = { version: 2 as const, entryId: "e", seq: 0, createdAt: 0, mode: "normal" as const };
  const all = [
    { ...base, label: "before refactor" },
    { ...base, label: "Before Migration" },
    { ...base, label: "rollback-before-1-0" },
  ];
  assert.equal(resolveLabelQuery(all, "before refactor"), "before refactor");
  assert.equal(resolveLabelQuery(all, "before migration"), "Before Migration");
  assert.equal(resolveLabelQuery(all, "refactor"), "before refactor");
  assert.equal(resolveLabelQuery([{ ...base, label: "run 2" }], "run 2"), "run 2");
  assert.throws(() => resolveLabelQuery(all, "before"), /Ambiguous/);
  assert.throws(() => resolveLabelQuery(all, "missing"), /No checkpoint matching/);
});

test("destructive command detection stays conservative", () => {
  assert.equal(isDestructiveCommand("rm -rf build"), true);
  assert.equal(isDestructiveCommand("cd /repo && git reset --hard HEAD~1"), true);
  assert.equal(isDestructiveCommand("git clean -fdx"), true);
  assert.equal(isDestructiveCommand("git checkout -- ."), true);
  assert.equal(isDestructiveCommand("git restore src/"), true);
  assert.equal(isDestructiveCommand("find . -name '*.log' -delete"), true);
  assert.equal(isDestructiveCommand("echo 'DROP TABLE users' | psql"), true);
  assert.equal(isDestructiveCommand("Remove-Item -Recurse tmp"), true);
  assert.equal(isDestructiveCommand("dd if=img.iso of=/dev/sda"), true);
  assert.equal(isDestructiveCommand("printf changed > demo.txt"), false);
  assert.equal(isDestructiveCommand("git status"), false);
  assert.equal(isDestructiveCommand("git checkout -b feature"), false);
  assert.equal(isDestructiveCommand("npm install"), false);
  assert.equal(isDestructiveCommand("echo firmware-update"), false);
});

function exec(command: string, args: string[], options?: { cwd?: string }) {
  const process = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
  return Promise.resolve({ stdout: process.stdout, stderr: process.stderr, code: process.status ?? 1, killed: false });
}

function mockPi(): ExtensionAPI {
  return { exec } as ExtensionAPI;
}

function harness(cwd: string, options: { sandboxed?: boolean; deepTracking?: boolean; guardDestructive?: boolean; sendUserMessageError?: Error; pruneSettings?: Record<string, unknown> } = {}) {
  cleanup.push(sessionStore("session-test"));
  const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
  const commands: Record<string, (args: string, ctx: any) => Promise<void>> = {};
  const tools: string[] = [];
  const toolDefs: Record<string, any> = {};
  const entries: any[] = [{ id: "message-0", type: "message", parentId: null }];
  let leaf = "message-0";
  const branch = () => {
    const active: any[] = [];
    let current: string | null = leaf;
    while (current) {
      const entry = entries.find((item) => item.id === current);
      if (!entry) break;
      active.unshift(entry);
      current = entry.parentId;
    }
    return active;
  };
  let next = 0;
  let navigatedTo: string | undefined;
  const notifications: string[] = [];
  const sentMessages: Array<{ content: string; options: unknown }> = [];
  const emitted: Array<{ event: string; data: unknown }> = [];
  const pi = {
    exec,
    events: { emit(event: string, data: unknown) { emitted.push({ event, data }); } },
    on(name: string, handler: (event: any, ctx: any) => Promise<any>) { handlers[name] = handler; },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) { commands[name] = options.handler; },
    registerTool(tool: { name: string }) { tools.push(tool.name); toolDefs[tool.name] = tool; },
    setLabel() {},
    appendEntry(customType: string, data: unknown) {
      const entry = { id: `custom-${++next}`, type: "custom", customType, data, parentId: leaf };
      entries.push(entry);
      leaf = entry.id;
    },
    async sendUserMessage(content: string, sendOptions: unknown) {
      if (options.sendUserMessageError) throw options.sendUserMessageError;
      sentMessages.push({ content, options: sendOptions });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    ui: { notify(message: string) { notifications.push(message); } },
    sessionManager: {
      getLeafId: () => leaf,
      getSessionId: () => "session-test",
      getBranch: branch,
      getEntries: () => entries,
    },
    async waitForIdle() {},
    async navigateTree(target: string) {
      assert.ok(entries.some((entry) => entry.id === target), `missing navigation target ${target}`);
      navigatedTo = target;
      leaf = target;
      return { cancelled: false };
    },
  };
  const oldMode = process.env.HCOM_WORKER_SANDBOX;
  const oldRoot = process.env.HCOM_WORKER_SANDBOX_ROOT;
  const oldDeepTracking = process.env.PI_ROLLBACK_DEEP_TRACKING;
  const oldGuardDestructive = process.env.PI_ROLLBACK_GUARD_DESTRUCTIVE;
  const pruneRoot = mkdtempSync(join(tmpdir(), "pi-rollback-harness-store-"));
  cleanup.push(pruneRoot);
  if (options.pruneSettings) writeFileSync(join(pruneRoot, "settings.json"), JSON.stringify(options.pruneSettings));
  const pruneEnvNames = [
    "PI_ROLLBACK_PRUNE",
    "PI_ROLLBACK_RETENTION_DAYS",
    "PI_ROLLBACK_MAX_STORE_GB",
    "PI_ROLLBACK_PRUNE_INTERVAL_HOURS",
    "PI_ROLLBACK_MIGRATION_GRACE_DAYS",
  ] as const;
  const oldPruneEnv = new Map(pruneEnvNames.map((name) => [name, process.env[name]]));
  for (const name of pruneEnvNames) delete process.env[name];
  if (options.sandboxed) process.env.HCOM_WORKER_SANDBOX = "workspace";
  else delete process.env.HCOM_WORKER_SANDBOX;
  if (options.deepTracking) process.env.PI_ROLLBACK_DEEP_TRACKING = "1";
  else delete process.env.PI_ROLLBACK_DEEP_TRACKING;
  if (options.guardDestructive === false) process.env.PI_ROLLBACK_GUARD_DESTRUCTIVE = "0";
  else delete process.env.PI_ROLLBACK_GUARD_DESTRUCTIVE;
  delete process.env.HCOM_WORKER_SANDBOX_ROOT;
  try {
    rollbackExtension(pi, {
      normalLayoutRoot: pruneRoot,
      blobRoot: testLayout("blobs"),
      pruneSettingsPath: join(pruneRoot, "settings.json"),
    });
  } finally {
    if (oldMode === undefined) delete process.env.HCOM_WORKER_SANDBOX; else process.env.HCOM_WORKER_SANDBOX = oldMode;
    if (oldRoot === undefined) delete process.env.HCOM_WORKER_SANDBOX_ROOT; else process.env.HCOM_WORKER_SANDBOX_ROOT = oldRoot;
    if (oldDeepTracking === undefined) delete process.env.PI_ROLLBACK_DEEP_TRACKING; else process.env.PI_ROLLBACK_DEEP_TRACKING = oldDeepTracking;
    if (oldGuardDestructive === undefined) delete process.env.PI_ROLLBACK_GUARD_DESTRUCTIVE; else process.env.PI_ROLLBACK_GUARD_DESTRUCTIVE = oldGuardDestructive;
    for (const name of pruneEnvNames) {
      const value = oldPruneEnv.get(name);
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  return { handlers, commands, tools, toolDefs, entries, ctx, notifications, sentMessages, emitted, pruneRoot, navigatedTo: () => navigatedTo, activeEntries: branch };
}

test("root snapshot restores files without touching the project git index", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-root-"));
  cleanup.push(cwd, snapshotDir(cwd));
  writeFileSync(join(cwd, "kept.txt"), "before\n");
  assert.equal(spawnSync("git", ["init"], { cwd }).status, 0);
  assert.equal(spawnSync("git", ["add", "kept.txt"], { cwd }).status, 0);
  const projectIndex = readFileSync(join(cwd, ".git", "index"));
  const pi = mockPi();
  const target = await capture(pi, cwd);
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), projectIndex);
  writeFileSync(join(cwd, "kept.txt"), "after\n");
  writeFileSync(join(cwd, "created.txt"), "new\n");

  assert.equal((await restore(pi, cwd, target)).files, 2);
  assert.equal(readFileSync(join(cwd, "kept.txt"), "utf8"), "before\n");
  assert.equal(existsSync(join(cwd, "created.txt")), false);
});

test("snapshot keeps readable files when Git skips an unindexable path", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-unreadable-"));
  const gitDir = snapshotDir(cwd);
  cleanup.push(cwd, gitDir);
  writeFileSync(join(cwd, "kept.txt"), "kept\n");
  writeFileSync(join(cwd, "runtime.lock"), "unreadable\n");
  let fatal = false;
  const pi = {
    async exec(command: string, args: string[], options?: { cwd?: string }) {
      if (args.includes("--ignore-errors")) {
        if (fatal) return { stdout: "", stderr: "fatal storage failure", code: 128, killed: false };
        const staged = await exec(command, [...args.slice(0, -1), "kept.txt"], options);
        return { ...staged, stderr: 'error: open("runtime.lock"): Permission denied', code: 1 };
      }
      return exec(command, args, options);
    },
  } as ExtensionAPI;

  const tree = await capture(pi, cwd);
  const listed = spawnSync("git", ["--git-dir", gitDir, "ls-tree", "-r", "--name-only", tree], { encoding: "utf8" });
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout, "kept.txt\n");
  fatal = true;
  await assert.rejects(capture(pi, cwd), /fatal storage failure/);
});

test("snapshot repositories are isolated by session", () => {
  assert.notEqual(snapshotDir("/work", sessionStore("session-a")), snapshotDir("/work", sessionStore("session-b")));
});

test("concurrent sessions cannot overwrite each other's capture index", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-concurrent-sessions-"));
  const storeA = sessionStore("concurrent-a");
  const storeB = sessionStore("concurrent-b");
  cleanup.push(cwd, storeA, storeB);
  const file = join(cwd, "demo.txt");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reachedWriteTree!: () => void;
  const paused = new Promise<void>((resolve) => { reachedWriteTree = resolve; });
  const delayedPi = {
    async exec(command: string, args: string[], options?: { cwd?: string }) {
      if (args.includes("write-tree")) {
        reachedWriteTree();
        await gate;
      }
      return exec(command, args, options);
    },
  } as ExtensionAPI;

  writeFileSync(file, "snapshot A\n");
  const captureA = capture(delayedPi, cwd, storeA);
  await paused;
  writeFileSync(file, "snapshot B\n");
  const treeB = await capture(mockPi(), cwd, storeB);
  release();
  const treeA = await captureA;
  assert.notEqual(treeA, treeB);
});

test("captured trees remain reachable after later captures and Git pruning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-pinned-tree-"));
  const gitDir = snapshotDir(cwd);
  cleanup.push(cwd, gitDir);
  const file = join(cwd, "demo.txt");
  writeFileSync(file, "snapshot A\n");
  const treeA = await capture(mockPi(), cwd);
  writeFileSync(file, "snapshot B\n");
  await capture(mockPi(), cwd);
  assert.equal(spawnSync("git", ["--git-dir", gitDir, "prune", "--expire", "now"]).status, 0);
  assert.equal(spawnSync("git", ["--git-dir", gitDir, "cat-file", "-e", treeA]).status, 0);
});

test("restore never deletes files when Git cannot inspect the target tree", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-inspection-failure-"));
  cleanup.push(cwd, snapshotDir(cwd));
  const file = join(cwd, "demo.txt");
  writeFileSync(file, "target\n");
  const target = await capture(mockPi(), cwd);
  writeFileSync(file, "current\n");
  const pi = {
    async exec(command: string, args: string[], options?: { cwd?: string }) {
      if (args.includes("ls-tree")) return { stdout: "", stderr: "repository I/O failure", code: 128, killed: false };
      return exec(command, args, options);
    },
  } as ExtensionAPI;

  await assert.rejects(restore(pi, cwd, target), /original workspace state could not be restored/);
  assert.equal(readFileSync(file, "utf8"), "current\n");
});

test("restore reverses files already changed when a later checkout fails", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-partial-failure-"));
  cleanup.push(cwd, snapshotDir(cwd));
  const first = join(cwd, "a.txt");
  const second = join(cwd, "b.txt");
  writeFileSync(first, "target\n");
  writeFileSync(second, "target\n");
  const target = await capture(mockPi(), cwd);
  writeFileSync(first, "current\n");
  writeFileSync(second, "current\n");
  let checkouts = 0;
  const pi = {
    async exec(command: string, args: string[], options?: { cwd?: string }) {
      if (args.includes("checkout") && ++checkouts === 2) {
        return { stdout: "", stderr: "injected checkout failure", code: 1, killed: false };
      }
      return exec(command, args, options);
    },
  } as ExtensionAPI;

  await assert.rejects(restore(pi, cwd, target), /injected checkout failure/);
  assert.equal(readFileSync(first, "utf8"), "current\n");
  assert.equal(readFileSync(second, "utf8"), "current\n");
});

test("normal mode rollback and redo restore files plus the original checkpoint branch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-cwd-"));
  const external = mkdtempSync(join(tmpdir(), "pi-rollback-external-"));
  cleanup.push(cwd, external, snapshotDir(cwd), snapshotDir(external));
  const file = join(external, "demo.txt");
  writeFileSync(file, "original\n");
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "write", input: { path: file } }, run.ctx);
  writeFileSync(file, "modified outside cwd\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);
  assert.equal(readFileSync(file, "utf8"), "modified outside cwd\n");
  const originalLeaf = run.ctx.sessionManager.getLeafId();
  const originalLabels = run.activeEntries().flatMap((entry) => entry.data?.label ? [entry.data.label] : []);

  await run.commands.rollback!("1", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "original\n");
  assert.equal(run.navigatedTo(), "message-0");
  assert.deepEqual(run.activeEntries().flatMap((entry) => entry.data?.label ? [entry.data.label] : []), []);

  await run.commands.redo!("", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "modified outside cwd\n");
  assert.equal(run.navigatedTo(), originalLeaf);
  assert.deepEqual(run.activeEntries().flatMap((entry) => entry.data?.label ? [entry.data.label] : []), originalLabels);
});

test("redo refuses to overwrite changes made after rollback", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-redo-guard-"));
  cleanup.push(cwd, snapshotDir(cwd));
  const file = join(cwd, "demo.txt");
  writeFileSync(file, "original\n");
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "write", input: { path: file } }, run.ctx);
  writeFileSync(file, "agent change\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);
  await run.commands.rollback!("1", run.ctx);

  writeFileSync(file, "new work after rollback\n");
  await run.commands.redo!("", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "new work after rollback\n");
  assert.match(run.notifications.at(-1)!, /changed after rollback/);
});

test("preserves the agent-written checkpoint when an external edit happens later", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-cwd-"));
  const external = mkdtempSync(join(tmpdir(), "pi-rollback-external-"));
  cleanup.push(cwd, external, snapshotDir(cwd), snapshotDir(external));
  const file = join(external, "demo.txt");
  writeFileSync(file, "original\n");
  const run = harness(cwd, { deepTracking: true });

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "write", input: { path: file } }, run.ctx);
  writeFileSync(file, "modified by agent write\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);
  writeFileSync(file, "broken by later external edit\n");
  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);

  await run.commands.rollback!('{"targetLabel":"rollback-after-1-0"}', run.ctx);
  assert.equal(readFileSync(file, "utf8"), "modified by agent write\n");
});

test("tracks a bash mutation in another project root", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-bash-cwd-"));
  const external = mkdtempSync(join(tmpdir(), "pi-rollback-bash-external-"));
  cleanup.push(cwd, external, snapshotDir(cwd), snapshotDir(external));
  const file = join(external, "demo.txt");
  writeFileSync(file, "bash original\n");
  const run = harness(cwd, { deepTracking: true });

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "bash", input: { command: `cd ${external} && printf changed > demo.txt` } }, run.ctx);
  writeFileSync(file, "bash changed\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);

  await run.commands.rollback!("1", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "bash original\n");
});

test("turn start never rescans historical shell roots", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-turn-cwd-"));
  const external = mkdtempSync(join(tmpdir(), "pi-rollback-turn-external-"));
  cleanup.push(cwd, external, snapshotDir(cwd), snapshotDir(external));
  const file = join(external, "demo.txt");
  writeFileSync(file, "original\n");
  const run = harness(cwd, { deepTracking: true });

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "bash", input: { command: `cd ${external} && printf changed > demo.txt` } }, run.ctx);
  writeFileSync(file, "changed\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);
  const rootCount = run.entries.filter((entry) => entry.data?.kind === "root").length;

  writeFileSync(file, "external\n");
  await run.handlers.turn_start!({ turnIndex: 1 }, run.ctx);
  assert.equal(run.entries.filter((entry) => entry.data?.kind === "root").length, rootCount);
});

test("shell snapshots are disabled by default", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-shell-default-"));
  cleanup.push(cwd, snapshotDir(cwd));
  const file = join(cwd, "demo.txt");
  writeFileSync(file, "original\n");
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "bash", input: { command: "printf changed > demo.txt" } }, run.ctx);
  writeFileSync(file, "changed\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);
  await run.commands.rollback!("1", run.ctx);

  assert.equal(readFileSync(file, "utf8"), "changed\n");
  assert.equal(run.entries.some((entry) => entry.data?.kind === "root"), false);
});

test("sandbox mode snapshots cwd only and stores its shadow repo inside cwd", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-sandbox-"));
  cleanup.push(cwd);
  const file = join(cwd, "demo.txt");
  writeFileSync(file, "sandbox original\n");
  const run = harness(cwd, { sandboxed: true });

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  writeFileSync(file, "sandbox changed\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);
  assert.equal(existsSync(join(cwd, ".pi", ".rollback-snapshots")), true);
  const sandboxRoot = join(cwd, ".pi", ".rollback-snapshots");
  const session = readdirSync(sandboxRoot).find((name) => /^[0-9a-f]{24}$/.test(name));
  const activity = JSON.parse(readFileSync(join(sandboxRoot, session!, ".activity.json"), "utf8"));
  assert.equal(typeof activity.lastUsedAt, "number");

  await run.commands.rollback!("1", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "sandbox original\n");
  await run.commands.redo!("", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "sandbox changed\n");
});

test("sandbox detection uses canonical active modes and path filtering", () => {
  assert.equal(isHcomSandbox({ HCOM_WORKER_SANDBOX: "workspace" }), true);
  assert.equal(isHcomSandbox({ HCOM_WORKER_SANDBOX: "podman-workspace" }), true);
  assert.equal(isHcomSandbox({ HCOM_WORKER_SANDBOX: "off", HCOM_WORKER_SANDBOX_ROOT: "/stale" }), false);
  assert.equal(isHcomSandbox({ HCOM_WORKER_SANDBOX: "unexpected", HCOM_WORKER_SANDBOX_ROOT: "/stale" }), false);
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-filter-"));
  const external = mkdtempSync(join(tmpdir(), "pi-rollback-filter-out-"));
  cleanup.push(cwd, external);
  assert.deepEqual(mutationPaths("write", { path: join(external, "x.txt") }, cwd, true), []);
  assert.deepEqual(mutationPaths("write", { path: join(external, "x.txt") }, cwd, false), [join(external, "x.txt")]);
});

test("path hints include quoted POSIX and Windows absolute arguments", () => {
  assert.ok(bashPathHints('printf changed > "/outside root/demo.txt"', "/work", "linux").includes("/outside root/demo.txt"));
  const windowsPath = win32.normalize("C:\\outside root\\demo.txt");
  assert.ok(bashPathHints('Set-Content -Path "C:\\outside root\\demo.txt" -Value changed', "/work", "win32").includes(windowsPath));
  assert.equal(bashPathHints('Set-Content -Path "C:\\outside root\\demo.txt" -Value changed', "/work", "linux").includes(windowsPath), false);
});
test("run-count rollback crosses intervening automatic turn checkpoints and publishes a result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-entry-"));
  cleanup.push(cwd, snapshotDir(cwd));
  const file = join(cwd, "demo.txt");
  writeFileSync(file, "original\n");
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "write", input: { path: file } }, run.ctx);
  writeFileSync(file, "changed\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 1 }, run.ctx);
  await run.handlers.turn_end!({ turnIndex: 1 }, run.ctx);

  await run.commands.rollback!('{"runCount":1,"requestId":"supervisor-request-1"}', run.ctx);
  assert.equal(readFileSync(file, "utf8"), "original\n");
  assert.equal(run.navigatedTo(), "message-0");
  assert.equal(run.emitted.length, 1);
  assert.equal(run.emitted[0]!.event, ROLLBACK_RESULT_EVENT);
  assert.deepEqual(run.emitted[0]!.data, {
    version: 1,
    requestId: "supervisor-request-1",
    ok: true,
    targetEntryId: "message-0",
    targetLabel: "rollback-before-1-0",
    files: 1,
    createdAt: (run.emitted[0]!.data as { createdAt: number }).createdAt,
  });
});
test("failed requested rollback publishes a machine-readable result", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-result-"));
  cleanup.push(cwd);
  const run = harness(cwd);

  await run.commands.rollback!('{"runCount":1,"requestId":"missing-target"}', run.ctx);
  const result = run.emitted[0]!.data as { requestId: string; ok: boolean; error: string };
  assert.equal(result.requestId, "missing-target");
  assert.equal(result.ok, false);
  assert.match(result.error, /Can roll back at most 0 agent run/);
  assert.equal(run.navigatedTo(), undefined);
});

test("continuation queue failure does not publish a contradictory rollback failure", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-continuation-result-"));
  cleanup.push(cwd);
  const run = harness(cwd, { sendUserMessageError: new Error("queue unavailable") });
  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);

  await run.commands.rollback!('{"count":1,"requestId":"same","continuePrompt":"continue"}', run.ctx);
  assert.equal(run.emitted.length, 1);
  assert.equal((run.emitted[0]!.data as { ok: boolean }).ok, true);
  assert.match(run.notifications.join("\n"), /continuation could not be queued/);
});

test("LLM rollback tool dispatches the extension command on the follow-up turn", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-tool-"));
  cleanup.push(cwd);
  const run = harness(cwd);
  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.toolDefs.rollback.execute("tool-1", { count: 1, summarize: true }, undefined, undefined, run.ctx);
  assert.deepEqual(run.sentMessages, [{
    content: '/rollback {"summarize":true,"targetEntryId":"message-0"}',
    options: { deliverAs: "followUp", expandPromptTemplates: true },
  }]);
  assert.match(run.toolDefs.rollback.promptSnippet, /conversation and journaled workspace files/);
  assert.match(run.toolDefs.rollback.promptGuidelines.join("\n"), /count is run-relative/);
  assert.match(run.toolDefs.rollback.promptGuidelines.join("\n"), /proactively roll back without waiting for the user/);
  assert.match(run.toolDefs.rollback.promptGuidelines.join("\n"), /isolated mistake with a clear local fix/);
});

test("registers mutation hooks and commands", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-register-"));
  cleanup.push(cwd);
  const run = harness(cwd);
  assert.deepEqual(Object.keys(run.handlers), ["tool_call", "session_start", "session_shutdown", "agent_start", "turn_start", "turn_end", "agent_settled"]);
  assert.deepEqual(Object.keys(run.commands), ["checkpoint", "checkpoints", "rollback-prune", "rollback", "redo"]);
  assert.deepEqual(run.tools, ["checkpoint", "rollback"]);
});
test("global settings can disable pruning without environment variables", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-settings-"));
  cleanup.push(cwd);
  const run = harness(cwd, { pruneSettings: { PI_ROLLBACK_PRUNE: false } });
  await run.handlers.session_start!({}, run.ctx);
  await run.commands["rollback-prune"]!("", run.ctx);
  assert.match(run.notifications.at(-1)!, /disabled by PI_ROLLBACK_PRUNE=0/);
  assert.equal(existsSync(join(run.pruneRoot, ".last-prune.json")), false);
});


test("normal lifecycle protects its session and exposes immediate pruning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-lifecycle-"));
  cleanup.push(cwd);
  const run = harness(cwd);
  await run.handlers.session_start!({}, run.ctx);
  const leaseDir = join(run.pruneRoot, ".leases");
  const leases = readdirSync(leaseDir);
  assert.equal(leases.length, 1);
  const lease = JSON.parse(readFileSync(join(leaseDir, leases[0]!), "utf8"));
  assert.equal(lease.candidate, `sessions/${safeHash("session-test")}`);

  await run.commands["rollback-prune"]!("", run.ctx);
  assert.match(run.notifications.at(-1)!, /reclaimed 0 byte\(s\)/);
  await run.handlers.session_shutdown!({}, run.ctx);
  assert.deepEqual(readdirSync(leaseDir), []);
});

test("lifecycle leases every snapshot store referenced anywhere in the session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-referenced-store-"));
  cleanup.push(cwd);
  const run = harness(cwd);
  const parentStore = join(run.pruneRoot, "sessions", "a".repeat(24));
  const legacyRoot = "/legacy/project";
  run.entries.push({
    id: "parent-root-mutation",
    type: "custom",
    customType: "pi-rollback-mutation",
    parentId: null,
    data: { version: 2, kind: "root", seq: 1, root: "/parent/project", before: "a", after: "b", storeBase: parentStore, source: "bash", createdAt: 0 },
  });
  run.entries.push({
    id: "legacy-root-mutation",
    type: "custom",
    customType: "pi-rollback-mutation",
    parentId: null,
    data: { version: 2, kind: "root", seq: 2, root: legacyRoot, before: "a", after: "b", storeBase: run.pruneRoot, source: "bash", createdAt: 0 },
  });

  await run.handlers.session_start!({}, run.ctx);
  const candidates = readdirSync(join(run.pruneRoot, ".leases"))
    .map((name) => JSON.parse(readFileSync(join(run.pruneRoot, ".leases", name), "utf8")).candidate)
    .sort();
  assert.deepEqual(candidates, [
    safeHash(legacyRoot),
    `sessions/${"a".repeat(24)}`,
    `sessions/${safeHash("session-test")}`,
  ].sort());
});

test("tool calls fail closed when snapshot protection cannot be established", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-protection-failure-"));
  cleanup.push(cwd);
  const run = harness(cwd);
  mkdirSync(join(run.pruneRoot, ".prune-lock"));
  writeFileSync(join(run.pruneRoot, ".prune-lock", "owner.json"), "{}\n");
  await assert.rejects(
    run.handlers.tool_call!({ toolName: "write", input: { path: join(cwd, "demo.txt") } }, run.ctx),
    /refusing snapshot access/,
  );
});

test("capture succeeds even when a stale index.lock exists", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-lock-"));
  const gitDir = snapshotDir(cwd);
  cleanup.push(cwd, gitDir);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "index.lock"), "stale lock\n");
  writeFileSync(join(cwd, "demo.txt"), "hello\n");
  const pi = mockPi();
  const tree = await capture(pi, cwd);
  assert.ok(typeof tree === "string" && tree.length > 0);
  assert.equal(existsSync(join(gitDir, "index.lock")), false);
});

test("concurrent capture calls on the same storeBase serialize cleanly", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-concurrent-"));
  const gitDir = snapshotDir(cwd);
  cleanup.push(cwd, gitDir);
  writeFileSync(join(cwd, "demo.txt"), "hello\n");
  const pi = mockPi();
  const [tree1, tree2] = await Promise.all([
    capture(pi, cwd),
    capture(pi, cwd),
  ]);
  assert.equal(tree1, tree2);
  assert.ok(tree1.length > 0);
});

test("restoreFileState refuses to recursively delete a directory for missing state", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-rollback-missing-dir-"));
  const dir = join(base, "untracked-dir");
  mkdirSync(dir);
  writeFileSync(join(dir, "critical.txt"), "precious data\n");
  cleanup.push(base);

  assert.throws(() => restoreFileState(dir, { kind: "missing" }), /Refusing to remove directory/);
  assert.equal(readFileSync(join(dir, "critical.txt"), "utf8"), "precious data\n");
});

test("excludeNestedStore excludes parent .rollback-snapshots directory in sandbox mode", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-sandbox-exclude-"));
  cleanup.push(cwd);
  const run = harness(cwd, { sandboxed: true });
  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  const snapshotRoot = join(cwd, ".pi", ".rollback-snapshots");
  const [sessionHash] = readdirSync(snapshotRoot).filter((name) => /^[0-9a-f]{24}$/.test(name));
  assert.ok(sessionHash);
  const sessionDir = join(snapshotRoot, sessionHash);
  const [cwdHash] = readdirSync(sessionDir).filter((name) => /^[0-9a-f]{24}$/.test(name));
  assert.ok(cwdHash);
  const excludePath = join(sessionDir, cwdHash, "info", "exclude");
  assert.ok(existsSync(excludePath));
  const excludeContent = readFileSync(excludePath, "utf8");
  assert.ok(excludeContent.includes("/.pi/.rollback-snapshots/"));
});

test("restoreFileState cleans up temporary file when operation fails", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-rollback-temp-cleanup-"));
  cleanup.push(base);
  const source = join(base, "source.txt");
  writeFileSync(source, "content\n");
  const state = captureFileState(source);

  const targetDir = join(base, "as-file");
  writeFileSync(targetDir, "i-am-a-file\n");
  const invalidPath = join(targetDir, "nested", "file.txt");
  assert.throws(() => restoreFileState(invalidPath, state));

  const files = readdirSync(base);
  assert.equal(files.some((f) => f.includes("pi-rollback")), false);
});

test("rollback accepts multi-word labels through fuzzy resolution", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-multiword-"));
  cleanup.push(cwd, snapshotDir(cwd));
  const file = join(cwd, "demo.txt");
  writeFileSync(file, "original\n");
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.commands.checkpoint!("before the big refactor", run.ctx);
  await run.handlers.tool_call!({ toolName: "write", input: { path: file } }, run.ctx);
  writeFileSync(file, "changed\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);

  await run.commands.rollback!("before the big refactor", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "original\n");
});

test("human run syntax rolls back to the previous agent run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-runsyntax-"));
  cleanup.push(cwd, snapshotDir(cwd));
  const file = join(cwd, "demo.txt");
  writeFileSync(file, "original\n");
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "write", input: { path: file } }, run.ctx);
  writeFileSync(file, "run one\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "write", input: { path: file } }, run.ctx);
  writeFileSync(file, "run two\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);

  await run.commands.rollback!("run 1", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "run one\n");
});

test("destructive shell commands are auto-guarded and revertible by default", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-guard-"));
  cleanup.push(cwd, sessionStore("session-test"), snapshotDir(cwd, sessionStore("session-test")));
  const file = join(cwd, "demo.txt");
  writeFileSync(file, "precious\n");
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "bash", input: { command: "rm -rf demo.txt" } }, run.ctx);
  rmSync(file);
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);

  assert.equal(run.entries.some((entry) => entry.data?.label === "auto-before-destructive-1-0"), true);
  assert.equal(run.entries.some((entry) => entry.data?.kind === "root"), true);
  await run.commands.rollback!("destructive", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "precious\n");
});

test("destructive guard can be disabled via PI_ROLLBACK_GUARD_DESTRUCTIVE", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-guard-off-"));
  cleanup.push(cwd);
  const run = harness(cwd, { guardDestructive: false });

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "bash", input: { command: "rm -rf demo.txt" } }, run.ctx);

  assert.equal(run.entries.some((entry) => entry.data?.label?.toString().startsWith("auto-before-destructive")), false);
});

test("LLM checkpoint tool saves a labeled checkpoint and lists recent ones", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-cptool-"));
  cleanup.push(cwd);
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  const result = await run.toolDefs.checkpoint.execute("tool-1", { label: "before risky step" }, undefined, undefined, run.ctx);

  assert.match(result.content[0].text, /Checkpoint saved: before risky step/);
  assert.match(result.content[0].text, /Restore with: \/rollback/);
  assert.equal(run.entries.some((entry) => entry.data?.label === "before risky step"), true);
});

test("destructive guard checkpoint does not revert earlier same-turn file writes", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-guard-seq-"));
  cleanup.push(cwd, sessionStore("session-test"), snapshotDir(cwd, sessionStore("session-test")));
  const file = join(cwd, "demo.txt");
  writeFileSync(file, "original\n");
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "write", input: { path: file } }, run.ctx);
  writeFileSync(file, "kept write\n");
  await run.handlers.tool_call!({ toolName: "bash", input: { command: "rm -rf other.txt" } }, run.ctx);
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);

  await run.commands.rollback!("destructive", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "kept write\n");
});

test("checkpoints listing shows friendly restore hints", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-listing-"));
  cleanup.push(cwd);
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.commands.checkpoint!("before refactor", run.ctx);
  await run.commands.checkpoints!("", run.ctx);

  const text = run.notifications.join("\n");
  assert.match(text, /Rollback checkpoints \(oldest → newest\)/);
  assert.match(text, /run 1 turn 0 start · auto/);
  assert.match(text, /before refactor/);
  assert.match(text, /\(\/rollback \d+( · \/rollback run \d+)?\)/);
  assert.match(text, /Restore with: \/rollback <label> · \/rollback <n> · \/rollback run <n> · \/redo/);
});

test("checkpoints listing can expand and filter beyond the default window", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-window-"));
  cleanup.push(cwd);
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  for (let turn = 0; turn < 13; turn += 1) {
    await run.handlers.turn_start!({ turnIndex: turn }, run.ctx);
    await run.handlers.turn_end!({ turnIndex: turn }, run.ctx);
  }
  await run.commands.checkpoint!("before the big refactor", run.ctx);
  for (let turn = 13; turn < 15; turn += 1) {
    await run.handlers.turn_start!({ turnIndex: turn }, run.ctx);
    await run.handlers.turn_end!({ turnIndex: turn }, run.ctx);
  }

  run.notifications.length = 0;
  await run.commands.checkpoints!("", run.ctx);
  const defaultView = run.notifications.at(-1)!;
  assert.match(defaultView, /older hidden/);

  run.notifications.length = 0;
  await run.commands.checkpoints!("all", run.ctx);
  const allView = run.notifications.at(-1)!;
  assert.doesNotMatch(allView, /older hidden/);
  assert.match(allView, /run 1 turn 0 start/);

  run.notifications.length = 0;
  await run.commands.checkpoints!("60", run.ctx);
  const wideView = run.notifications.at(-1)!;
  assert.doesNotMatch(wideView, /older hidden/);

  run.notifications.length = 0;
  await run.commands.checkpoints!("big refactor", run.ctx);
  const filteredView = run.notifications.at(-1)!;
  assert.match(filteredView, /matching "big refactor"/);
  assert.match(filteredView, /before the big refactor/);
  assert.doesNotMatch(filteredView, /run 1 turn 0 start/);

  run.notifications.length = 0;
  await run.commands.checkpoints!("no-such-label", run.ctx);
  assert.match(run.notifications.at(-1)!, /No rollback checkpoints matching/);
});
