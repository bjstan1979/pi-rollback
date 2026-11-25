#!/usr/bin/env bun
/*
 * Standalone reproduction of the four confirmed pi-rollback 0.6.2 bugs.
 * Run from the package root:  bun reproduce-bugs.mjs
 *
 * This script does not edit any project file and does not touch a real Pi
 * session: it captures the extension's registered hooks/commands and drives
 * them with a minimal fake ExtensionAPI/ExtensionCommandContext.
 */
import extension, { parseRollbackArgs } from "./index.ts";
import { parsePruneConfig } from "./prune.ts";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECKPOINT_TYPE = "pi-rollback-checkpoint";
const RESULT_TYPE = "pi-rollback-result";
const CONTEXT_MESSAGE_TYPE = "pi-rollback-context";
const REDO_TYPE = "pi-rollback-redo";

let failures = 0;
const pass = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};
const reproduced = (name, ok, detail) =>
  pass(`REPRODUCED ${name}`, ok, detail);

function makeHarness(cwd, opts = {}) {
  const handlers = {};
  const commands = {};
  const entries = [];
  let leaf = null;
  let nextId = 0;
  const sessions = opts.sessions ?? [{ type: "message", message: { role: "user", content: [{ type: "text", text: "work" }] } }];
  for (const session of sessions) {
    const entry = { ...session, id: `e${++nextId}`, timestamp: new Date().toISOString() };
    entries.push(entry);
    leaf = entry.id;
  }
  const branch = () => {
    const out = [];
    let cur = leaf;
    while (cur) {
      const entry = entries.find((item) => item.id === cur);
      if (!entry) break;
      out.unshift(entry);
      cur = entry.parentId;
    }
    return out;
  };
  const ui = {
    notify() {},
    select: opts.select ?? (async () => undefined),
    input() {},
    confirm: opts.confirm ?? (async () => true),
  };
  const ctx = {
    cwd,
    hasUI: true,
    ui,
    sessionManager: {
      getLeafId: () => leaf,
      getSessionId: () => "repro-session",
      getBranch: branch,
      getEntries: () => entries,
    },
    waitForIdle: async () => {},
    navigateTree: async (target) => {
      opts.navTargets?.push(target);
      leaf = target;
      return { cancelled: false };
    },
  };
  const pi = {
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command.handler; },
    registerTool() {},
    appendEntry: (type, data) => {
      const entry = { type: "custom", customType: type, data, id: `e${++nextId}`, parentId: leaf, timestamp: new Date().toISOString() };
      entries.push(entry);
      leaf = entry.id;
      return entry;
    },
    setLabel() {},
    events: { emit() {} },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    sendUserMessage: async () => {},
  };
  extension(pi, {
    normalLayoutRoot: join(cwd, ".rollback-store"),
    pruneEnv: { PI_ROLLBACK_PRUNE: "0" },
    pruneSettingsPath: join(cwd, ".no-settings.json"),
  });
  return { handlers, commands, entries, ctx, ui, getLeaf: () => leaf, setLeaf: (id) => { leaf = id; } };
}

async function startAgent(h) {
  await h.handlers.agent_start({}, h.ctx);
}

async function turnWithWrite(h, file, text, label) {
  await h.handlers.turn_start({ turnIndex: 0 }, h.ctx);
  await h.handlers.tool_call({ toolName: "write", input: { path: file } }, h.ctx);
  writeFileSync(file, text + "\n");
  if (label) await h.commands.checkpoint(label, h.ctx);
  await h.handlers.turn_end({ turnIndex: 0 }, h.ctx);
}

function checkpoints(h, label) {
  return h.entries.filter((e) => e.customType === CHECKPOINT_TYPE && (!label || e.data.label === label));
}

function tmpdirFor(name) {
  const dir = join(tmpdir(), `pi-rollback-repro-${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function bug1DuplicateLabels() {
  console.log("\n=== BUG 1: duplicate-label picker restores the wrong checkpoint ===");
  const dir = tmpdirFor("bug1");
  const file = join(dir, "f.txt");
  writeFileSync(file, "original\n");
  let chosen;
  const navTargets = [];
  const h = makeHarness(dir, {
    navTargets,
    select: async (_title, choices) => {
      console.log("  picker choices:", JSON.stringify(choices));
      chosen = choices.find((c) => c.includes("(#2)"));
      return chosen;
    },
  });
  await startAgent(h);
  await turnWithWrite(h, file, "state-A", "before refactor");
  const older = checkpoints(h, "before refactor")[0];
  await turnWithWrite(h, file, "state-B", "before refactor");
  const newer = checkpoints(h, "before refactor")[1];
  // Make the relative time identical so the picker adds the (#2) suffix.
  older.data.createdAt = newer.data.createdAt;
  writeFileSync(file, "state-C\n");

  await h.commands.rollback("", h.ctx);
  const restored = readFileSync(file, "utf8").trim();
  console.log(`  picked: ${chosen}`);
  console.log(`  nav target: ${navTargets.at(-1)} (older=${older.id}, newer=${newer.id})`);
  console.log(`  file after restore: ${restored} (expected state-A)`);
  reproduced("BUG 1", navTargets.at(-1) === newer.id && restored === "state-B",
    "selecting the older duplicate-label option restored the newer checkpoint");
  rmSync(dir, { recursive: true, force: true });
}

async function bug2ConflictingTargets() {
  console.log("\n=== BUG 2: conflicting targetEntryId + targetLabel is silently accepted ===");
  const dir = tmpdirFor("bug2");
  const file = join(dir, "f.txt");
  writeFileSync(file, "state-A\n");
  const h = makeHarness(dir);
  await startAgent(h);
  await turnWithWrite(h, file, "state-A", "AAA");
  const older = checkpoints(h, "AAA")[0];
  await h.handlers.turn_start({ turnIndex: 1 }, h.ctx);
  await h.handlers.tool_call({ toolName: "write", input: { path: file } }, h.ctx);
  writeFileSync(file, "state-B\n");
  await h.handlers.turn_end({ turnIndex: 1 }, h.ctx);
  writeFileSync(file, "state-C\n");

  // Use the checkpoint's own entryId (the id of the entry that stores the
  // checkpoint), which is what /rollback targetEntryId accepts. The targetLabel
  // names a different checkpoint, so the two selectors genuinely conflict.
  const targetEntryId = h.entries.find((e) => e.customType === CHECKPOINT_TYPE && e.data.label === "rollback-before-1-1")?.id;
  const conflictingLabel = older.data.label;
  const args = parseRollbackArgs(JSON.stringify({ targetEntryId, targetLabel: conflictingLabel }));
  console.log(`  parsed args: ${JSON.stringify(args)}`);
  const results = h.entries.filter((e) => e.customType === RESULT_TYPE);
  const before = results.length;
  await h.commands.rollback(JSON.stringify({ targetEntryId, targetLabel: conflictingLabel }), h.ctx);
  const result = h.entries.filter((e) => e.customType === RESULT_TYPE)[before];
  console.log(`  result: ${JSON.stringify(result?.data)}`);
  const ambiguous = result?.data?.ok === false && /ambiguous/i.test(result?.data?.error ?? "");
  reproduced("BUG 2", !ambiguous && result?.data?.ok === true && result?.data?.targetLabel !== conflictingLabel,
    "conflicting targets should raise 'Rollback target is ambiguous', but rollback succeeded using entryId and ignored the label");
  if (result?.data?.targetLabel !== conflictingLabel) {
    console.log(`  ignored label: ${conflictingLabel}; reported label: ${result?.data?.targetLabel}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function contextNote(h) {
  const event = { messages: [] };
  const result = h.handlers.context(event, h.ctx);
  const note = result?.messages?.find((m) => m.customType === CONTEXT_MESSAGE_TYPE)?.content;
  return note;
}

async function bug3StaleNoteAfterRedo() {
  console.log("\n=== BUG 3: stale rollback note replayed after /redo ===");
  const dir = tmpdirFor("bug3");
  const file = join(dir, "f.txt");
  writeFileSync(file, "initial\n");
  const h = makeHarness(dir);
  await startAgent(h);
  await turnWithWrite(h, file, "initial", "before 1");
  // Rollback #1 (no-op) from a checkpoint.
  await h.commands.rollback("before 1", h.ctx);
  console.log("  note after rollback #1:", JSON.stringify(contextNote(h)));
  // Advance the branch and roll back a second time.
  await turnWithWrite(h, file, "changed", "before 2");
  await h.commands.rollback("before 2", h.ctx);
  console.log("  note after rollback #2:", JSON.stringify(contextNote(h)));
  // Redo returns to the pre-second-rollback branch, which still holds result #1.
  await h.commands.redo("", h.ctx);
  const note = contextNote(h);
  console.log("  note after /redo:", JSON.stringify(note));
  reproduced("BUG 3", !!note && /Rollback ok/.test(note) && /before 1/.test(note),
    "/redo replayed the first rollback's outcome as a new result note");
  rmSync(dir, { recursive: true, force: true });
}

function bug4PruneToggleStrings() {
  console.log("\n=== BUG 4: documented PI_ROLLBACK_PRUNE=true string is rejected ===");
  const asTrue = parsePruneConfig({ PI_ROLLBACK_PRUNE: "true" });
  const asOne = parsePruneConfig({ PI_ROLLBACK_PRUNE: "1" });
  const asFalse = parsePruneConfig({ PI_ROLLBACK_PRUNE: "false" });
  const asBool = parsePruneConfig({ PI_ROLLBACK_PRUNE: true });
  console.log(`  env "true":  enabled=${asTrue.enabled}, warning=${asTrue.warning ?? "none"}`);
  console.log(`  env "1":     enabled=${asOne.enabled}, warning=${asOne.warning ?? "none"}`);
  console.log(`  env "false": enabled=${asFalse.enabled}, warning=${asFalse.warning ?? "none"}`);
  console.log(`  boolean true: enabled=${asBool.enabled}`);
  reproduced("BUG 4", asTrue.enabled !== true && !!asTrue.warning && asOne.enabled === true && asBool.enabled === true,
    "README allows 'true'/'false', but only '1'/'0' and real booleans work");
}

await bug1DuplicateLabels();
await bug2ConflictingTargets();
await bug3StaleNoteAfterRedo();
bug4PruneToggleStrings();

console.log(`\n${failures === 0 ? "All four bugs reproduced." : `${failures} reproduction(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
