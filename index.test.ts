import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import rollbackExtension, { capture, parseRollbackArgs, restore, ROLLBACK_RESULT_EVENT, sessionStore, snapshotDir } from "./index.js";
import { bashPathHints, isHcomSandbox, mutationPaths } from "./journal.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});
test("parses human-friendly rollback commands and retains JSON compatibility", () => {
  assert.deepEqual(parseRollbackArgs("before-refactor"), { targetLabel: "before-refactor" });
  assert.deepEqual(parseRollbackArgs("before-refactor -- Try the smaller fix."), {
    targetLabel: "before-refactor",
    continuePrompt: "Try the smaller fix.",
  });
  assert.deepEqual(parseRollbackArgs("entry:message-42"), { targetEntryId: "message-42" });
  assert.deepEqual(parseRollbackArgs("2 -- Retry carefully."), { count: 2, continuePrompt: "Retry carefully." });
  assert.deepEqual(parseRollbackArgs('{"runCount":1,"requestId":"remote"}'), { runCount: 1, requestId: "remote" });
  assert.throws(() => parseRollbackArgs("before-refactor --"), /Missing continuation prompt/);
  assert.throws(() => parseRollbackArgs('{"continuePrompt":1}'), /continuePrompt must be a string/);
  assert.throws(() => parseRollbackArgs('{"count":0}'), /count must be a positive integer/);
  assert.throws(() => parseRollbackArgs('{"typo":1}'), /Unknown rollback option/);
});

function exec(command: string, args: string[], options?: { cwd?: string }) {
  const process = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
  return Promise.resolve({ stdout: process.stdout, stderr: process.stderr, code: process.status ?? 1, killed: false });
}

function mockPi(): ExtensionAPI {
  return { exec } as ExtensionAPI;
}

function harness(cwd: string, options: { sandboxed?: boolean; sendUserMessageError?: Error } = {}) {
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
  if (options.sandboxed) process.env.HCOM_WORKER_SANDBOX = "workspace";
  else delete process.env.HCOM_WORKER_SANDBOX;
  delete process.env.HCOM_WORKER_SANDBOX_ROOT;
  try {
    rollbackExtension(pi);
  } finally {
    if (oldMode === undefined) delete process.env.HCOM_WORKER_SANDBOX; else process.env.HCOM_WORKER_SANDBOX = oldMode;
    if (oldRoot === undefined) delete process.env.HCOM_WORKER_SANDBOX_ROOT; else process.env.HCOM_WORKER_SANDBOX_ROOT = oldRoot;
  }
  return { handlers, commands, tools, toolDefs, entries, ctx, notifications, sentMessages, emitted, navigatedTo: () => navigatedTo, activeEntries: branch };
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
  const run = harness(cwd);

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
  const run = harness(cwd);

  await run.handlers.agent_start!({}, run.ctx);
  await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
  await run.handlers.tool_call!({ toolName: "bash", input: { command: `cd ${external} && printf changed > demo.txt` } }, run.ctx);
  writeFileSync(file, "bash changed\n");
  await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);

  await run.commands.rollback!("1", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "bash original\n");
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
  assert.ok(bashPathHints('printf changed > "/outside root/demo.txt"', "/work").includes("/outside root/demo.txt"));
  const windowsPath = win32.normalize("C:\\outside root\\demo.txt");
  assert.ok(bashPathHints('Set-Content -Path "C:\\outside root\\demo.txt" -Value changed', "/work").includes(windowsPath));
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
});

test("registers mutation hooks and commands", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-register-"));
  cleanup.push(cwd);
  const run = harness(cwd);
  assert.deepEqual(Object.keys(run.handlers), ["tool_call", "agent_start", "turn_start", "turn_end", "agent_settled"]);
  assert.deepEqual(Object.keys(run.commands), ["checkpoint", "checkpoints", "rollback", "redo"]);
  assert.deepEqual(run.tools, ["rollback"]);
});
