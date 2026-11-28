import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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

function writeDurableTemp(temporary: string, content: Buffer, mode: number): void {
  const fd = openSync(temporary, "wx", mode);
  try {
    writeFileSync(fd, content);
    try {
      fchmodSync(fd, mode);
    } catch {
      chmodSync(temporary, mode);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function storeBlob(content: Buffer, blobRoot: string): string {
  const blob = createHash("sha256").update(content).digest("hex");
  const path = blobPath(blob, blobRoot);
  let needsWrite = !existsSync(path);
  if (!needsWrite) {
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size !== content.length) needsWrite = true;
    } catch {
      needsWrite = true;
    }
  }
  if (needsWrite) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Write + fsync + atomic rename: a crash or full disk mid-write must never
    // leave a truncated blob at the final path.
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeDurableTemp(temporary, content, 0o600);
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

/**
 * Read-only preflight check before rollback/redo mutates disk: verify target
 * path is not a directory and that any required blob exists with valid SHA-256.
 */
export function verifyRestoreFileState(path: string, state: FileState, blobRoot = BLOB_ROOT): void {
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(path);
  } catch {}
  if (state.kind === "missing") {
    if (existing?.isDirectory()) throw new Error(`Refusing to remove directory for missing file state: ${path}`);
    return;
  }
  if (existing?.isDirectory()) {
    throw new Error(`Refusing to replace directory with a restored file: ${path} (move the directory aside first)`);
  }
  const content = readFileSync(blobPath(state.blob, blobRoot));
  if (createHash("sha256").update(content).digest("hex") !== state.blob) throw new Error(`Corrupt rollback blob: ${state.blob}`);
}

export function restoreFileState(path: string, state: FileState, blobRoot = BLOB_ROOT): void {
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(path);
  } catch {}
  if (state.kind === "missing") {
    if (existing) {
      if (existing.isDirectory()) throw new Error(`Refusing to remove directory for missing file state: ${path}`);
      rmSync(path, { force: true });
    }
    return;
  }
  const content = readFileSync(blobPath(state.blob, blobRoot));
  if (createHash("sha256").update(content).digest("hex") !== state.blob) throw new Error(`Corrupt rollback blob: ${state.blob}`);
  // Fail closed like the "missing" branch above: a directory that took the
  // file's place may hold unrelated, unjournaled work, so refusing is safer
  // than recursively deleting it to restore one file.
  if (existing?.isDirectory()) {
    throw new Error(`Refusing to replace directory with a restored file: ${path} (move the directory aside first)`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.pi-rollback-${process.pid}-${randomUUID()}`);
  try {
    writeDurableTemp(temporary, content, state.mode);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function expandHomePrefix(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Pi write/edit (and pi-agent-edit) expand `~/` and strip a leading `@` when
 * that literal path does not exist. `resolve(cwd, "@src/app.ts")` and
 * `resolve(cwd, "~/foo")` journal a different file than the tool writes.
 */
function normalizeWriteEditPath(input: string, cwd: string): string {
  let value = input;
  if (value.startsWith("@") && value.length > 1 && !existsSync(resolve(cwd, value))) {
    const stripped = value.slice(1);
    if (stripped.trim()) value = stripped;
  }
  return expandHomePrefix(value);
}

export function mutationPaths(toolName: string, input: unknown, cwd: string, sandboxed: boolean): string[] {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  let candidate: unknown;
  if (toolName === "write" || toolName === "edit") candidate = value.path;
  else if (toolName === "ts_morph") candidate = value.filePath;
  if (typeof candidate !== "string" || !candidate.trim()) return [];
  const normalized = toolName === "write" || toolName === "edit" ? normalizeWriteEditPath(candidate, cwd) : candidate;
  const path = canonicalMutationPath(normalized, cwd);
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

type WordToken = { kind: "word"; value: string; quoted: boolean };
type ShellToken = WordToken | { kind: "op"; value: string };

/** Lightweight shell lexer: splits words and control/redirection operators while respecting quotes. */
function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      tokens.push({ kind: "op", value: ";" });
      i += 1;
      continue;
    }
    if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
      tokens.push({ kind: "op", value: ch + ch });
      i += 2;
      continue;
    }
    if (ch === "|") {
      tokens.push({ kind: "op", value: "|" });
      i += 1;
      continue;
    }
    // Redirections: >, >>, >|, &>, &>>, 1>, 1>>, 2>, 2>>
    const redir = /^(?:[12&]?>>|[12&]?>\|?)/.exec(command.slice(i));
    if (redir) {
      tokens.push({ kind: "op", value: redir[0] });
      i += redir[0].length;
      continue;
    }
    if (ch === "&" || ch === "<") {
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }
    let value = "";
    let quoted = false;
    while (i < n) {
      const c = command[i]!;
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === ";" || c === "|" || c === "&" || c === ">" || c === "<") break;
      if (c === "'" || c === '"') {
        quoted = true;
        const quote = c;
        i += 1;
        while (i < n && command[i] !== quote) {
          if (quote === '"' && command[i] === "\\" && i + 1 < n && ['"', "$", "`", "\n"].includes(command[i + 1]!)) {
            i += 1;
            value += command[i]!;
          } else {
            value += command[i]!;
          }
          i += 1;
        }
        if (i < n && command[i] === quote) i += 1;
        continue;
      }
      if (c === "\\" && i + 1 < n && command[i + 1] !== "\n") {
        i += 1;
        value += command[i]!;
        i += 1;
        continue;
      }
      value += c;
      i += 1;
    }
    if (value || quoted) tokens.push({ kind: "word", value, quoted });
  }
  return tokens;
}

const OUTPUT_REDIR_OPS = new Set([">", ">>", ">|", "1>", "1>>", "1>|", "2>", "2>>", "2>|", "&>", "&>>", "&>|"]);
const SEGMENT_BREAK_OPS = new Set([";", "&&", "||", "|", "&"]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function isDynamicOrNonPathToken(value: string): boolean {
  if (!value || value === "-" || value.startsWith("&")) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return true; // URL
  if (/[$`*?\[\]]/.test(value)) return true; // shell variable, command subst, glob
  return false;
}

function resolveShellPath(raw: string, cwd: string, platform: string): string | undefined {
  let value = raw.trim();
  if (isDynamicOrNonPathToken(value)) return undefined;
  const home = platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  // `cd ~/x` is expanded by the shell; resolving it literally produced <cwd>/~/x.
  if (platform !== "win32" && home && (value === "~" || value.startsWith("~/"))) value = home + value.slice(1);
  else if (value.startsWith("~")) return undefined;
  const windows = platform === "win32" && !value.startsWith("/") && win32.isAbsolute(value);
  const resolved = windows ? win32.normalize(value) : resolve(cwd, value);
  const root = windows ? win32.parse(resolved).root : "/";
  if (resolved.toLowerCase() === root.toLowerCase() || (home && resolved.toLowerCase() === home.toLowerCase())) return undefined;
  if (!windows && isNonWorkspacePath(resolved)) return undefined;
  return resolved;
}

type ShellSegment = { tokens: ShellToken[]; joiner: "first" | "&&" | ";" | "||" | "|" | "&" };

function splitSegments(tokens: ShellToken[]): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let current: ShellToken[] = [];
  let pendingJoiner: ShellSegment["joiner"] = "first";
  for (const token of tokens) {
    if (token.kind === "op" && SEGMENT_BREAK_OPS.has(token.value)) {
      if (current.length) { segments.push({ tokens: current, joiner: pendingJoiner }); current = []; }
      pendingJoiner = token.value as ShellSegment["joiner"];
    } else {
      current.push(token);
    }
  }
  if (current.length) segments.push({ tokens: current, joiner: pendingJoiner });
  return segments;
}

function collectOperands(args: WordToken[], optionsWithArg: ReadonlySet<string> = new Set()): string[] {
  const operands: string[] = [];
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i]!;
    if (tok.kind !== "word") continue;
    const v = tok.value;
    if (!afterDoubleDash && v === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && v.startsWith("-") && v.length > 1) {
      if (optionsWithArg.has(v)) i += 1;
      continue;
    }
    operands.push(v);
  }
  return operands;
}

function parseBashHints(command: string, cwd: string, platform: string): { all: string[]; fileTargets: string[] } {
  const all = new Set<string>();
  const fileTargets = new Set<string>();
  let effectiveCwd = cwd;

  const addHint = (raw: string, isFileTarget = false, baseDir = effectiveCwd): string | undefined => {
    const resolved = resolveShellPath(raw, baseDir, platform);
    if (!resolved) return undefined;
    all.add(resolved);
    if (isFileTarget) fileTargets.add(resolved);
    return resolved;
  };

  const segments = splitSegments(tokenizeShell(command));
  for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
    const { tokens: segment } = segments[segIdx]!;
    // A `cd` changes cwd for the NEXT segment only when that next segment runs
    // after a successful cd: `cd && sed` / `cd ; sed`. For `cd || sed` the sed
    // runs in the ORIGINAL cwd (cd failed), so it must not inherit the new cwd.
    const nextJoiner = segments[segIdx + 1]?.joiner;
    const cdCarries = nextJoiner === undefined || nextJoiner === ";" || nextJoiner === "&&";
    // 1. Redirection targets (`> file`, `>> file`, etc.) and strip redirections from command words.
    const words: WordToken[] = [];
    for (let i = 0; i < segment.length; i += 1) {
      const tok = segment[i]!;
      if (tok.kind === "op" && OUTPUT_REDIR_OPS.has(tok.value)) {
        const next = segment[i + 1];
        if (next?.kind === "word") {
          addHint(next.value, true);
          i += 1;
        }
        continue;
      }
      if (tok.kind === "op" && tok.value === "<") {
        const next = segment[i + 1];
        if (next?.kind === "word") {
          if (isAbsolute(next.value) || (platform === "win32" && !next.value.startsWith("/") && win32.isAbsolute(next.value))) {
            addHint(next.value, false);
          }
          i += 1;
        }
        continue;
      }
      if (tok.kind === "word") words.push(tok);
    }

    // 2. Always collect any explicit absolute path tokens (POSIX or Windows).
    for (const tok of words) {
      if (tok.kind !== "word") continue;
      if (isAbsolute(tok.value) || (platform === "win32" && !tok.value.startsWith("/") && win32.isAbsolute(tok.value))) {
        addHint(tok.value, false);
      }
    }

    // Skip leading env assignments (`FOO=1 cmd ...`) and wrappers (`env`, `sudo`, `command`).
    let cmdIdx = 0;
    while (cmdIdx < words.length) {
      const w = words[cmdIdx]!.value;
      if (ENV_ASSIGN.test(w) || w === "env" || w === "command") {
        cmdIdx += 1;
        continue;
      }
      if (w === "sudo") {
        cmdIdx += 1;
        while (cmdIdx < words.length && words[cmdIdx]!.value.startsWith("-")) cmdIdx += 1;
        continue;
      }
      break;
    }
    if (cmdIdx >= words.length) continue;

    const rawCmd = words[cmdIdx]!.value;
    const cmd = basename(rawCmd).toLowerCase();
    const args = words.slice(cmdIdx + 1);

    if (cmd === "cd") {
      const operands = collectOperands(args);
      if (operands[0]) {
        const target = addHint(operands[0], false, effectiveCwd);
        // Only carry the new cwd into segments guaranteed to run after a successful
        // `cd`. `cd sub || sed ...` runs sed in the ORIGINAL cwd when cd fails.
        if (target && cdCarries) effectiveCwd = target;
      }
      continue;
    }

    if (cmd === "git") {
      let gitBase: string | undefined;
      for (let i = 0; i + 1 < args.length; i += 1) {
        if (args[i]!.value === "-C") {
          gitBase = addHint(args[i + 1]!.value, false, effectiveCwd);
          i += 1;
        }
      }
      // `git -C <dir> rm/unlink ...` operates on files relative to <dir>.
      // Resolve those operands against gitBase so they are journaled correctly.
      const sub = args.find((w) => w.kind === "word" && ["rm", "mv", "cp"].includes(w.value.toLowerCase()));
      if (gitBase && sub) {
        const subIdx = args.indexOf(sub);
        for (const op of collectOperands(args.slice(subIdx + 1))) addHint(op, true, gitBase);
      }
      continue;
    }

    if (cmd === "rm" || cmd === "unlink" || cmd === "shred" || cmd === "rmdir") {
      for (const op of collectOperands(args)) addHint(op, cmd !== "rmdir");
      continue;
    }

    if (cmd === "mv") {
      let targetDir: string | undefined;
      for (let i = 0; i < args.length; i += 1) {
        const v = args[i]!.value;
        if (v === "-t" && i + 1 < args.length) targetDir = args[i + 1]!.value;
        else if (v.startsWith("--target-directory=")) targetDir = v.slice("--target-directory=".length);
      }
      const operands = collectOperands(args, new Set(["-t", "-S", "--target-directory", "--suffix"]));
      if (targetDir) {
        const dir = addHint(targetDir, false);
        for (const op of operands) {
          addHint(op, true);
          if (dir) addHint(join(dir, basename(op)), true);
        }
      } else if (operands.length >= 2) {
        const last = operands.at(-1)!;
        const resolvedLast = resolveShellPath(last, effectiveCwd, platform);
        const destIsDir = resolvedLast !== undefined && existsSync(resolvedLast) && lstatSync(resolvedLast).isDirectory();
        if (destIsDir && resolvedLast) {
          all.add(resolvedLast);
          for (let i = 0; i < operands.length - 1; i += 1) {
            const src = operands[i]!;
            addHint(src, true);
            addHint(join(resolvedLast, basename(src)), true);
          }
        } else {
          for (const op of operands) addHint(op, true);
        }
      } else {
        for (const op of operands) addHint(op, true);
      }
      continue;
    }

    if (cmd === "cp" || cmd === "install") {
      let targetDir: string | undefined;
      for (let i = 0; i < args.length; i += 1) {
        const v = args[i]!.value;
        if (v === "-t" && i + 1 < args.length) targetDir = args[i + 1]!.value;
        else if (v.startsWith("--target-directory=")) targetDir = v.slice("--target-directory=".length);
      }
      const operands = collectOperands(args, new Set(["-t", "-S", "-m", "-o", "-g", "--target-directory", "--suffix"]));
      if (targetDir) {
        const dir = addHint(targetDir, false);
        for (const op of operands) {
          addHint(op, false);
          if (dir) addHint(join(dir, basename(op)), true);
        }
      } else if (operands.length >= 2) {
        const last = operands.at(-1)!;
        const resolvedLast = resolveShellPath(last, effectiveCwd, platform);
        const destIsDir = resolvedLast !== undefined && existsSync(resolvedLast) && lstatSync(resolvedLast).isDirectory();
        if (destIsDir && resolvedLast) {
          all.add(resolvedLast);
          for (let i = 0; i < operands.length - 1; i += 1) {
            const src = operands[i]!;
            addHint(src, false);
            addHint(join(resolvedLast, basename(src)), true);
          }
        } else {
          for (let i = 0; i < operands.length - 1; i += 1) addHint(operands[i]!, false);
          addHint(last, true);
        }
      }
      continue;
    }

    if (cmd === "sed") {
      let inPlace = false;
      let hasScriptFlag = false;
      const operands: string[] = [];
      let afterDoubleDash = false;
      for (let i = 0; i < args.length; i += 1) {
        const v = args[i]!.value;
        if (!afterDoubleDash && v === "--") {
          afterDoubleDash = true;
          continue;
        }
        if (!afterDoubleDash && v.startsWith("-") && v.length > 1) {
          if (v === "-i" || v.startsWith("-i") || v === "--in-place" || v.startsWith("--in-place=")) {
            inPlace = true;
            // BSD sed: `sed -i '' 's/a/b/' file` passes an empty backup suffix as next arg.
            if (v === "-i" && i + 1 < args.length && args[i + 1]!.quoted && args[i + 1]!.value === "") i += 1;
            continue;
          }
          if (v === "-e" || v === "-f" || v === "--expression" || v === "--file") {
            hasScriptFlag = true;
            i += 1;
            continue;
          }
          if (v.startsWith("--expression=") || v.startsWith("--file=")) {
            hasScriptFlag = true;
            continue;
          }
          continue;
        }
        operands.push(v);
      }
      if (inPlace) {
        const files = hasScriptFlag ? operands : operands.slice(1);
        for (const file of files) addHint(file, true);
      }
      continue;
    }

    if (cmd === "perl") {
      let inPlace = false;
      const operands: string[] = [];
      let afterDoubleDash = false;
      for (let i = 0; i < args.length; i += 1) {
        const v = args[i]!.value;
        if (!afterDoubleDash && v === "--") {
          afterDoubleDash = true;
          continue;
        }
        if (!afterDoubleDash && v.startsWith("-") && v.length > 1) {
          if (/^-[a-zA-Z]*i/.test(v)) inPlace = true;
          if (v === "-e" || v === "-E" || /^-[a-zA-Z]*[eE]$/.test(v)) i += 1;
          continue;
        }
        operands.push(v);
      }
      if (inPlace) {
        for (const file of operands) addHint(file, true);
      }
      continue;
    }

    if (cmd === "tee") {
      for (const op of collectOperands(args)) addHint(op, true);
      continue;
    }

    if (cmd === "truncate") {
      for (const op of collectOperands(args, new Set(["-s", "--size", "-r", "--reference"]))) addHint(op, true);
      continue;
    }

    if (cmd === "touch") {
      for (const op of collectOperands(args, new Set(["-d", "-r", "-t", "--date", "--reference"]))) addHint(op, true);
      continue;
    }

    if (cmd === "chmod" || cmd === "chown") {
      const operands = collectOperands(args, new Set(["--reference"]));
      for (const op of operands.slice(1)) addHint(op, true);
      continue;
    }

    if (cmd === "dd") {
      for (const tok of args) {
        if (tok.value.startsWith("of=")) addHint(tok.value.slice(3), true);
      }
      continue;
    }
  }

  return { all: [...all], fileTargets: [...fileTargets] };
}

/** Conservative hints only; arbitrary shell side effects cannot be inferred statically. */
export function bashPathHints(command: string, cwd: string, platform: string = process.platform): string[] {
  return parseBashHints(command, cwd, platform).all;
}

/**
 * Statically resolvable file mutation targets of a shell command (`rm`, `sed -i`,
 * `mv`, `cp` dest, `tee`, `truncate`, `dd of=`, `>`/`>>` redirections). Used for
 * lightweight per-file blob pre-snapshots without taking a full git tree snapshot.
 */
export function bashFileMutationHints(command: string, cwd: string, platform: string = process.platform): string[] {
  return parseBashHints(command, cwd, platform).fileTargets;
}
