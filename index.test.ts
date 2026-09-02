import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import rollbackExtension, { capture, restore, ROLLBACK_RESULT_EVENT, snapshotDir } from "./index.js";
import { isHcomSandbox, mutationPaths } from "./journal.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function exec(command: string, args: string[], options?: { cwd?: string }) {
  const process = spawnSync(command, args, { cwd: options?.cwd, encoding: "utf8" });
  return Promise.resolve({ stdout: process.stdout, stderr: process.stderr, code: process.status ?? 1, killed: false });
}

function mockPi(): ExtensionAPI {
  return { exec } as ExtensionAPI;
}

function harness(cwd: string) {
  const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
  const commands: Record<string, (args: string, ctx: any) => Promise<void>> = {};
  const tools: string[] = [];
  const toolDefs: Record<string, any> = {};
  const entries: any[] = [{ id: "message-0", type: "message" }];
  let leaf = "message-0";
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
      const entry = { id: `custom-${++next}`, type: "custom", customType, data };
      entries.push(entry);
      leaf = entry.id;
    },
    async sendUserMessage(content: string, options: unknown) { sentMessages.push({ content, options }); },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    ui: { notify(message: string) { notifications.push(message); } },
    sessionManager: {
      getLeafId: () => leaf,
      getSessionId: () => "session-test",
      getBranch: () => entries,
      getEntries: () => entries,
    },
    async waitForIdle() {},
    async navigateTree(target: string) { navigatedTo = target; return { cancelled: false }; },
  };
  rollbackExtension(pi);
  return { handlers, commands, tools, toolDefs, entries, ctx, notifications, sentMessages, emitted, navigatedTo: () => navigatedTo };
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

test("normal mode journals writes outside cwd and rolls them back", async () => {
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

  await run.commands.rollback!("1", run.ctx);
  assert.equal(readFileSync(file, "utf8"), "original\n");
  assert.equal(run.navigatedTo(), "message-0");
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
  const oldMode = process.env.HCOM_WORKER_SANDBOX;
  const oldRoot = process.env.HCOM_WORKER_SANDBOX_ROOT;
  process.env.HCOM_WORKER_SANDBOX = "workspace";
  delete process.env.HCOM_WORKER_SANDBOX_ROOT;
  try {
    const cwd = mkdtempSync(join(tmpdir(), "pi-rollback-sandbox-"));
    cleanup.push(cwd);
    const file = join(cwd, "demo.txt");
    writeFileSync(file, "sandbox original\n");
    const run = harness(cwd);

    await run.handlers.agent_start!({}, run.ctx);
    await run.handlers.turn_start!({ turnIndex: 0 }, run.ctx);
    writeFileSync(file, "sandbox changed\n");
    await run.handlers.turn_end!({ turnIndex: 0 }, run.ctx);
    assert.equal(existsSync(join(cwd, ".pi", ".rollback-snapshots")), true);

    await run.commands.rollback!("1", run.ctx);
    assert.equal(readFileSync(file, "utf8"), "sandbox original\n");
  } finally {
    if (oldMode === undefined) delete process.env.HCOM_WORKER_SANDBOX; else process.env.HCOM_WORKER_SANDBOX = oldMode;
    if (oldRoot === undefined) delete process.env.HCOM_WORKER_SANDBOX_ROOT; else process.env.HCOM_WORKER_SANDBOX_ROOT = oldRoot;
  }
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
  assert.deepEqual(Object.keys(run.commands), ["checkpoint", "checkpoints", "rollback"]);
  assert.deepEqual(run.tools, ["rollback"]);
});
