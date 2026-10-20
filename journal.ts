import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { homedir } from "node:os";

export const BLOB_ROOT = join(homedir(), ".pi", "agent", "rollback-snapshots", "blobs");

export type FileState =
  | { kind: "missing" }
  | { kind: "file"; blob: string; mode: number };

function blobPath(blob: string, blobRoot = BLOB_ROOT): string {
  return join(blobRoot, blob.slice(0, 2), blob.slice(2));
}

function storeBlob(content: Buffer, blobRoot: string): string {
  const blob = createHash("sha256").update(content).digest("hex");
  const path = blobPath(blob, blobRoot);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Write-then-rename: a crash or full disk mid-write must never leave a
    // truncated blob at the final path. The existence check above would treat
    // it as already stored and every later restore of that state would fail
    // with "Corrupt rollback blob".
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }
  return blob;
}

/**
 * Stat-keyed memo of the last hashed state per path. captureFileState runs for
 * every journaled file at every turn boundary (external-change reconciliation),
 * so without it each turn re-reads and re-hashes every tracked file. An entry is
 * trusted only when device, inode, size, mode, mtime and ctime all match and the
 * file was not modified within RACY_WINDOW_MS of the hash (the same "racy clean"
 * rule Git applies to its index), so same-second rewrites are always re-hashed.
 */
interface StatMemo { dev: number; ino: number; size: number; mode: number; mtimeMs: number; ctimeMs: number; hashedAt: number; blob: string }
const statMemo = new Map<string, StatMemo>();
const STAT_MEMO_LIMIT = 4096;
const RACY_WINDOW_MS = 2_000;

export function clearFileStateCache(): void {
  statMemo.clear();
}

/** Resolve existing symlinks so a write through cwd/link tracks the actual target. */
export function canonicalMutationPath(input: string, cwd: string): string {
  const absolute = resolve(cwd, input);
  if (existsSync(absolute)) return realpathSync(absolute);
  const suffix: string[] = [];
  let parent = absolute;
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) break;
    suffix.unshift(basename(parent));
    parent = next;
  }
  return resolve(existsSync(parent) ? realpathSync(parent) : parent, ...suffix);
}

export function isWithin(root: string, path: string): boolean {
  const scoped = relative(realpathSync(root), path);
  return scoped === "" || (!scoped.startsWith("..") && !isAbsolute(scoped));
}

export function isHcomSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HCOM_WORKER_SANDBOX === "workspace" || env.HCOM_WORKER_SANDBOX === "podman-workspace";
}

export function captureFileState(path: string, blobRoot = BLOB_ROOT): FileState {
  if (!existsSync(path)) return { kind: "missing" };
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`Rollback supports regular files only: ${path}`);
  const mode = stat.mode & 0o777;
  const key = `${blobRoot}\0${path}`;
  const memo = statMemo.get(key);
  if (
    memo
    && memo.dev === stat.dev && memo.ino === stat.ino && memo.size === stat.size && memo.mode === mode
    && memo.mtimeMs === stat.mtimeMs && memo.ctimeMs === stat.ctimeMs
    && memo.hashedAt - stat.mtimeMs > RACY_WINDOW_MS
    && existsSync(blobPath(memo.blob, blobRoot))
  ) {
    return { kind: "file", blob: memo.blob, mode };
  }
  const hashedAt = Date.now();
  const blob = storeBlob(readFileSync(path), blobRoot);
  if (statMemo.size >= STAT_MEMO_LIMIT) statMemo.clear();
  statMemo.set(key, { dev: stat.dev, ino: stat.ino, size: stat.size, mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hashedAt, blob });
  return { kind: "file", blob, mode };
}

export function sameFileState(a: FileState, b: FileState): boolean {
  return a.kind === b.kind && (a.kind === "missing" || (b.kind === "file" && a.blob === b.blob && a.mode === b.mode));
}

export function restoreFileState(path: string, state: FileState, blobRoot = BLOB_ROOT): void {
  if (state.kind === "missing") {
    if (existsSync(path)) {
      if (lstatSync(path).isDirectory()) throw new Error(`Refusing to remove directory for missing file state: ${path}`);
      rmSync(path, { force: true });
    }
    return;
  }
  const content = readFileSync(blobPath(state.blob, blobRoot));
  if (createHash("sha256").update(content).digest("hex") !== state.blob) throw new Error(`Corrupt rollback blob: ${state.blob}`);
  // Fail closed like the "missing" branch above: a directory that took the
  // file's place may hold unrelated, unjournaled work, so refusing is safer
  // than recursively deleting it to restore one file.
  if (existsSync(path) && lstatSync(path).isDirectory()) {
    throw new Error(`Refusing to replace directory with a restored file: ${path} (move the directory aside first)`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.pi-rollback-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temporary, content, { mode: state.mode });
    chmodSync(temporary, state.mode);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function mutationPaths(toolName: string, input: unknown, cwd: string, sandboxed: boolean): string[] {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  let candidate: unknown;
  if (toolName === "write" || toolName === "edit") candidate = value.path;
  else if (toolName === "ts_morph") candidate = value.filePath;
  if (typeof candidate !== "string" || !candidate.trim()) return [];
  const path = canonicalMutationPath(candidate, cwd);
  return sandboxed && !isWithin(cwd, path) ? [] : [path];
}

/**
 * Detect shell commands whose side effects are plausibly irreversible (file
 * deletion, hard resets, mass table edits). Deliberately conservative: a false
 * positive only costs one extra checkpoint and snapshot, a false negative loses
 * data. Plain output redirection (`> file`) is intentionally not destructive
 * enough to guard.
 */
export function isDestructiveCommand(command: string): boolean {
  return /(?:^|[\s;&|(=`/])(?:rm|rmdir|shred|unlink)(?:\s|$)|(?:^|[\s;&|(])(?:del|erase|rd)\s+\S|\btruncate\s+(?:-s|--size)\b|\bfind\b[^\n]*\s-delete(?:\s|$)|\bxargs\b[^\n]*\s(?:rm|rmdir)\b|git\s+(?:reset\s+--hard|clean\b|checkout\s+(?:--|\.)|restore\b|switch\s+--force|branch\s+-D\b)|(?:^|[\s;&|(])\bdd\b[^\n]*\bof=|\b(?:mkfs(?:\.\w+)?|wipefs)\b|\b(?:DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE\s+TABLE|DELETE\s+FROM)\b|\bremove-item\b/i.test(command);
}

/**
 * POSIX locations that are never workspace roots: pseudo filesystems (a Git
 * snapshot of /dev or /proc hangs or fails) and system binary directories.
 * `> /dev/null` alone otherwise turned /dev into a deep-tracking snapshot root.
 */
const NON_WORKSPACE_PREFIXES = ["/dev/", "/proc/", "/sys/", "/run/", "/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/"];

export function isNonWorkspacePath(path: string): boolean {
  const normalized = path.endsWith("/") ? path : `${path}/`;
  return NON_WORKSPACE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Conservative hints only; arbitrary shell side effects cannot be inferred statically. */
export function bashPathHints(command: string, cwd: string, platform: string = process.platform): string[] {
  const hints = new Set<string>();
  const add = (raw: string): void => {
    let value = raw.replace(/^['"]|['"]$/g, "");
    if (!value || value === "-") return;
    const home = platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
    // `cd ~/x` is expanded by the shell; resolving it literally produced <cwd>/~/x.
    if (platform !== "win32" && home && (value === "~" || value.startsWith("~/"))) value = home + value.slice(1);
    else if (value.startsWith("~")) return;
    const windows = platform === "win32" && !value.startsWith("/") && win32.isAbsolute(value);
    const path = windows ? win32.normalize(value) : resolve(cwd, value);
    const root = windows ? win32.parse(path).root : "/";
    if (path.toLowerCase() === root.toLowerCase() || (home && path.toLowerCase() === home.toLowerCase())) return;
    if (!windows && isNonWorkspacePath(path)) return;
    hints.add(path);
  };
  for (const match of command.matchAll(/(?:^|[;&|]\s*|\s)cd\s+(?:--\s+)?((?:'[^']+'|"[^"]+"|[^\s;&|]+))/g)) add(match[1]!);
  for (const match of command.matchAll(/(?:^|\s)git\s+-C\s+((?:'[^']+'|"[^"]+"|[^\s;&|]+))/g)) add(match[1]!);
  for (const match of command.matchAll(/(?:^|[\s<>])((?:'[^']+'|"[^"]+"|[^\s;&|<>]+))/g)) {
    const value = match[1]!.replace(/^['"]|['"]$/g, "");
    if (isAbsolute(value) || (platform === "win32" && !value.startsWith("/") && win32.isAbsolute(value))) add(match[1]!);
  }
  return [...hints];
}
