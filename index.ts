import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  bashPathHints,
  canonicalMutationPath,
  captureFileState,
  type FileState,
  isHcomSandbox,
  isWithin,
  mutationPaths,
  restoreFileState,
  sameFileState,
} from "./journal.js";

const CHECKPOINT_TYPE = "pi-rollback-checkpoint";
const MUTATION_TYPE = "pi-rollback-mutation";
const RESULT_TYPE = "pi-rollback-result";
const REDO_TYPE = "pi-rollback-redo";
export const ROLLBACK_RESULT_EVENT = "pi-rollback:result";
const SNAPSHOT_ROOT = join(homedir(), ".pi", "agent", "rollback-snapshots");
const VERSION = 2;

type RootState = { root: string; tree: string; storeBase: string };
type Mutation = FileMutation | RootMutation;

interface Checkpoint {
  version: typeof VERSION;
  entryId: string;
  seq: number;
  label: string;
  createdAt: number;
  mode: "normal" | "sandbox";
  sandbox?: RootState;
}

interface FileMutation {
  version: typeof VERSION;
  kind: "file";
  seq: number;
  path: string;
  before: FileState;
  after: FileState;
  source: "tool" | "external";
  createdAt: number;
}

interface RootMutation {
  version: typeof VERSION;
  kind: "root";
  seq: number;
  root: string;
  before: string;
  after: string;
  storeBase: string;
  source: "bash" | "external";
  createdAt: number;
}

export interface RollbackArgs {
  targetLabel?: string;
  targetEntryId?: string;
  count?: number;
  runCount?: number;
  requestId?: string;
  continuePrompt?: string;
  summarize?: boolean;
}

export interface RollbackResult {
  version: 1;
  requestId?: string;
  ok: boolean;
  targetEntryId?: string;
  targetLabel?: string;
  files?: number;
  error?: string;
  createdAt: number;
}

interface RedoRecord {
  version: 1;
  sourceEntryId: string;
  targetEntryId: string;
  targetLabel: string;
  mode: "normal" | "sandbox";
  mutations?: Mutation[];
  fileGuards?: Array<{ path: string; state: FileState }>;
  rootGuards?: RootState[];
  sandbox?: { root: string; rollbackTree: string; redoTree: string; storeBase: string };
  createdAt: number;
}

interface ActiveRedo {
  entryId: string;
  data: RedoRecord;
}

interface SessionEntry {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
}

type CheckpointContext = Pick<ExtensionCommandContext, "sessionManager" | "cwd" | "hasUI" | "ui">;
type PendingFile = { path: string; before: FileState };
type PendingRoot = { root: string; before: string; storeBase: string };

function safeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function snapshotDir(cwd: string, storeBase = SNAPSHOT_ROOT): string {
  return join(storeBase, safeHash(cwd));
}
export function sessionStore(sessionId: string): string {
  return join(SNAPSHOT_ROOT, "sessions", safeHash(sessionId));
}

function sandboxStore(cwd: string, sessionId: string): string {
  return join(cwd, ".pi", ".rollback-snapshots", safeHash(sessionId));
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd, timeout: 30_000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function excludeNestedStore(root: string, gitDir: string): void {
  const exclusions: string[] = [];
  for (const candidate of [gitDir, SNAPSHOT_ROOT]) {
    const scoped = relative(root, candidate);
    if (scoped && !scoped.startsWith("..") && !isAbsolute(scoped)) exclusions.push(`/${scoped.replaceAll("\\", "/")}/`);
  }
  if (!exclusions.length) return;
  mkdirSync(join(gitDir, "info"), { recursive: true, mode: 0o700 });
  writeFileSync(join(gitDir, "info", "exclude"), `${exclusions.join("\n")}\n`, { mode: 0o600 });
}

async function stageSnapshot(pi: ExtensionAPI, cwd: string, gitDir: string): Promise<void> {
  await git(pi, cwd, ["--git-dir", gitDir, "read-tree", "--empty"]);
  const result = await pi.exec("git", ["--git-dir", gitDir, "--work-tree", cwd, "add", "--all", "--ignore-errors", "--", "."], { cwd, timeout: 30_000 });
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr.trim() || "git add failed");
}

export async function capture(pi: ExtensionAPI, cwd: string, storeBase = SNAPSHOT_ROOT): Promise<string> {
  const gitDir = snapshotDir(cwd, storeBase);
  if (!existsSync(gitDir)) {
    mkdirSync(gitDir, { recursive: true, mode: 0o700 });
    await git(pi, cwd, ["--git-dir", gitDir, "--work-tree", cwd, "init"]);
  }
  excludeNestedStore(cwd, gitDir);
  // ponytail: root snapshots include every non-ignored file; native file tools use the cheaper journal path.
  await stageSnapshot(pi, cwd, gitDir);
  const tree = await git(pi, cwd, ["--git-dir", gitDir, "write-tree"]);
  await git(pi, cwd, ["--git-dir", gitDir, "update-ref", `refs/pi-rollback/trees/${tree}`, tree]);
  return tree;
}

async function changedPaths(pi: ExtensionAPI, cwd: string, from: string, to: string, storeBase: string): Promise<string[]> {
  const gitDir = snapshotDir(cwd, storeBase);
  const output = await git(pi, cwd, ["--git-dir", gitDir, "diff", "--name-only", "-z", "--no-renames", from, to, "--", "."]);
  return output.split("\0").filter(Boolean);
}
async function treeHasPath(pi: ExtensionAPI, cwd: string, tree: string, path: string, storeBase: string): Promise<boolean> {
  const gitDir = snapshotDir(cwd, storeBase);
  const output = await git(pi, cwd, ["--git-dir", gitDir, "ls-tree", "-r", "-z", "--name-only", tree, "--", path]);
  return output.split("\0").some((entry) => entry === path || entry.startsWith(`${path}/`));
}

async function restoreTree(pi: ExtensionAPI, cwd: string, target: string, from: string, storeBase: string): Promise<number> {
  const paths = await changedPaths(pi, cwd, target, from, storeBase);
  const gitDir = snapshotDir(cwd, storeBase);
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    const scoped = relative(cwd, absolute);
    if (scoped.startsWith("..") || isAbsolute(scoped)) throw new Error(`Snapshot path escapes workspace: ${path}`);
    if (await treeHasPath(pi, cwd, target, path, storeBase)) {
      await git(pi, cwd, ["--git-dir", gitDir, "--work-tree", cwd, "checkout", target, "--", path]);
    } else {
      rmSync(absolute, { recursive: true, force: true });
    }
  }
  await git(pi, cwd, ["--git-dir", gitDir, "read-tree", target]);
  return paths.length;
}

export async function restore(
  pi: ExtensionAPI,
  cwd: string,
  target: string,
  storeBase = SNAPSHOT_ROOT,
): Promise<{ files: number; before: string }> {
  const current = await capture(pi, cwd, storeBase);
  try {
    return { files: await restoreTree(pi, cwd, target, current, storeBase), before: current };
  } catch (restoreError) {
    try {
      await restoreTree(pi, cwd, current, target, storeBase);
    } catch (recoveryError) {
      throw new AggregateError([restoreError, recoveryError], "Rollback failed and the original workspace state could not be restored");
    }
    throw restoreError;
  }
}

function activeEntries(ctx: CheckpointContext): SessionEntry[] {
  return ctx.sessionManager.getBranch() as SessionEntry[];
}

function dataEntries<T>(ctx: CheckpointContext, customType: string): T[] {
  return activeEntries(ctx)
    .filter((entry) => entry.type === "custom" && entry.customType === customType)
    .map((entry) => entry.data as T);
}

function mutations(ctx: CheckpointContext): Mutation[] {
  return dataEntries<Mutation>(ctx, MUTATION_TYPE)
    .filter((item) => item?.version === VERSION && (item.kind === "file" || item.kind === "root"))
    .sort((a, b) => a.seq - b.seq);
}

function checkpoints(ctx: CheckpointContext): Checkpoint[] {
  return dataEntries<Checkpoint>(ctx, CHECKPOINT_TYPE)
    .filter((item) => item?.version === VERSION)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function activeRedo(ctx: CheckpointContext): ActiveRedo | undefined {
  const entry = activeEntries(ctx).findLast((item) =>
    item.type === "custom"
    && item.customType === REDO_TYPE
    && (item.data as RedoRecord | undefined)?.version === 1
  );
  return entry ? { entryId: entry.id, data: entry.data as RedoRecord } : undefined;
}

function currentSeq(ctx: CheckpointContext): number {
  return mutations(ctx).reduce((max, item) => Math.max(max, item.seq), 0);
}

function appendMutation(pi: ExtensionAPI, ctx: CheckpointContext, mutation: Omit<FileMutation, "version" | "seq" | "createdAt"> | Omit<RootMutation, "version" | "seq" | "createdAt">): Mutation {
  const entry = { ...mutation, version: VERSION, seq: currentSeq(ctx) + 1, createdAt: Date.now() } as Mutation;
  pi.appendEntry(MUTATION_TYPE, entry);
  return entry;
}

function notify(ctx: CheckpointContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
}

async function saveCheckpoint(pi: ExtensionAPI, ctx: CheckpointContext, label: string, sandboxed: boolean): Promise<Checkpoint | undefined> {
  const entryId = ctx.sessionManager.getLeafId();
  if (!entryId) return undefined;
  const checkpoint: Checkpoint = {
    version: VERSION,
    entryId,
    seq: currentSeq(ctx),
    label,
    createdAt: Date.now(),
    mode: sandboxed ? "sandbox" : "normal",
  };
  if (sandboxed) {
    const storeBase = sandboxStore(ctx.cwd, ctx.sessionManager.getSessionId());
    const tree = await capture(pi, ctx.cwd, storeBase);
    checkpoint.sandbox = { root: ctx.cwd, tree, storeBase };
  }
  pi.setLabel(entryId, label);
  pi.appendEntry(CHECKPOINT_TYPE, checkpoint);
  return checkpoint;
}

function humanTarget(value: string): Pick<RollbackArgs, "count" | "targetEntryId" | "targetLabel"> {
  if (/^\d+$/.test(value)) return { count: Number(value) };
  if (value.startsWith("entry:")) {
    const targetEntryId = value.slice("entry:".length).trim();
    if (!targetEntryId) throw new Error("Missing entry id after entry:");
    return { targetEntryId };
  }
  const targetLabel = value.startsWith("label:") ? value.slice("label:".length).trim() : value;
  if (!targetLabel) throw new Error("Missing rollback target");
  if (/\s/.test(targetLabel)) throw new Error("Checkpoint labels cannot contain spaces; use the label shown by /checkpoints");
  return { targetLabel };
}
function jsonRollbackArgs(value: unknown): RollbackArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rollback JSON must be an object");
  const args = value as Record<string, unknown>;
  const allowed = new Set(["targetLabel", "targetEntryId", "count", "runCount", "requestId", "continuePrompt", "summarize"]);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`Unknown rollback option: ${key}`);
  for (const key of ["targetLabel", "targetEntryId", "requestId", "continuePrompt"]) {
    if (args[key] !== undefined && typeof args[key] !== "string") throw new Error(`Rollback ${key} must be a string`);
  }
  for (const key of ["count", "runCount"]) {
    if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || (args[key] as number) < 1)) {
      throw new Error(`Rollback ${key} must be a positive integer`);
    }
  }
  if (args.summarize !== undefined && typeof args.summarize !== "boolean") throw new Error("Rollback summarize must be a boolean");
  return args as RollbackArgs;
}

export function parseRollbackArgs(raw: string): RollbackArgs {
  const input = raw.trim();
  if (!input) return { count: 1 };
  if (input.startsWith("{")) return jsonRollbackArgs(JSON.parse(input));
  const delimiter = input.match(/\s+--(?:\s+|$)/);
  if (!delimiter || delimiter.index === undefined) return humanTarget(input);
  const target = input.slice(0, delimiter.index).trim();
  const continuePrompt = input.slice(delimiter.index + delimiter[0].length).trim();
  if (!continuePrompt) throw new Error("Missing continuation prompt after --");
  return { ...humanTarget(target), continuePrompt };
}

function findCheckpoint(ctx: CheckpointContext, args: RollbackArgs): Checkpoint {
  const all = checkpoints(ctx);
  if ((args.targetEntryId || args.targetLabel) && (args.count !== undefined || args.runCount !== undefined)) {
    throw new Error("Rollback target is ambiguous");
  }
  if (args.count !== undefined && args.runCount !== undefined) throw new Error("Rollback target is ambiguous");
  if (args.targetEntryId) {
    const found = all.findLast((checkpoint) => checkpoint.entryId === args.targetEntryId);
    if (found) return found;
    throw new Error(`No active checkpoint for entry ${args.targetEntryId}`);
  }
  if (args.targetLabel) {
    const found = all.findLast((checkpoint) => checkpoint.label === args.targetLabel);
    if (found) return found;
    throw new Error(`No active checkpoint labelled ${args.targetLabel}`);
  }
  if (args.runCount !== undefined) {
    const starts = all.filter((checkpoint) => /^rollback-before-\d+-0$/.test(checkpoint.label));
    const target = starts.length - args.runCount;
    if (!Number.isInteger(args.runCount) || args.runCount < 1 || target < 0) {
      throw new Error(`Can roll back at most ${starts.length} agent run(s)`);
    }
    return starts[target]!;
  }
  const count = args.count ?? 1;
  const target = all.length - 1 - count;
  if (!Number.isInteger(count) || count < 1 || target < 0) throw new Error(`Can roll back at most ${Math.max(0, all.length - 1)} checkpoint(s)`);
  return all[target]!;
}

function rootDirectory(path: string): string {
  if (existsSync(path) && statSync(path).isDirectory()) return path;
  return dirname(path);
}

async function projectRoot(pi: ExtensionAPI, path: string): Promise<string> {
  const directory = rootDirectory(path);
  const result = await pi.exec("git", ["-C", directory, "rev-parse", "--show-toplevel"], { cwd: directory, timeout: 5_000 });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : directory;
}

function addRoot(roots: Set<string>, root: string): void {
  const absolute = resolve(root);
  for (const existing of roots) if (isWithin(existing, absolute)) return;
  for (const existing of [...roots]) if (isWithin(absolute, existing)) roots.delete(existing);
  roots.add(absolute);
}

async function applyMutation(pi: ExtensionAPI, mutation: Mutation, side: "before" | "after", sandboxed: boolean, cwd: string): Promise<number> {
  if (mutation.kind === "file") {
    if (sandboxed && !isWithin(cwd, mutation.path)) throw new Error(`Sandbox rollback refused external path: ${mutation.path}`);
    restoreFileState(mutation.path, mutation[side]);
    return 1;
  }
  if (sandboxed && resolve(mutation.root) !== resolve(cwd)) throw new Error(`Sandbox rollback refused external root: ${mutation.root}`);
  return (await restore(pi, mutation.root, mutation[side], mutation.storeBase)).files;
}

async function captureRedoGuards(pi: ExtensionAPI, selected: Mutation[]): Promise<Pick<RedoRecord, "fileGuards" | "rootGuards">> {
  const files = new Map<string, FileState>();
  const roots = new Map<string, RootState>();
  for (const mutation of selected) {
    if (mutation.kind === "file") files.set(mutation.path, captureFileState(mutation.path));
    else roots.set(mutation.root, { root: mutation.root, tree: await capture(pi, mutation.root, mutation.storeBase), storeBase: mutation.storeBase });
  }
  return {
    fileGuards: [...files].map(([path, state]) => ({ path, state })),
    rootGuards: [...roots.values()],
  };
}

async function assertRedoGuards(pi: ExtensionAPI, redo: RedoRecord): Promise<void> {
  for (const guard of redo.fileGuards ?? []) {
    if (!sameFileState(captureFileState(guard.path), guard.state)) throw new Error(`Redo unavailable because ${guard.path} changed after rollback`);
  }
  for (const guard of redo.rootGuards ?? []) {
    if (await capture(pi, guard.root, guard.storeBase) !== guard.tree) throw new Error(`Redo unavailable because ${guard.root} changed after rollback`);
  }
}

export default function rollbackExtension(pi: ExtensionAPI): void {
  const sandboxed = isHcomSandbox();
  const deepTracking = process.env.PI_ROLLBACK_DEEP_TRACKING === "1";
  let agentRun = 0;
  const pendingFiles = new Map<string, PendingFile>();
  const pendingRoots = new Map<string, PendingRoot>();

  const flushPending = async (ctx: CheckpointContext): Promise<void> => {
    for (const item of pendingFiles.values()) {
      try {
        const after = captureFileState(item.path);
        if (!sameFileState(item.before, after)) appendMutation(pi, ctx, { kind: "file", path: item.path, before: item.before, after, source: "tool" });
      } catch (error) {
        notify(ctx, `Rollback could not record ${item.path}: ${String(error)}`);
      }
    }
    pendingFiles.clear();
    for (const item of pendingRoots.values()) {
      try {
        const after = await capture(pi, item.root, item.storeBase);
        if (item.before !== after) appendMutation(pi, ctx, { kind: "root", root: item.root, before: item.before, after, storeBase: item.storeBase, source: "bash" });
      } catch (error) {
        notify(ctx, `Rollback could not record bash root ${item.root}: ${String(error)}`);
      }
    }
    pendingRoots.clear();
  };

  const captureExternalChanges = async (ctx: CheckpointContext): Promise<void> => {
    if (sandboxed) return;
    const latestFiles = new Map<string, FileState>();
    for (const item of mutations(ctx)) {
      if (item.kind === "file") latestFiles.set(item.path, item.after);
    }
    for (const [path, before] of latestFiles) {
      try {
        const after = captureFileState(path);
        if (!sameFileState(before, after)) appendMutation(pi, ctx, { kind: "file", path, before, after, source: "external" });
      } catch (error) {
        notify(ctx, `Rollback could not inspect ${path}: ${String(error)}`);
      }
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    if (sandboxed) return;
    try {
      for (const path of mutationPaths(event.toolName, event.input, ctx.cwd, false)) {
        if (!pendingFiles.has(path)) pendingFiles.set(path, { path, before: captureFileState(path) });
      }
      if ((event.toolName !== "bash" && event.toolName !== "powershell") || !deepTracking) return;
      const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
      const command = typeof input.command === "string" ? input.command : "";
      const roots = new Set<string>();
      addRoot(roots, ctx.cwd);
      for (const hint of bashPathHints(command, ctx.cwd)) addRoot(roots, await projectRoot(pi, canonicalMutationPath(hint, ctx.cwd)));
      for (const root of roots) {
        if (pendingRoots.has(root)) continue;
        const storeBase = sessionStore(ctx.sessionManager.getSessionId());
        pendingRoots.set(root, { root, before: await capture(pi, root, storeBase), storeBase });
      }
    } catch (error) {
      notify(ctx, `Rollback preflight skipped: ${String(error)}`);
    }
  });

  pi.on("agent_start", async () => {
    agentRun += 1;
  });

  pi.on("turn_start", async (event, ctx) => {
    try {
      await flushPending(ctx);
      if (deepTracking) await captureExternalChanges(ctx);
      await saveCheckpoint(pi, ctx, `rollback-before-${agentRun}-${event.turnIndex}`, sandboxed);
    } catch (error) {
      notify(ctx, `Rollback checkpoint skipped: ${String(error)}`);
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      await flushPending(ctx);
      await saveCheckpoint(pi, ctx, `rollback-after-${agentRun}-${event.turnIndex}`, sandboxed);
    } catch (error) {
      notify(ctx, `Rollback checkpoint skipped: ${String(error)}`);
    }
  });

  const publishRollbackResult = (result: Omit<RollbackResult, "version" | "createdAt">): RollbackResult => {
    const published: RollbackResult = { ...result, version: 1, createdAt: Date.now() };
    pi.appendEntry(RESULT_TYPE, published);
    pi.events.emit(ROLLBACK_RESULT_EVENT, published);
    return published;
  };

  const runRollback = async (args: RollbackArgs, ctx: ExtensionCommandContext): Promise<void> => {
    let target: Checkpoint | undefined;
    try {
      if (args.requestId !== undefined && (!args.requestId.trim() || Buffer.byteLength(args.requestId, "utf8") > 128)) {
        throw new Error("Rollback requestId must be 1-128 bytes");
      }
      await ctx.waitForIdle();
      await flushPending(ctx);
      await captureExternalChanges(ctx);
      target = findCheckpoint(ctx, args);
      const sourceEntryId = ctx.sessionManager.getLeafId();
      if (!sourceEntryId) throw new Error("No active session entry to redo");
      let files = 0;
      let sandboxBefore: string | undefined;
      let redo: RedoRecord;
      const reverted: Mutation[] = [];
      const selected = mutations(ctx).filter((item) => item.seq > target!.seq).sort((a, b) => b.seq - a.seq);
      if (sandboxed && target.mode !== "sandbox") throw new Error("Sandbox rollback refuses checkpoints created outside sandbox mode");

      if (target.mode === "sandbox") {
        if (!sandboxed || !target.sandbox) throw new Error("Sandbox checkpoint can only be restored inside its sandbox workspace");
        if (resolve(target.sandbox.root) !== resolve(ctx.cwd)) throw new Error("Sandbox checkpoint belongs to another workspace");
        const restored = await restore(pi, target.sandbox.root, target.sandbox.tree, target.sandbox.storeBase);
        files += restored.files;
        sandboxBefore = restored.before;
        redo = {
          version: 1,
          sourceEntryId,
          targetEntryId: target.entryId,
          targetLabel: target.label,
          mode: "sandbox",
          sandbox: { root: target.sandbox.root, rollbackTree: target.sandbox.tree, redoTree: restored.before, storeBase: target.sandbox.storeBase },
          createdAt: Date.now(),
        };
      } else {
        try {
          for (const mutation of selected) {
            files += await applyMutation(pi, mutation, "before", sandboxed, ctx.cwd);
            reverted.push(mutation);
          }
          redo = {
            version: 1,
            sourceEntryId,
            targetEntryId: target.entryId,
            targetLabel: target.label,
            mode: "normal",
            mutations: [...selected].reverse(),
            ...await captureRedoGuards(pi, selected),
            createdAt: Date.now(),
          };
        } catch (error) {
          for (const mutation of [...reverted].reverse()) await applyMutation(pi, mutation, "after", sandboxed, ctx.cwd);
          throw error;
        }
      }

      let result;
      try {
        result = await ctx.navigateTree(target.entryId, {
          summarize: args.summarize !== false,
          customInstructions: "Keep only validated findings from the abandoned rollback branch.",
          label: `rollback-${target.label}`,
        });
      } catch (error) {
        if (sandboxBefore && target.sandbox) await restore(pi, target.sandbox.root, sandboxBefore, target.sandbox.storeBase);
        for (const mutation of [...reverted].reverse()) await applyMutation(pi, mutation, "after", sandboxed, ctx.cwd);
        throw error;
      }
      if (result.cancelled) {
        if (sandboxBefore && target.sandbox) await restore(pi, target.sandbox.root, sandboxBefore, target.sandbox.storeBase);
        for (const mutation of [...reverted].reverse()) await applyMutation(pi, mutation, "after", sandboxed, ctx.cwd);
        publishRollbackResult({
          requestId: args.requestId,
          ok: false,
          targetEntryId: target.entryId,
          targetLabel: target.label,
          error: "Rollback cancelled",
        });
        return;
      }
      publishRollbackResult({
        requestId: args.requestId,
        ok: true,
        targetEntryId: target.entryId,
        targetLabel: target.label,
        files,
      });
      try {
        pi.appendEntry(REDO_TYPE, redo);
      } catch (error) {
        notify(ctx, `Rollback succeeded, but redo could not be recorded: ${String(error)}`);
      }
      if (args.continuePrompt?.trim()) {
        try {
          await pi.sendUserMessage(args.continuePrompt.trim());
        } catch (error) {
          notify(ctx, `Rollback succeeded, but the continuation could not be queued: ${String(error)}`);
        }
      }
      if (ctx.hasUI) ctx.ui.notify(`Restored ${files} file(s) and checkpoint ${target.label}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      publishRollbackResult({
        requestId: args.requestId,
        ok: false,
        targetEntryId: target?.entryId,
        targetLabel: target?.label,
        error: message,
      });
      if (ctx.hasUI) ctx.ui.notify(message, "error");
    }
  };

  const runRedo = async (ctx: ExtensionCommandContext): Promise<void> => {
    try {
      await ctx.waitForIdle();
      const active = activeRedo(ctx);
      if (!active || ctx.sessionManager.getLeafId() !== active.entryId) throw new Error("Nothing to redo, or the rollback branch has advanced");
      await flushPending(ctx);
      if (ctx.sessionManager.getLeafId() !== active.entryId) throw new Error("Redo unavailable because files changed after rollback");
      const redo = active.data;
      let files = 0;
      let sandboxBefore: string | undefined;
      const applied: Mutation[] = [];

      if (redo.mode === "sandbox") {
        if (!sandboxed || !redo.sandbox) throw new Error("Sandbox redo can only run inside its original sandbox workspace");
        if (resolve(redo.sandbox.root) !== resolve(ctx.cwd)) throw new Error("Redo belongs to another sandbox workspace");
        if (await capture(pi, redo.sandbox.root, redo.sandbox.storeBase) !== redo.sandbox.rollbackTree) {
          throw new Error("Redo unavailable because the sandbox workspace changed after rollback");
        }
        const restored = await restore(pi, redo.sandbox.root, redo.sandbox.redoTree, redo.sandbox.storeBase);
        files += restored.files;
        sandboxBefore = restored.before;
      } else {
        await assertRedoGuards(pi, redo);
        try {
          for (const mutation of redo.mutations ?? []) {
            files += await applyMutation(pi, mutation, "after", sandboxed, ctx.cwd);
            applied.push(mutation);
          }
        } catch (error) {
          for (const mutation of [...applied].reverse()) await applyMutation(pi, mutation, "before", sandboxed, ctx.cwd);
          throw error;
        }
      }

      let result;
      try {
        result = await ctx.navigateTree(redo.sourceEntryId, { summarize: false });
      } catch (error) {
        if (sandboxBefore && redo.sandbox) await restore(pi, redo.sandbox.root, sandboxBefore, redo.sandbox.storeBase);
        for (const mutation of [...applied].reverse()) await applyMutation(pi, mutation, "before", sandboxed, ctx.cwd);
        throw error;
      }
      if (result.cancelled) {
        if (sandboxBefore && redo.sandbox) await restore(pi, redo.sandbox.root, sandboxBefore, redo.sandbox.storeBase);
        for (const mutation of [...applied].reverse()) await applyMutation(pi, mutation, "before", sandboxed, ctx.cwd);
        throw new Error("Redo cancelled");
      }
      if (ctx.hasUI) ctx.ui.notify(`Redid ${files} file(s) and restored checkpoint branch ${redo.targetLabel}`, "info");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  pi.on("agent_settled", async (_event, ctx) => {
    if (!pendingFiles.size && !pendingRoots.size) return;
    await flushPending(ctx);
  });

  pi.registerCommand("checkpoint", {
    description: "Save a rollback checkpoint",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await flushPending(ctx);
      await captureExternalChanges(ctx);
      const label = args.trim() || `checkpoint-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const checkpoint = await saveCheckpoint(pi, ctx, label, sandboxed);
      if (ctx.hasUI) ctx.ui.notify(checkpoint ? `Checkpoint saved: ${label}` : "No session entry to checkpoint", checkpoint ? "info" : "warning");
    },
  });

  pi.registerCommand("checkpoints", {
    description: "List active rollback checkpoints",
    handler: async (_args, ctx) => {
      const all = checkpoints(ctx).slice(-20);
      const text = all.length ? all.map((item, index) => `${index + 1}. ${item.label} · seq ${item.seq} · ${item.mode}`).join("\n") : "No rollback checkpoints.";
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("rollback", {
    description: "Restore files and conversation: /rollback <label>|entry:<id>|<count> [-- <continue prompt>]",
    handler: async (raw, ctx) => {
      await runRollback(parseRollbackArgs(raw), ctx);
    },
  });

  pi.registerCommand("redo", {
    description: "Redo the most recent rollback if its branch has not advanced",
    handler: async (_raw, ctx) => {
      await runRedo(ctx);
    },
  });

  pi.registerTool({
    name: "rollback",
    label: "Rollback",
    description: "Queue rollback to the start of this agent run, or an explicit saved checkpoint.",
    parameters: Type.Object({
      targetLabel: Type.Optional(Type.String()),
      targetEntryId: Type.Optional(Type.String()),
      count: Type.Optional(Type.Integer({ minimum: 1 })),
      continuePrompt: Type.Optional(Type.String()),
      summarize: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const forwarded: RollbackArgs = { ...params };
      if (!forwarded.targetLabel && !forwarded.targetEntryId) {
        const count = forwarded.count ?? 1;
        const starts = checkpoints(ctx).filter((checkpoint) => /^rollback-before-\d+-0$/.test(checkpoint.label));
        const target = starts.at(-count);
        if (!target) throw new Error(`Can roll back at most ${starts.length} agent run(s)`);
        forwarded.targetEntryId = target.entryId;
        delete forwarded.count;
      }
      await pi.sendUserMessage(`/rollback ${JSON.stringify(forwarded)}`, { deliverAs: "followUp", expandPromptTemplates: true });
      return { content: [{ type: "text", text: "Queued rollback after the current turn." }], details: forwarded };
    },
  });
}
