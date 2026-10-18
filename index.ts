import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  bashPathHints,
  canonicalMutationPath,
  captureFileState,
  type FileState,
  isDestructiveCommand,
  isHcomSandbox,
  isWithin,
  mutationPaths,
  restoreFileState,
  sameFileState,
} from "./journal.js";
import {
  assertSafeLayoutRoot,
  createLease,
  parsePruneConfig,
  readPruneSettings,
  pruneSnapshots,
  readLastPruneAt,
  refreshLease,
  releaseLease,
  touchActivity,
  touchLastPruneAt,
  validCandidateRelative,
  type LeaseHandle,
  type PruneDependencies,
  type PruneMode,
  type PruneConfig,
  type PruneReport,
} from "./prune.js";

const CHECKPOINT_TYPE = "pi-rollback-checkpoint";
const MUTATION_TYPE = "pi-rollback-mutation";
const RESULT_TYPE = "pi-rollback-result";
const REDO_TYPE = "pi-rollback-redo";
const CONTEXT_MESSAGE_TYPE = "pi-rollback-context";
export const ROLLBACK_RESULT_EVENT = "pi-rollback:result";
const SNAPSHOT_ROOT = join(homedir(), ".pi", "agent", "rollback-snapshots");
const VERSION = 2;
const RUN_START_LABEL = /^rollback-before-(\d+)-0$/;
const isRunStartLabel = (label: string): boolean => RUN_START_LABEL.test(label);

type RootState = { root: string; tree: string; storeBase: string };
type Mutation = FileMutation | RootMutation;

export interface Checkpoint {
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
  /** Free-form label query resolved against active checkpoints before rollback. */
  labelQuery?: string;
  targetEntryId?: string;
  count?: number;
  /** N turns back, landing at the end of the turn N back. */
  turnCount?: number;
  /** N agent runs back, landing at the start of that run. */
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
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    tool_name?: string;
    toolName?: string;
    isError?: boolean;
    is_error?: boolean;
    details?: { isError?: boolean; error?: unknown; [key: string]: unknown };
  };
}

type CheckpointContext = Pick<ExtensionCommandContext, "sessionManager" | "cwd" | "hasUI" | "ui">;
type PendingFile = { path: string; before: FileState };
type PendingRoot = { root: string; before: string; storeBase: string };

export function safeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function snapshotDir(cwd: string, storeBase = SNAPSHOT_ROOT): string {
  return join(storeBase, safeHash(cwd));
}
export function sessionStore(sessionId: string, layoutRoot = SNAPSHOT_ROOT): string {
  return join(layoutRoot, "sessions", safeHash(sessionId));
}
const storeQueues = new Map<string, Promise<void>>();

export function withStoreLock<T>(storeBase: string, fn: () => Promise<T>): Promise<T> {
  const prev = storeQueues.get(storeBase) ?? Promise.resolve();
  let release: () => void;
  const barrier = new Promise<void>((r) => { release = r; });
  storeQueues.set(storeBase, barrier);

  return prev
    .catch(() => {})
    .then(fn)
    .finally(() => {
      release();
      if (storeQueues.get(storeBase) === barrier) {
        storeQueues.delete(storeBase);
      }
    });
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
  for (const candidate of [gitDir, dirname(gitDir), dirname(dirname(gitDir)), SNAPSHOT_ROOT]) {
    const scoped = relative(root, candidate);
    if (scoped && !scoped.startsWith("..") && !isAbsolute(scoped)) exclusions.push(`/${scoped.replaceAll("\\", "/")}/`);
  }
  const unique = [...new Set(exclusions)];
  if (!unique.length) return;
  mkdirSync(join(gitDir, "info"), { recursive: true, mode: 0o700 });
  writeFileSync(join(gitDir, "info", "exclude"), `${unique.join("\n")}\n`, { mode: 0o600 });
}

async function stageSnapshot(pi: ExtensionAPI, cwd: string, gitDir: string): Promise<void> {
  try {
    rmSync(join(gitDir, "index.lock"), { force: true });
  } catch {}
  await git(pi, cwd, ["--git-dir", gitDir, "read-tree", "--empty"]);
  const result = await pi.exec("git", ["--git-dir", gitDir, "--work-tree", cwd, "add", "--all", "--ignore-errors", "--", "."], { cwd, timeout: 30_000 });
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr.trim() || "git add failed");
}

async function captureInternal(pi: ExtensionAPI, cwd: string, storeBase: string): Promise<string> {
  const gitDir = snapshotDir(cwd, storeBase);
  if (!existsSync(gitDir) || !existsSync(join(gitDir, "HEAD"))) {
    mkdirSync(gitDir, { recursive: true, mode: 0o700 });
    await git(pi, cwd, ["--git-dir", gitDir, "--work-tree", cwd, "init"]);
  }
  excludeNestedStore(cwd, gitDir);
  // ponytail: root snapshots include every non-ignored file; native file tools use the cheaper journal path.
  await stageSnapshot(pi, cwd, gitDir);
  const tree = await git(pi, cwd, ["--git-dir", gitDir, "write-tree"]);
  await git(pi, cwd, ["--git-dir", gitDir, "update-ref", `refs/pi-rollback/trees/${tree}`, tree]);
  touchActivity(/^[0-9a-f]{24}$/.test(storeBase.split(/[\\/]/).at(-1) ?? "") ? storeBase : gitDir);
  return tree;
}

export async function capture(pi: ExtensionAPI, cwd: string, storeBase = SNAPSHOT_ROOT): Promise<string> {
  return withStoreLock(storeBase, () => captureInternal(pi, cwd, storeBase));
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

async function restoreInternal(
  pi: ExtensionAPI,
  cwd: string,
  target: string,
  storeBase: string,
): Promise<{ files: number; before: string }> {
  const current = await captureInternal(pi, cwd, storeBase);
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

export async function restore(
  pi: ExtensionAPI,
  cwd: string,
  target: string,
  storeBase = SNAPSHOT_ROOT,
): Promise<{ files: number; before: string }> {
  return withStoreLock(storeBase, () => restoreInternal(pi, cwd, target, storeBase));
}

type BranchContext = { sessionManager: Pick<ExtensionCommandContext["sessionManager"], "getBranch"> };

function activeEntries(ctx: BranchContext): SessionEntry[] {
  return ctx.sessionManager.getBranch() as SessionEntry[];
}

function dataEntries<T>(ctx: BranchContext, customType: string): T[] {
  return activeEntries(ctx)
    .filter((entry) => entry.type === "custom" && entry.customType === customType)
    .map((entry) => entry.data as T);
}

function mutations(ctx: BranchContext): Mutation[] {
  return dataEntries<Mutation>(ctx, MUTATION_TYPE)
    .filter((item) => item?.version === VERSION && (item.kind === "file" || item.kind === "root"))
    .sort((a, b) => a.seq - b.seq);
}

function checkpoints(ctx: BranchContext): Checkpoint[] {
  return dataEntries<Checkpoint>(ctx, CHECKPOINT_TYPE)
    .filter((item) => item?.version === VERSION)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function activeRedo(ctx: BranchContext): ActiveRedo | undefined {
  const entry = activeEntries(ctx).findLast((item) =>
    item.type === "custom"
    && item.customType === REDO_TYPE
    && (item.data as RedoRecord | undefined)?.version === 1
  );
  return entry ? { entryId: entry.id, data: entry.data as RedoRecord } : undefined;
}

const MUTATION_TOOL_NAMES = new Set(["write", "edit", "ts_morph"]);

/** Walk back from a tool result to the assistant call that produced it. */
function findToolCall(
  entries: readonly SessionEntry[],
  resultIndex: number,
  toolCallId: string | undefined,
  toolName: string | undefined,
): { name: string; args: Record<string, unknown> } | undefined {
  for (let index = resultIndex - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (!message || message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
      if (call.type !== "toolCall" && call.type !== "tool_call") continue;
      const matches = toolCallId ? call.id === toolCallId : (!toolName || call.name === toolName);
      if (!matches) continue;
      return { name: call.name ?? toolName ?? "tool", args: (call.arguments ?? {}) as Record<string, unknown> };
    }
  }
  return undefined;
}

function toolResultFailed(message: NonNullable<SessionEntry["message"]>): boolean {
  return Boolean(message.isError || message.is_error || message.details?.isError || message.details?.error);
}

/**
 * Detect repeated failed file mutations: two consecutive failed attempts on the
 * same path (a successful mutation resets that path's streak). Used to nudge the
 * model toward a precise edit or rollback instead of stacking another patch.
 */
export function fileEditFailureStreak(
  entries: readonly SessionEntry[],
  window = 24,
): { path: string; failures: number } | undefined {
  const streaks = new Map<string, number>();
  // A success settles that target: older failures belong to a previous episode
  // and must not resurface on the next scan.
  const settled = new Set<string>();
  let inspected = 0;
  for (let index = entries.length - 1; index >= 0 && inspected < window; index -= 1) {
    const message = entries[index]?.message;
    if (!message || (message.role !== "toolResult" && message.role !== "tool_result")) continue;
    const toolName = message.toolName ?? message.tool_name;
    if (!toolName || !MUTATION_TOOL_NAMES.has(toolName)) continue;
    const call = findToolCall(entries, index, message.toolCallId, toolName);
    const target = typeof call?.args.path === "string"
      ? call.args.path
      : typeof call?.args.filePath === "string"
        ? call.args.filePath
        : toolName;
    inspected += 1;
    if (!toolResultFailed(message)) {
      streaks.delete(target);
      settled.add(target);
      continue;
    }
    if (settled.has(target)) continue;
    const failures = (streaks.get(target) ?? 0) + 1;
    streaks.set(target, failures);
    if (failures >= 2) return { path: target, failures };
  }
  return undefined;
}

function currentSeq(ctx: BranchContext): number {
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

async function saveCheckpoint(pi: ExtensionAPI, ctx: CheckpointContext, label: string, sandboxed: boolean, labeledEntries: Set<string> = new Set()): Promise<Checkpoint | undefined> {
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
  // Keep the first label a session entry receives (e.g. the run-boundary label
  // from turn_start) instead of overwriting it with later checkpoints that
  // share the same leaf.
  if (!labeledEntries.has(entryId)) {
    pi.setLabel(entryId, label);
    labeledEntries.add(entryId);
  }
  pi.appendEntry(CHECKPOINT_TYPE, checkpoint);
  return checkpoint;
}

function humanTarget(value: string): Pick<RollbackArgs, "count" | "targetEntryId" | "targetLabel" | "runCount" | "turnCount" | "labelQuery"> {
  const input = value.trim();
  if (!input) return { count: 1 };
  if (/^\d+$/.test(input)) return { count: Number(input) };
  if (input.startsWith("entry:")) {
    const targetEntryId = input.slice("entry:".length).trim();
    if (!targetEntryId) throw new Error("Missing entry id after entry:");
    return { targetEntryId };
  }
  const runMatch = /^runs?\s+(\d+)$/i.exec(input);
  if (runMatch) return { runCount: Number(runMatch[1]) };
  const turnMatch = /^turns?\s+(\d+)$/i.exec(input);
  if (turnMatch) return { turnCount: Number(turnMatch[1]) };
  // Free-form label, spaces allowed. Use the explicit `label:` prefix only to
  // disambiguate a label that itself looks like another target form.
  const targetLabel = input.startsWith("label:") ? input.slice("label:".length).trim() : input;
  if (!targetLabel) throw new Error("Missing rollback target");
  return { labelQuery: targetLabel };
}

/** Resolve a free-form label query to an exact active checkpoint label. */
export function resolveLabelQuery(all: Checkpoint[], query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Missing rollback target");
  const exact = all.findLast((checkpoint) => checkpoint.label === trimmed);
  if (exact) return exact.label;
  const lower = trimmed.toLowerCase();
  const caseInsensitive = all.findLast((checkpoint) => checkpoint.label.toLowerCase() === lower);
  if (caseInsensitive) return caseInsensitive.label;
  const matches = [...new Set(all.filter((checkpoint) => checkpoint.label.toLowerCase().includes(lower)).map((checkpoint) => checkpoint.label))];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Ambiguous checkpoint "${trimmed}" — candidates: ${matches.slice(-5).join(", ")}`);
  throw new Error(`No checkpoint matching "${trimmed}". Run /checkpoints to list available checkpoints.`);
}

export function relativeTime(from: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function compactTimestamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function describeCheckpoint(checkpoint: Checkpoint): string {
  const turn = /^rollback-(before|after)-(\d+)-(\d+)$/.exec(checkpoint.label);
  if (turn) return `run ${turn[2]} turn ${turn[3]} ${turn[1] === "before" ? "start" : "end"} · auto`;
  if (checkpoint.label.startsWith("auto-before-destructive")) return "before destructive command · auto";
  return checkpoint.label;
}

const AUTO_TURN_LABEL = /^rollback-(before|after)-\d+-\d+$/;
const TURN_END_LABEL = /^rollback-after-\d+-\d+$/;
// Labels the extension generates itself; they carry no human/agent-meaningful name.
const GENERATED_LABEL = /^(?:rollback-(?:before|after)-\d+-\d+|auto-before-destructive-\d+-\d+|checkpoint-\d{8}-\d{6})$/;

function firstUserText(entry: SessionEntry): string {
  const message = entry.message;
  if (!message || message.role !== "user") return "";
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = String((block as { text?: unknown }).text ?? "").trim();
      if (text) return text;
    }
  }
  return "";
}

function snippet(text: string, max = 48): string {
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export interface RestoreOption {
  /** Line shown in the picker/list. */
  display: string;
  /** Exact args that restore this point. */
  args: Pick<RollbackArgs, "targetLabel">;
  /** Human-typable command hint. */
  command: string;
  /** True when the option anchors on a user message. */
  message?: string;
}

/**
 * Build the human-facing restore menu: one entry per user message (run start),
 * plus named checkpoints and destructive guards. Turn-level auto checkpoints
 * are deliberately collapsed — they carry no information a human can act on.
 */
export function buildRestoreMenu(ctx: BranchContext): RestoreOption[] {
  const all = checkpoints(ctx);
  const snippets = new Map<string, string>();
  for (const entry of activeEntries(ctx)) {
    const text = firstUserText(entry);
    if (text) snippets.set(entry.id, snippet(text));
  }
  const starts = all.filter((checkpoint) => isRunStartLabel(checkpoint.label));
  const latestRun = starts.length ? Number(RUN_START_LABEL.exec(starts.at(-1)!.label)![1]) : 0;
  const options: RestoreOption[] = [];
  for (const checkpoint of [...all].reverse()) {
    const runStart = RUN_START_LABEL.exec(checkpoint.label);
    if (runStart) {
      const runNo = Number(runStart[1]);
      const runCount = starts.length - starts.indexOf(checkpoint);
      const message = snippets.get(checkpoint.entryId);
      const ago = relativeTime(checkpoint.createdAt);
      const current = runNo === latestRun ? " · current run" : "";
      const display = message ? `“${message}” · ${ago}${current}` : `start of run ${runNo} · ${ago}${current}`;
      options.push({ display, args: { targetLabel: checkpoint.label }, command: `/rollback run ${runCount}`, message });
      continue;
    }
    if (checkpoint.label.startsWith("auto-before-destructive")) {
      options.push({ display: `! before destructive command · ${relativeTime(checkpoint.createdAt)}`, args: { targetLabel: checkpoint.label }, command: `/rollback ${checkpoint.label}` });
      continue;
    }
    if (AUTO_TURN_LABEL.test(checkpoint.label)) continue;
    options.push({ display: `${checkpoint.label} · ${relativeTime(checkpoint.createdAt)}`, args: { targetLabel: checkpoint.label }, command: `/rollback ${checkpoint.label}` });
  }
  return options.slice(0, 20);
}

function formatRestoreMenu(ctx: BranchContext, filter?: string): string {
  let options = buildRestoreMenu(ctx);
  if (filter) {
    const needle = filter.toLowerCase();
    options = options.filter((option) => option.display.toLowerCase().includes(needle));
    if (!options.length) return `No restore points matching "${filter}".`;
  }
  const lines = options.map((option, index) => `${String(index + 1).padStart(2)}. ${option.display}   (${option.command})`);
  const parts = ["Restore points (newest first — one per message you sent):", ...lines.map((line) => `  ${line}`)];
  parts.push("Instant: /rollback opens an interactive picker · /checkpoints all lists raw turn-level checkpoints");
  return parts.join("\n");
}

function formatCheckpointList(ctx: CheckpointContext, now = Date.now(), view: { limit?: number; filter?: string } = {}): string {
  const all = checkpoints(ctx);
  if (!all.length) return "No rollback checkpoints yet — save one with /checkpoint <label>.";
  let indexed = all.map((checkpoint, index) => ({ checkpoint, index }));
  if (view.filter) {
    const needle = view.filter.toLowerCase();
    indexed = indexed.filter((item) => item.checkpoint.label.toLowerCase().includes(needle));
    if (!indexed.length) return `No rollback checkpoints matching "${view.filter}".`;
  }
  const limit = view.limit ?? 20;
  const visible = limit <= 0 ? indexed : indexed.slice(-limit);
  const hidden = indexed.length - visible.length;
  const lines = visible.map(({ checkpoint, index }) => {
    const back = all.length - 1 - index;
    const hints: string[] = [];
    if (back >= 1) hints.push(`/rollback ${back}`);
    const runStart = RUN_START_LABEL.exec(checkpoint.label);
    if (runStart) {
      const starts = all.filter((item) => isRunStartLabel(item.label));
      const runCount = starts.length - starts.indexOf(checkpoint);
      if (runCount >= 1) hints.push(`/rollback run ${runCount}`);
    }
    const hint = hints.length ? `   (${hints.join(" · ")})` : "";
    return `${String(index + 1).padStart(2)}. ${describeCheckpoint(checkpoint)} · ${relativeTime(checkpoint.createdAt, now)}` + hint;
  });
  const header = view.filter ? `Rollback checkpoints matching "${view.filter}" (oldest → newest):` : "Rollback checkpoints (oldest → newest):";
  const parts = [header, ...lines.map((line) => `  ${line}`)];
  if (hidden > 0) parts.push(`  … ${hidden} older hidden — /checkpoints <n> shows the last n, /checkpoints all shows every entry, /checkpoints <text> filters by label`);
  parts.push("Restore with: /rollback <label> · /rollback <n> (checkpoints back) · /rollback run <n> · /rollback turn <n> · /redo");
  return parts.join("\n");
}
function jsonRollbackArgs(value: unknown): RollbackArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rollback JSON must be an object");
  const args = value as Record<string, unknown>;
  const allowed = new Set(["targetLabel", "targetEntryId", "count", "turnCount", "runCount", "requestId", "continuePrompt", "summarize"]);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`Unknown rollback option: ${key}`);
  for (const key of ["targetLabel", "targetEntryId", "requestId", "continuePrompt"]) {
    if (args[key] !== undefined && typeof args[key] !== "string") throw new Error(`Rollback ${key} must be a string`);
  }
  for (const key of ["count", "turnCount", "runCount"]) {
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

type ResolvedCheckpoint = Checkpoint & {
  /** The session entry that holds this checkpoint; navigating here keeps it. */
  resolvedEntryId: string;
};

/** Checkpoints paired with the branch entry that stores them (navigation target). */
export function resolvedCheckpoints(ctx: BranchContext): ResolvedCheckpoint[] {
  return activeEntries(ctx)
    .filter((entry) => entry.type === "custom" && entry.customType === CHECKPOINT_TYPE)
    .filter((entry) => (entry.data as Partial<Checkpoint> | undefined)?.version === VERSION)
    .sort((a, b) => ((a.data as Checkpoint).createdAt - (b.data as Checkpoint).createdAt))
    .map((entry) => ({ ...(entry.data as Checkpoint), resolvedEntryId: entry.id }));
}

function findCheckpoint(ctx: CheckpointContext, args: RollbackArgs): ResolvedCheckpoint {
  const all = resolvedCheckpoints(ctx);
  const counts = [args.count, args.runCount, args.turnCount].filter((value) => value !== undefined);
  if ((args.targetEntryId || args.targetLabel) && counts.length) throw new Error("Rollback target is ambiguous");
  if (counts.length > 1) throw new Error("Rollback target is ambiguous");
  if (args.targetEntryId) {
    const found = all.findLast((checkpoint) => checkpoint.entryId === args.targetEntryId || checkpoint.resolvedEntryId === args.targetEntryId);
    if (found) return found;
    throw new Error(`No active checkpoint for entry ${args.targetEntryId}`);
  }
  if (args.targetLabel) {
    const found = all.findLast((checkpoint) => checkpoint.label === args.targetLabel);
    if (found) return found;
    throw new Error(`No active checkpoint labelled ${args.targetLabel}`);
  }
  if (args.runCount !== undefined) {
    const starts = all.filter((checkpoint) => isRunStartLabel(checkpoint.label));
    const target = starts.length - args.runCount;
    if (!Number.isInteger(args.runCount) || args.runCount < 1 || target < 0) {
      throw new Error(`Can roll back at most ${starts.length} agent run(s)`);
    }
    return starts[target]!;
  }
  if (args.turnCount !== undefined) {
    // turns=N undoes the last N completed turns: land at the end of the turn
    // before them. The current turn has not ended yet, so `ends` holds the
    // completed turns only.
    const ends = all.filter((checkpoint) => TURN_END_LABEL.test(checkpoint.label));
    const target = ends.length - 1 - args.turnCount;
    if (!Number.isInteger(args.turnCount) || args.turnCount < 1 || target < 0) {
      throw new Error(`Can roll back at most ${Math.max(0, ends.length - 1)} turn(s)`);
    }
    return ends[target]!;
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

type AppliedState =
  | { kind: "file"; path: string; state: FileState }
  | { kind: "root"; root: string; tree: string; storeBase: string };

/**
 * Apply one journaled mutation and return the exact state it replaced, so a
 * later failure can restore the workspace byte-for-byte. Replaying the
 * journaled `after`/`before` state is NOT equivalent: out-of-band edits made
 * after the mutation was recorded would be silently discarded.
 */
async function applyMutation(pi: ExtensionAPI, mutation: Mutation, side: "before" | "after", sandboxed: boolean, cwd: string, blobRoot?: string): Promise<{ files: number; undo?: AppliedState }> {
  if (mutation.kind === "file") {
    if (sandboxed && !isWithin(cwd, mutation.path)) throw new Error(`Sandbox rollback refused external path: ${mutation.path}`);
    const undo: AppliedState = { kind: "file", path: mutation.path, state: captureFileState(mutation.path, blobRoot) };
    restoreFileState(mutation.path, mutation[side], blobRoot);
    return { files: 1, undo };
  }
  if (sandboxed && resolve(mutation.root) !== resolve(cwd)) throw new Error(`Sandbox rollback refused external root: ${mutation.root}`);
  const restored = await restore(pi, mutation.root, mutation[side], mutation.storeBase);
  return { files: restored.files, undo: { kind: "root", root: mutation.root, tree: restored.before, storeBase: mutation.storeBase } };
}

async function undoApplied(pi: ExtensionAPI, applied: AppliedState[], blobRoot: string | undefined, onError: (message: string) => void): Promise<number> {
  let failures = 0;
  for (const state of [...applied].reverse()) {
    try {
      if (state.kind === "file") restoreFileState(state.path, state.state, blobRoot);
      else await restore(pi, state.root, state.tree, state.storeBase);
    } catch (error) {
      failures += 1;
      onError(`Rollback recovery could not restore ${state.kind === "file" ? state.path : state.root}: ${String(error)}`);
    }
  }
  return failures;
}

async function captureRedoGuards(pi: ExtensionAPI, selected: Mutation[], blobRoot?: string): Promise<Pick<RedoRecord, "fileGuards" | "rootGuards">> {
  const files = new Map<string, FileState>();
  const roots = new Map<string, RootState>();
  for (const mutation of selected) {
    if (mutation.kind === "file") files.set(mutation.path, captureFileState(mutation.path, blobRoot));
    else roots.set(mutation.root, { root: mutation.root, tree: await capture(pi, mutation.root, mutation.storeBase), storeBase: mutation.storeBase });
  }
  return {
    fileGuards: [...files].map(([path, state]) => ({ path, state })),
    rootGuards: [...roots.values()],
  };
}
async function assertRedoGuards(pi: ExtensionAPI, redo: RedoRecord, blobRoot?: string): Promise<void> {
  for (const guard of redo.fileGuards ?? []) {
    if (!sameFileState(captureFileState(guard.path, blobRoot), guard.state)) throw new Error(`Redo unavailable because ${guard.path} changed after rollback`);
  }
  for (const guard of redo.rootGuards ?? []) {
    if (await capture(pi, guard.root, guard.storeBase) !== guard.tree) throw new Error(`Redo unavailable because ${guard.root} changed after rollback`);
  }
}
export interface RollbackExtensionOptions {
  normalLayoutRoot?: string;
  pruneDependencies?: PruneDependencies;
  blobRoot?: string;
  pruneSettingsPath?: string;
  pruneEnv?: NodeJS.ProcessEnv;
}

export default function rollbackExtension(pi: ExtensionAPI, options: RollbackExtensionOptions = {}): void {
  const sandboxed = isHcomSandbox();
  const deepTracking = process.env.PI_ROLLBACK_DEEP_TRACKING === "1";
  const guardDestructive = process.env.PI_ROLLBACK_GUARD_DESTRUCTIVE !== "0" && process.env.PI_ROLLBACK_GUARD_DESTRUCTIVE !== "false";
  const normalLayoutRoot = options.normalLayoutRoot ?? SNAPSHOT_ROOT;
  const pruneSettings = readPruneSettings(options.pruneSettingsPath ?? join(getAgentDir(), "settings.json"));
  const pruneConfig: PruneConfig = pruneSettings.warning
    ? { ...parsePruneConfig({ PI_ROLLBACK_PRUNE: "0" }), warning: pruneSettings.warning }
    : parsePruneConfig(options.pruneEnv ?? process.env, pruneSettings.settings);
  let pruneWarningShown = false;
  let lastPruneAt: number | undefined;
  const leases = new Map<string, LeaseHandle>();
  let agentRun = 0;
  let currentTurnIndex = 0;
  let guardedTurn: string | undefined;
  // Sticky context notes: the last rollback outcome (shown for the turn that
  // follows it) and the named restore points (shown once, and again whenever the
  // set changes) so the model can observe that rollback is available and worked.
  let announcedResultKey: string | undefined;
  let announcedResultTurn: string | undefined;
  let announcedResultText: string | undefined;
  let announcedPointsKey: string | undefined;
  let announcedPointsText: string | undefined;
  let announcedNudge: { key: string; text: string } | undefined;
  const labeledEntries = new Set<string>();
  const pendingFiles = new Map<string, PendingFile>();
  const pendingRoots = new Map<string, PendingRoot>();

  const layoutFor = (ctx: CheckpointContext): { root: string; mode: PruneMode; candidate: string } => {
    const sessionHash = safeHash(ctx.sessionManager.getSessionId());
    if (sandboxed) {
      const root = join(ctx.cwd, ".pi", ".rollback-snapshots");
      assertSafeLayoutRoot(root, ctx.cwd);
      return { root, mode: "sandbox", candidate: sessionHash };
    }
    assertSafeLayoutRoot(normalLayoutRoot);
    return { root: normalLayoutRoot, mode: "normal", candidate: `sessions/${sessionHash}` };
  };

  const referencedCandidates = (ctx: CheckpointContext, layout: ReturnType<typeof layoutFor>): Set<string> => {
    const referenced = new Set<string>([layout.candidate]);
    const addStore = (storeBase: unknown, root?: unknown): void => {
      if (typeof storeBase !== "string") return;
      const absoluteStore = resolve(storeBase);
      let candidate = relative(layout.root, absoluteStore).replaceAll("\\", "/");
      if (layout.mode === "normal" && candidate === "" && typeof root === "string") candidate = safeHash(root);
      if (validCandidateRelative(layout.mode, candidate)) referenced.add(candidate);
    };
    for (const entry of ctx.sessionManager.getEntries() as SessionEntry[]) {
      if (entry.type !== "custom" || !entry.data || typeof entry.data !== "object") continue;
      if (entry.customType === MUTATION_TYPE) {
        const mutation = entry.data as Partial<RootMutation>;
        if (mutation.kind === "root") addStore(mutation.storeBase, mutation.root);
      } else if (entry.customType === CHECKPOINT_TYPE) {
        const checkpoint = entry.data as Partial<Checkpoint>;
        addStore(checkpoint.sandbox?.storeBase, checkpoint.sandbox?.root);
      } else if (entry.customType === REDO_TYPE) {
        const redo = entry.data as Partial<RedoRecord>;
        addStore(redo.sandbox?.storeBase, redo.sandbox?.root);
        for (const guard of redo.rootGuards ?? []) addStore(guard.storeBase, guard.root);
        for (const mutation of redo.mutations ?? []) if (mutation.kind === "root") addStore(mutation.storeBase, mutation.root);
      }
    }
    return referenced;
  };

  const protectCurrent = (ctx: CheckpointContext): void => {
    const layout = layoutFor(ctx);
    const desired = referencedCandidates(ctx, layout);
    for (const [candidate, handle] of [...leases]) {
      if (handle.layoutRoot === layout.root && desired.has(candidate)) continue;
      releaseLease(handle);
      leases.delete(candidate);
    }
    for (const candidate of desired) {
      const handle = leases.get(candidate);
      leases.set(candidate, handle && handle.layoutRoot === layout.root
        ? refreshLease(handle, layout.mode, options.pruneDependencies)
        : createLease(layout.root, layout.mode, candidate, options.pruneDependencies));
    }
  };

  const executePrune = (ctx: CheckpointContext, honorInterval: boolean, notifyResult = true): PruneReport | undefined => {
    protectCurrent(ctx);
    if (pruneConfig.warning && !pruneWarningShown) {
      pruneWarningShown = true;
      notify(ctx, pruneConfig.warning);
    }
    if (!pruneConfig.enabled) return undefined;
    const now = options.pruneDependencies?.now?.() ?? Date.now();
    const layout = layoutFor(ctx);
    if (honorInterval) {
      const previous = Math.max(lastPruneAt ?? 0, readLastPruneAt(layout.root) ?? 0);
      if (previous > 0 && now - previous < pruneConfig.intervalMs) return undefined;
    }
    const report = pruneSnapshots({
      layoutRoot: layout.root,
      mode: layout.mode,
      currentCandidate: layout.candidate,
      containmentRoot: layout.mode === "sandbox" ? ctx.cwd : undefined,
      config: pruneConfig,
      dependencies: options.pruneDependencies,
    });
    if (!report.errors.length) {
      lastPruneAt = now;
      try {
        touchLastPruneAt(layout.root, now);
      } catch (error) {
        report.errors.push(`Could not record rollback prune completion: ${String(error)}`);
      }
    }
    if (notifyResult && report.bytesRemoved > 0 && ctx.hasUI) {
      ctx.ui.notify(`Rollback pruning reclaimed ${report.bytesRemoved} byte(s); ${report.remainingBytes} byte(s) remain`, "info");
    }
    if (notifyResult && report.errors.length) notify(ctx, `Rollback pruning warning: ${report.errors.join("; ")}`);
    return report;
  };
  const flushPending = async (ctx: CheckpointContext): Promise<void> => {
    for (const item of pendingFiles.values()) {
      try {
        const after = captureFileState(item.path, options.blobRoot);
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
        const after = captureFileState(path, options.blobRoot);
        if (!sameFileState(before, after)) appendMutation(pi, ctx, { kind: "file", path, before, after, source: "external" });
      } catch (error) {
        notify(ctx, `Rollback could not inspect ${path}: ${String(error)}`);
      }
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    protectCurrent(ctx);
    try {
      if (sandboxed) return;
      for (const path of mutationPaths(event.toolName, event.input, ctx.cwd, false)) {
        if (!pendingFiles.has(path)) pendingFiles.set(path, { path, before: captureFileState(path, options.blobRoot) });
      }
      const isShell = event.toolName === "bash" || event.toolName === "powershell";
      const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : {};
      const command = isShell && typeof input.command === "string" ? input.command : "";
      // Destructive-command guard: before a plausibly irreversible shell command
      // runs (once per turn), flush the journal, drop an auto checkpoint, and
      // capture a workspace tree baseline so the damage is revertible even with
      // deep tracking disabled. bash changes are otherwise unjournaled by default.
      if (isShell && guardDestructive && command && isDestructiveCommand(command) && guardedTurn !== `${agentRun}:${currentTurnIndex}`) {
        try {
          await flushPending(ctx);
          await saveCheckpoint(pi, ctx, `auto-before-destructive-${agentRun}-${currentTurnIndex}`, sandboxed, labeledEntries);
          const root = resolve(ctx.cwd);
          if (!pendingRoots.has(root)) {
            const storeBase = sessionStore(ctx.sessionManager.getSessionId(), normalLayoutRoot);
            pendingRoots.set(root, { root, before: await capture(pi, root, storeBase), storeBase });
          }
          guardedTurn = `${agentRun}:${currentTurnIndex}`;
        } catch (guardError) {
          // Leave the turn unguarded so a later destructive command retries
          // instead of losing protection for the rest of the turn.
          notify(ctx, `Rollback destructive guard skipped: ${String(guardError)}`);
        }
      }
      if (!isShell || !deepTracking) return;
      const roots = new Set<string>();
      addRoot(roots, ctx.cwd);
      for (const hint of bashPathHints(command, ctx.cwd)) addRoot(roots, await projectRoot(pi, canonicalMutationPath(hint, ctx.cwd)));
      for (const root of roots) {
        if (pendingRoots.has(root)) continue;
        const storeBase = sessionStore(ctx.sessionManager.getSessionId(), normalLayoutRoot);
        pendingRoots.set(root, { root, before: await capture(pi, root, storeBase), storeBase });
      }
    } catch (error) {
      notify(ctx, `Rollback preflight skipped: ${String(error)}`);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    // The extension instance outlives a single session in long-lived agents.
    // Reset per-session bookkeeping so run/turn labels restart deterministically,
    // and never flush captures that belong to the previous session's branch into
    // the new session's journal.
    agentRun = 0;
    currentTurnIndex = 0;
    guardedTurn = undefined;
    announcedResultKey = undefined;
    announcedResultTurn = undefined;
    announcedResultText = undefined;
    announcedPointsKey = undefined;
    announcedPointsText = undefined;
    announcedNudge = undefined;
    labeledEntries.clear();
    if (pendingFiles.size || pendingRoots.size) {
      notify(ctx, `Rollback dropped ${pendingFiles.size + pendingRoots.size} unflushed capture(s) from the previous session`);
      pendingFiles.clear();
      pendingRoots.clear();
    }
    try {
      executePrune(ctx, true);
    } catch (error) {
      notify(ctx, `Rollback pruning warning: ${String(error)}`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      if (pendingFiles.size || pendingRoots.size) await flushPending(ctx);
    } finally {
      for (const handle of leases.values()) releaseLease(handle);
      leases.clear();
    }
  });

  pi.on("agent_start", async () => {
    agentRun += 1;
  });

  pi.on("turn_start", async (event, ctx) => {
    if (typeof event.turnIndex === "number") currentTurnIndex = event.turnIndex;
    try {
      protectCurrent(ctx);
      await flushPending(ctx);
      // Reconcile BEFORE the before-checkpoint, unconditionally. Out-of-band
      // writes (commit formatting hooks, generators, any non-tool writer) land
      // between turns; reconciling here makes the checkpoint seq reflect the
      // true on-disk state, so a later rollback can never rewind a file to a
      // stale pre-hook snapshot. (Previously gated behind deepTracking, which
      // let commit-hook edits be silently destroyed by rollback — observed on
      // 2026-09-30 with three 0.99.1 adaptation files.)
      await captureExternalChanges(ctx);
      await saveCheckpoint(pi, ctx, `rollback-before-${agentRun}-${currentTurnIndex}`, sandboxed, labeledEntries);
    } catch (error) {
      notify(ctx, `Rollback checkpoint skipped: ${String(error)}`);
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      protectCurrent(ctx);
      await flushPending(ctx);
      await saveCheckpoint(pi, ctx, `rollback-after-${agentRun}-${currentTurnIndex}`, sandboxed, labeledEntries);
    } catch (error) {
      notify(ctx, `Rollback checkpoint skipped: ${String(error)}`);
    }
  });

  const turnKey = (): string => `${agentRun}:${currentTurnIndex}`;

  const clip = (value: string, max = 80): string => (value.length > max ? `${value.slice(0, max)}…` : value);

  /**
   * Notes the model otherwise never sees: a rollback truncates the branch (the
   * call and its outcome vanish) and the result entry has no other consumer, so
   * without this projection the model cannot tell whether a rollback happened,
   * succeeded, or restored anything. Bounded: the outcome line lives for one
   * turn; the restore-point line is emitted once per set of named checkpoints.
   */
  const rollbackContextNote = (ctx: BranchContext): string | undefined => {
    const result = activeEntries(ctx).reduce<RollbackResult | undefined>((latest, entry) => {
      if (entry.type !== "custom" || entry.customType !== RESULT_TYPE) return latest;
      const data = entry.data as RollbackResult | undefined;
      return data?.version === 1 ? data : latest;
    }, undefined);
    if (result) {
      const key = `${result.createdAt}:${result.ok ? "ok" : "failed"}:${result.files ?? 0}`;
      if (key !== announcedResultKey) {
        announcedResultKey = key;
        announcedResultTurn = turnKey();
        announcedResultText = result.ok
          ? `Last rollback succeeded: restored ${result.files ?? 0} file(s) to checkpoint "${clip(result.targetLabel ?? result.targetEntryId ?? "unknown")}".`
          : `Last rollback did not complete: ${clip(result.error ?? "unknown error", 200)}.`;
      } else if (announcedResultTurn !== turnKey()) {
        announcedResultText = undefined;
      }
    }
    const named = checkpoints(ctx).filter((checkpoint) => !GENERATED_LABEL.test(checkpoint.label));
    if (named.length) {
      const signature = named.map((checkpoint) => `${checkpoint.entryId}:${checkpoint.label}`).join("|");
      if (signature !== announcedPointsKey) {
        announcedPointsKey = signature;
        const recent = named.slice(-5).map((checkpoint) => `"${clip(checkpoint.label, 60)}"`).join(", ");
        announcedPointsText = `Named restore points (newest last): ${recent}. Save one with checkpoint({label:"..."}) before risky work; restore with rollback({targetLabel:"..."}).`;
      }
    } else {
      announcedPointsKey = undefined;
      announcedPointsText = undefined;
    }
    const streak = fileEditFailureStreak(activeEntries(ctx));
    if (streak) {
      const key = `${streak.path}:${turnKey()}`;
      if (announcedNudge?.key !== key) {
        const canRollback = checkpoints(ctx).some((checkpoint) => TURN_END_LABEL.test(checkpoint.label));
        announcedNudge = {
          key,
          text: `${streak.failures} consecutive failed edit attempt(s) on ${clip(streak.path, 120)} — ${
            canRollback
              ? "consider a precise edit or rollback({turns:1}) instead of stacking another patch"
              : "consider a precise edit instead of stacking another patch"
          }.`,
        };
      }
    } else {
      announcedNudge = undefined;
    }
    const lines = [announcedResultText, announcedNudge?.text, announcedPointsText].filter(Boolean) as string[];
    return lines.length ? lines.join("\n") : undefined;
  };

  pi.on("context", (event, ctx) => {
    let note: string | undefined;
    try {
      note = rollbackContextNote(ctx as BranchContext);
    } catch {
      return undefined;
    }
    const kept = event.messages.filter(
      (message) => (message as { customType?: string } | null)?.customType !== CONTEXT_MESSAGE_TYPE,
    );
    if (!note) return kept.length === event.messages.length ? undefined : { messages: kept as typeof event.messages };
    return {
      messages: [
        ...kept,
        {
          role: "custom",
          customType: CONTEXT_MESSAGE_TYPE,
          content: `[pi-rollback]\n${note}`,
          display: false,
          timestamp: 0,
        },
      ] as typeof event.messages,
    };
  });

  const publishRollbackResult = (result: Omit<RollbackResult, "version" | "createdAt">): RollbackResult => {
    const published: RollbackResult = { ...result, version: 1, createdAt: Date.now() };
    pi.appendEntry(RESULT_TYPE, published);
    pi.events.emit(ROLLBACK_RESULT_EVENT, published);
    return published;
  };

  const runRollback = async (args: RollbackArgs, ctx: ExtensionCommandContext): Promise<void> => {
    let target: ResolvedCheckpoint | undefined;
    try {
      // Defense in depth: reconcile journal with disk before resolving the
      // target, so the selection covers out-of-band edits made within the
      // current turn (e.g. a formatting hook firing after the last checkpoint).
      await captureExternalChanges(ctx);
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
      const applied: AppliedState[] = [];
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
          targetEntryId: target.resolvedEntryId,
          targetLabel: target.label,
          mode: "sandbox",
          sandbox: { root: target.sandbox.root, rollbackTree: target.sandbox.tree, redoTree: restored.before, storeBase: target.sandbox.storeBase },
          createdAt: Date.now(),
        };
      } else {
        try {
          for (const mutation of selected) {
            const outcome = await applyMutation(pi, mutation, "before", sandboxed, ctx.cwd, options.blobRoot);
            files += outcome.files;
            if (outcome.undo) applied.push(outcome.undo);
          }
          redo = {
            version: 1,
            sourceEntryId,
            targetEntryId: target.resolvedEntryId,
            targetLabel: target.label,
            mode: "normal",
            mutations: [...selected].reverse(),
            ...await captureRedoGuards(pi, selected, options.blobRoot),
            createdAt: Date.now(),
          };
        } catch (error) {
          await undoApplied(pi, applied, options.blobRoot, (message) => notify(ctx, message));
          throw error;
        }
      }

      let result;
      try {
        result = await ctx.navigateTree(target.resolvedEntryId, {
          summarize: args.summarize !== false,
          customInstructions: "Keep only validated findings from the abandoned rollback branch.",
          label: `rollback-${target.label}`,
        });
      } catch (error) {
        if (sandboxBefore && target.sandbox) await restore(pi, target.sandbox.root, sandboxBefore, target.sandbox.storeBase);
        await undoApplied(pi, applied, options.blobRoot, (message) => notify(ctx, message));
        throw error;
      }
      if (result.cancelled) {
        if (sandboxBefore && target.sandbox) await restore(pi, target.sandbox.root, sandboxBefore, target.sandbox.storeBase);
        await undoApplied(pi, applied, options.blobRoot, (message) => notify(ctx, message));
        publishRollbackResult({
          requestId: args.requestId,
          ok: false,
          targetEntryId: target.resolvedEntryId,
          targetLabel: target.label,
          error: "Rollback cancelled",
        });
        return;
      }
      publishRollbackResult({
        requestId: args.requestId,
        ok: true,
        targetEntryId: target.resolvedEntryId,
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
      const applied: AppliedState[] = [];

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
        await assertRedoGuards(pi, redo, options.blobRoot);
        try {
          for (const mutation of redo.mutations ?? []) {
            const outcome = await applyMutation(pi, mutation, "after", sandboxed, ctx.cwd, options.blobRoot);
            files += outcome.files;
            if (outcome.undo) applied.push(outcome.undo);
          }
        } catch (error) {
          await undoApplied(pi, applied, options.blobRoot, (message) => notify(ctx, message));
          throw error;
        }
      }

      let result;
      try {
        result = await ctx.navigateTree(redo.sourceEntryId, { summarize: false });
      } catch (error) {
        if (sandboxBefore && redo.sandbox) await restore(pi, redo.sandbox.root, sandboxBefore, redo.sandbox.storeBase);
        await undoApplied(pi, applied, options.blobRoot, (message) => notify(ctx, message));
        throw error;
      }
      if (result.cancelled) {
        if (sandboxBefore && redo.sandbox) await restore(pi, redo.sandbox.root, sandboxBefore, redo.sandbox.storeBase);
        await undoApplied(pi, applied, options.blobRoot, (message) => notify(ctx, message));
        throw new Error("Redo cancelled");
      }
      if (ctx.hasUI) ctx.ui.notify(`Redid ${files} file(s) and restored checkpoint branch ${redo.targetLabel}`, "info");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      protectCurrent(ctx);
      if (pendingFiles.size || pendingRoots.size) await flushPending(ctx);
      executePrune(ctx, true);
    } catch (error) {
      notify(ctx, `Rollback pruning warning: ${String(error)}`);
    }
  });

  pi.registerCommand("checkpoint", {
    description: "Save a rollback checkpoint (label is free-form text)",
    handler: async (args, ctx) => {
      protectCurrent(ctx);
      await ctx.waitForIdle();
      await flushPending(ctx);
      await captureExternalChanges(ctx);
      let label = args.trim();
      if (!label && ctx.hasUI && typeof ctx.ui.input === "function") {
        const typed = await ctx.ui.input("Checkpoint label (optional)", "free-form, e.g. before the big refactor");
        if (typed === undefined) {
          ctx.ui.notify("Checkpoint cancelled", "info");
          return;
        }
        label = typed.trim();
      }
      const finalLabel = label || `checkpoint-${compactTimestamp()}`;
      const checkpoint = await saveCheckpoint(pi, ctx, finalLabel, sandboxed, labeledEntries);
      if (ctx.hasUI) ctx.ui.notify(checkpoint ? `Checkpoint saved: ${finalLabel}` : "No session entry to checkpoint", checkpoint ? "info" : "warning");
    },
  });

  pi.registerCommand("checkpoints", {
    description: "Browse restore points: bare opens a picker (Enter selects, Esc lists); all | <n> | <text> = text views",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const input = args.trim();
      try {
        if (!input && typeof ctx.ui.select === "function") {
          const menu = buildRestoreMenu(ctx);
          if (menu.length) {
            const choice = await ctx.ui.select("Checkpoints — select to roll back, Esc to list", menu.map((option) => option.display));
            if (choice !== undefined) {
              const option = menu.find((item) => item.display === choice);
              if (option) {
                const confirmed = typeof ctx.ui.confirm === "function" ? await ctx.ui.confirm("Roll back to checkpoint", choice) : true;
                if (confirmed) {
                  await runRollback({ ...option.args }, ctx);
                  return;
                }
                ctx.ui.notify("Rollback cancelled", "info");
              }
            }
            // Esc or declined confirm: fall through to the text listing.
          }
        }
        if (/^all$/i.test(input)) ctx.ui.notify(formatCheckpointList(ctx, Date.now(), { limit: 0 }), "info");
        else if (/^\d+$/.test(input)) ctx.ui.notify(formatCheckpointList(ctx, Date.now(), { limit: Math.max(1, Number(input)) }), "info");
        else ctx.ui.notify(formatRestoreMenu(ctx, input || undefined), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
  pi.registerCommand("rollback-prune", {
    description: "Run rollback snapshot retention policy now",
    handler: async (_args, ctx) => {
      try {
        const report = executePrune(ctx, false, false);
        const message = report
          ? `Rollback pruning reclaimed ${report.bytesRemoved} byte(s); ${report.remainingBytes} byte(s) remain${report.errors.length ? `; warnings: ${report.errors.join("; ")}` : ""}`
          : pruneConfig.warning ? undefined : "Rollback pruning is disabled by PI_ROLLBACK_PRUNE=0";
        if (message && ctx.hasUI) ctx.ui.notify(message, report?.errors.length ? "warning" : "info");
      } catch (error) {
        notify(ctx, `Rollback pruning warning: ${String(error)}`);
      }
    },
  });

  pi.registerCommand("rollback", {
    description: "Restore files and conversation — bare /rollback opens a picker; direct: /rollback <label> | <n> | run <n> | turn <n> [-- <continue prompt>]",
    handler: async (raw, ctx) => {
      protectCurrent(ctx);
      try {
        if (!raw.trim() && ctx.hasUI && typeof ctx.ui.select === "function") {
          const menu = buildRestoreMenu(ctx);
          if (menu.length) {
            const choice = await ctx.ui.select("Roll back to…", menu.map((option) => option.display));
            if (choice === undefined) {
              ctx.ui.notify("Rollback cancelled", "info");
              return;
            }
            const option = menu.find((item) => item.display === choice);
            if (option) {
              await runRollback({ ...option.args }, ctx);
              return;
            }
          }
        }
        const args = parseRollbackArgs(raw);
        if (args.labelQuery !== undefined) {
          args.targetLabel = resolveLabelQuery(checkpoints(ctx), args.labelQuery);
          delete args.labelQuery;
        }
        await runRollback(args, ctx);
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("redo", {
    description: "Redo the most recent rollback if its branch has not advanced",
    handler: async (_raw, ctx) => {
      protectCurrent(ctx);
      await runRedo(ctx);
    },
  });

  pi.registerTool({
    name: "checkpoint",
    label: "Checkpoint",
    description: "Save a rollback checkpoint of the conversation and journaled workspace files. Cheap and safe; call it before risky or hard-to-reverse steps so the rollback tool can restore this point later.",
    promptSnippet: "Save a named rollback checkpoint before risky or hard-to-reverse steps",
    promptGuidelines: [
      "Call checkpoint before risky or hard-to-reverse work — bulk edits across many files, destructive shell commands, dependency or schema migrations, large refactors — and when you reach a stable verified state worth keeping.",
      "Labels are free-form and may contain spaces (for example 'before db migration'); keep them short and descriptive. Roll back to a checkpoint later with the rollback tool's targetLabel, or tell the user to run /rollback <label>.",
    ],
    parameters: Type.Object({
      label: Type.Optional(Type.String({ description: "Short free-form label, e.g. 'before db migration'. Defaults to a timestamp." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      protectCurrent(ctx);
      await flushPending(ctx);
      await captureExternalChanges(ctx);
      const label = (params.label ?? "").trim() || `checkpoint-${compactTimestamp()}`;
      const checkpoint = await saveCheckpoint(pi, ctx, label, sandboxed, labeledEntries);
      if (!checkpoint) return { content: [{ type: "text", text: "No session entry to checkpoint." }], details: { saved: false } };
      return { content: [{ type: "text", text: `Checkpoint saved: ${label}\n\n${formatRestoreMenu(ctx)}` }], details: { saved: true, label } };
    },
  });

  pi.registerTool({
    name: "rollback",
    label: "Rollback",
    description: "Queue a rollback: turns=N undoes the last N completed turns, runs=N returns to the start of the Nth agent run back, count=N counts checkpoints back, targetLabel restores a named checkpoint. With no target it returns to the start of the current agent run.",
    promptSnippet: "Roll back conversation and journaled workspace files to an earlier turn, run, or checkpoint",
    promptGuidelines: [
      "Call checkpoint with a short label before risky or hard-to-reverse work (bulk edits, migrations, destructive shell commands); it is cheap and makes an exact restore possible later. Automatic checkpoints already bracket every turn, and destructive shell commands are auto-guarded (label prefix auto-before-destructive).",
      "rollback targets: turns=N undoes the last N completed turns (the useful default for a failed repair), runs=N returns to the start of the Nth agent run back, count=N counts checkpoints back like /rollback <n>, and targetLabel/targetEntryId restore an explicit checkpoint. With no target it returns to the start of the current run. The rollback is queued after the current turn, so stop making changes after calling it.",
      "Roll back proactively, without waiting for the user, when the same failure repeats, when two consecutive attempts to change the same file both fail, when fixes start spreading across files or overwriting earlier work, or when the evidence shows the approach is wrong. Prefer rollback over stacking another speculative patch.",
      "For an isolated mistake with a clear local fix, use edit instead. Before rolling back proactively, avoid discarding validated work from the current run; use a precise edit or an explicit checkpoint when only part of the run is wrong. Slash commands available to the user are /checkpoint <label>, /checkpoints, /rollback (opens an interactive picker; direct forms <label> | <n> | run <n> | turn <n> [-- <continue prompt>]), and /redo.",
    ],
    parameters: Type.Object({
      targetLabel: Type.Optional(Type.String({ description: "Exact or fuzzy label of a named checkpoint." })),
      targetEntryId: Type.Optional(Type.String()),
      count: Type.Optional(Type.Integer({ minimum: 1, description: "Number of checkpoints back, same as /rollback <n>." })),
      turns: Type.Optional(Type.Integer({ minimum: 1, description: "Undo the last N completed turns." })),
      runs: Type.Optional(Type.Integer({ minimum: 1, description: "Number of agent runs back, landing at the start of that run." })),
      continuePrompt: Type.Optional(Type.String()),
      summarize: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const forwarded: RollbackArgs = {};
      if (params.targetLabel !== undefined) forwarded.targetLabel = params.targetLabel;
      if (params.targetEntryId !== undefined) forwarded.targetEntryId = params.targetEntryId;
      if (params.count !== undefined) forwarded.count = params.count;
      if (params.turns !== undefined) forwarded.turnCount = params.turns;
      if (params.runs !== undefined) forwarded.runCount = params.runs;
      if (params.continuePrompt !== undefined) forwarded.continuePrompt = params.continuePrompt;
      if (params.summarize !== undefined) forwarded.summarize = params.summarize;
      if (
        forwarded.count === undefined && forwarded.runCount === undefined && forwarded.turnCount === undefined
        && !forwarded.targetLabel && !forwarded.targetEntryId
      ) {
        // Default target: the start of the current agent run (the common
        // "undo everything this run did" case).
        const starts = resolvedCheckpoints(ctx).filter((checkpoint) => isRunStartLabel(checkpoint.label));
        const target = starts.at(-1);
        if (!target) throw new Error(`Can roll back at most ${starts.length} agent run(s)`);
        forwarded.targetEntryId = target.resolvedEntryId;
      }
      await pi.sendUserMessage(`/rollback ${JSON.stringify(forwarded)}`, { deliverAs: "followUp", expandPromptTemplates: true });
      return { content: [{ type: "text", text: "Queued rollback after the current turn." }], details: forwarded };
    },
  });
}
