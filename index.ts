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

function sandboxStore(cwd: string): string {
  return join(cwd, ".pi", ".rollback-snapshots");
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

export async function capture(pi: ExtensionAPI, cwd: string, storeBase = SNAPSHOT_ROOT): Promise<string> {
  const gitDir = snapshotDir(cwd, storeBase);
  if (!existsSync(gitDir)) {
    mkdirSync(gitDir, { recursive: true, mode: 0o700 });
    await git(pi, cwd, ["--git-dir", gitDir, "--work-tree", cwd, "init"]);
  }
  excludeNestedStore(cwd, gitDir);
  // ponytail: root snapshots include every non-ignored file; native file tools use the cheaper journal path.
  await git(pi, cwd, ["--git-dir", gitDir, "--work-tree", cwd, "add", "--all", "--", "."]);
  return git(pi, cwd, ["--git-dir", gitDir, "write-tree"]);
}

async function pin(pi: ExtensionAPI, state: RootState, sessionId: string, entryId: string): Promise<void> {
  const gitDir = snapshotDir(state.root, state.storeBase);
  const session = safeHash(sessionId).slice(0, 16);
  const entry = safeHash(entryId).slice(0, 16);
  await git(pi, state.root, ["--git-dir", gitDir, "update-ref", `refs/pi-rollback/${session}/${entry}/${state.tree}`, state.tree]);
}

async function changedPaths(pi: ExtensionAPI, cwd: string, from: string, to: string, storeBase: string): Promise<string[]> {
  const gitDir = snapshotDir(cwd, storeBase);
  const output = await git(pi, cwd, ["--git-dir", gitDir, "diff", "--name-only", "-z", "--no-renames", from, to, "--", "."]);
  return output.split("\0").filter(Boolean);
}

export async function restore(
  pi: ExtensionAPI,
  cwd: string,
  target: string,
  storeBase = SNAPSHOT_ROOT,
): Promise<{ files: number; before: string }> {
  const current = await capture(pi, cwd, storeBase);
  const paths = await changedPaths(pi, cwd, target, current, storeBase);
  const gitDir = snapshotDir(cwd, storeBase);
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    const scoped = relative(cwd, absolute);
    if (scoped.startsWith("..") || isAbsolute(scoped)) throw new Error(`Snapshot path escapes workspace: ${path}`);
    const exists = await pi.exec("git", ["--git-dir", gitDir, "cat-file", "-e", `${target}:${path}`], { cwd, timeout: 30_000 });
    if (exists.code === 0) await git(pi, cwd, ["--git-dir", gitDir, "--work-tree", cwd, "checkout", target, "--", path]);
    else rmSync(absolute, { recursive: true, force: true });
  }
  await git(pi, cwd, ["--git-dir", gitDir, "read-tree", target]);
  return { files: paths.length, before: current };
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
    const storeBase = sandboxStore(ctx.cwd);
    const tree = await capture(pi, ctx.cwd, storeBase);
    checkpoint.sandbox = { root: ctx.cwd, tree, storeBase };
    await pin(pi, checkpoint.sandbox, ctx.sessionManager.getSessionId(), entryId);
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

export function parseRollbackArgs(raw: string): RollbackArgs {
  const input = raw.trim();
  if (!input) return { count: 1 };
  if (input.startsWith("{")) return JSON.parse(input) as RollbackArgs;
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

export default function rollbackExtension(pi: ExtensionAPI): void {
  const sandboxed = isHcomSandbox();
  let agentRun = 0;
  const pendingFiles = new Map<string, PendingFile>();
  const pendingRoots = new Map<string, PendingRoot>();
  const trackedRoots = new Set<string>();

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
    const latestRoots = new Map<string, RootMutation>();
    for (const item of mutations(ctx)) {
      if (item.kind === "file") latestFiles.set(item.path, item.after);
      else latestRoots.set(item.root, item);
    }
    for (const [path, before] of latestFiles) {
      try {
        addRoot(trackedRoots, await projectRoot(pi, path));
        const after = captureFileState(path);
        if (!sameFileState(before, after)) appendMutation(pi, ctx, { kind: "file", path, before, after, source: "external" });
      } catch (error) {
        notify(ctx, `Rollback could not inspect ${path}: ${String(error)}`);
      }
    }
    for (const item of latestRoots.values()) {
      try {
        addRoot(trackedRoots, item.root);
        const after = await capture(pi, item.root, item.storeBase);
        if (item.after !== after) appendMutation(pi, ctx, { kind: "root", root: item.root, before: item.after, after, storeBase: item.storeBase, source: "external" });
      } catch (error) {
        notify(ctx, `Rollback could not inspect ${item.root}: ${String(error)}`);
      }
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    if (sandboxed) return;
    try {
      for (const path of mutationPaths(event.toolName, event.input, ctx.cwd, false)) {
        if (!pendingFiles.has(path)) pendingFiles.set(path, { path, before: captureFileState(path) });
        addRoot(trackedRoots, await projectRoot(pi, path));
      }
      if (event.toolName !== "bash" && event.toolName !== "powershell") return;
      const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
      const command = typeof input.command === "string" ? input.command : "";
      const roots = new Set<string>();
      addRoot(roots, ctx.cwd);
      for (const root of trackedRoots) addRoot(roots, root);
      for (const hint of bashPathHints(command, ctx.cwd)) addRoot(roots, await projectRoot(pi, canonicalMutationPath(hint, ctx.cwd)));
      for (const root of roots) {
        if (pendingRoots.has(root)) continue;
        pendingRoots.set(root, { root, before: await capture(pi, root), storeBase: SNAPSHOT_ROOT });
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
      await captureExternalChanges(ctx);
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
      let files = 0;
      let sandboxBefore: string | undefined;
      const reverted: Mutation[] = [];
      const selected = mutations(ctx).filter((item) => item.seq > target!.seq).sort((a, b) => b.seq - a.seq);
      if (sandboxed && target.mode !== "sandbox") throw new Error("Sandbox rollback refuses checkpoints created outside sandbox mode");

      if (target.mode === "sandbox") {
        if (!sandboxed || !target.sandbox) throw new Error("Sandbox checkpoint can only be restored inside its sandbox workspace");
        if (resolve(target.sandbox.root) !== resolve(ctx.cwd)) throw new Error("Sandbox checkpoint belongs to another workspace");
        const result = await restore(pi, target.sandbox.root, target.sandbox.tree, target.sandbox.storeBase);
        files += result.files;
        sandboxBefore = result.before;
      } else {
        try {
          for (const mutation of selected) {
            files += await applyMutation(pi, mutation, "before", sandboxed, ctx.cwd);
            reverted.push(mutation);
          }
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
      if (args.continuePrompt?.trim()) await pi.sendUserMessage(args.continuePrompt.trim());
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
