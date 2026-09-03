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
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { homedir } from "node:os";

export const BLOB_ROOT = join(homedir(), ".pi", "agent", "rollback-snapshots", "blobs");

export type FileState =
  | { kind: "missing" }
  | { kind: "file"; blob: string; mode: number };

function blobPath(blob: string): string {
  return join(BLOB_ROOT, blob.slice(0, 2), blob.slice(2));
}

function storeBlob(content: Buffer): string {
  const blob = createHash("sha256").update(content).digest("hex");
  const path = blobPath(blob);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return blob;
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

export function captureFileState(path: string): FileState {
  if (!existsSync(path)) return { kind: "missing" };
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`Rollback supports regular files only: ${path}`);
  return { kind: "file", blob: storeBlob(readFileSync(path)), mode: stat.mode & 0o777 };
}

export function sameFileState(a: FileState, b: FileState): boolean {
  return a.kind === b.kind && (a.kind === "missing" || (b.kind === "file" && a.blob === b.blob && a.mode === b.mode));
}

export function restoreFileState(path: string, state: FileState): void {
  if (state.kind === "missing") {
    if (existsSync(path)) {
      if (lstatSync(path).isDirectory()) throw new Error(`Refusing to remove directory for missing file state: ${path}`);
      rmSync(path, { force: true });
    }
    return;
  }
  const content = readFileSync(blobPath(state.blob));
  if (createHash("sha256").update(content).digest("hex") !== state.blob) throw new Error(`Corrupt rollback blob: ${state.blob}`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.pi-rollback-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temporary, content, { mode: state.mode });
    chmodSync(temporary, state.mode);
    if (existsSync(path) && statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function mutationPaths(toolName: string, input: unknown, cwd: string, sandboxed: boolean): string[] {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  let candidate: unknown;
  if (toolName === "write" || toolName === "edit" || toolName === "undo_last_edit") candidate = value.path;
  else if (toolName === "ts_morph") candidate = value.filePath;
  if (typeof candidate !== "string" || !candidate.trim()) return [];
  const path = canonicalMutationPath(candidate, cwd);
  return sandboxed && !isWithin(cwd, path) ? [] : [path];
}

/** Conservative hints only; arbitrary shell side effects cannot be inferred statically. */
export function bashPathHints(command: string, cwd: string, platform: string = process.platform): string[] {
  const hints = new Set<string>();
  const add = (raw: string): void => {
    const value = raw.replace(/^['"]|['"]$/g, "");
    if (!value) return;
    const windows = platform === "win32" && !value.startsWith("/") && win32.isAbsolute(value);
    const path = windows ? win32.normalize(value) : resolve(cwd, value);
    const root = windows ? win32.parse(path).root : "/";
    const home = windows ? process.env.USERPROFILE : process.env.HOME;
    if (path.toLowerCase() === root.toLowerCase() || (home && path.toLowerCase() === home.toLowerCase())) return;
    if (!windows && ["/usr/bin/", "/bin/", "/sbin/"].some((prefix) => path.startsWith(prefix))) return;
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
