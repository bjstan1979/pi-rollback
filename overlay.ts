/**
 * Transactional OverlayFS execution layer for `bash` on Linux.
 *
 * Runs each shell command inside an unprivileged mount namespace (`unshare -rm`)
 * with an OverlayFS mounted directly over `cwd`. The command sees the real `cwd`
 * path (both relative and absolute paths under `cwd` work identically), while all
 * writes, creations, renames, and deletions land in a temporary `upperdir`.
 *
 * - On normal completion: only the paths actually touched in `upperdir` are
 *   committed back to `cwd`, with each modified/deleted original file stored as a
 *   content-addressed blob in `BLOB_ROOT` (`FileMutation`). Disk usage is strictly
 *   O(changed bytes), even inside `$HOME/.pi/agent` with dozens of nested repos.
 * - On abort (`signal.aborted`): `upperdir` is discarded untouched — true
 *   transactional abort with zero partial writes on disk.
 * - On unsupported hosts (macOS, Windows, restricted containers): cleanly reports
 *   unsupported so `pi-rollback` falls back to its whitelist + blob path.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  BLOB_ROOT,
  captureFileState,
  type FileState,
  isNonWorkspacePath,
  isWithin,
  restoreFileState,
  sameFileState,
} from "./journal.js";

export interface OverlayFileChange {
  path: string;
  before: FileState;
  after: FileState;
}

export interface OverlayExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  shellPath?: string;
}

export interface OverlayExecResult {
  exitCode: number | null;
  mounted: boolean;
  aborted: boolean;
  timedOut: boolean;
  baseDir: string;
  upperDir: string;
  deletedRelPaths: string[];
  cleanup: () => void;
}

let cachedOverlaySupport: boolean | undefined;

/** Recursively restore write/search bits on `work/` (OverlayFS creates `work/work` with mode 0000). */
function makeRemovable(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      chmodSync(dir, 0o700);
      for (const name of readdirSync(dir)) makeRemovable(join(dir, name));
    }
  } catch {}
}

export function cleanupOverlayDir(baseDir: string): void {
  try {
    makeRemovable(join(baseDir, "work"));
    makeRemovable(join(baseDir, "upper"));
  } catch {}
  try {
    rmSync(baseDir, { recursive: true, force: true });
  } catch {}
}

/** Probe once per process whether unprivileged `unshare -rm` + OverlayFS works on this kernel. */
export function isOverlaySupported(forceReprobe = false): boolean {
  if (!forceReprobe && cachedOverlaySupport !== undefined) return cachedOverlaySupport;
  if (process.platform !== "linux") {
    cachedOverlaySupport = false;
    return false;
  }
  const base = mkdtempSync(join(tmpdir(), "pi-rb-ovl-probe-"));
  try {
    const lower = join(base, "l");
    const upper = join(base, "u");
    const work = join(base, "w");
    mkdirSync(lower, { recursive: true });
    mkdirSync(upper, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(lower, "a"), "ok\n");
    const opts = `lowerdir=${lower},upperdir=${upper},workdir=${work},userxattr`;
    const res = spawnSync(
      "unshare",
      [
        "-rm",
        "sh",
        "-c",
        'mount -t overlay overlay -o "$1" "$2" && cd "$2" && echo new > a',
        "_",
        opts,
        lower,
      ],
      { timeout: 5_000, stdio: "ignore" },
    );
    cachedOverlaySupport = res.status === 0
      && existsSync(join(upper, "a"))
      && readFileSync(join(upper, "a"), "utf8").trim() === "new"
      && readFileSync(join(lower, "a"), "utf8").trim() === "ok";
    return cachedOverlaySupport;
  } catch {
    cachedOverlaySupport = false;
    return false;
  } finally {
    cleanupOverlayDir(base);
  }
}

/**
 * Resolve PI_ROLLBACK_OVERLAY_BASH from env (precedence) or settings.json.
 * Defaults to `true` on Linux and `false` on non-Linux platforms.
 */
export function parseOverlayEnabled(settingsPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const parseBool = (value: unknown): boolean | undefined => {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value === "string") {
      const norm = value.trim().toLowerCase();
      if (norm === "1" || norm === "true") return true;
      if (norm === "0" || norm === "false") return false;
    }
    return undefined;
  };
  if (env.PI_ROLLBACK_OVERLAY_BASH !== undefined) {
    return parseBool(env.PI_ROLLBACK_OVERLAY_BASH) ?? (process.platform === "linux");
  }
  if (existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const val = parseBool((parsed as Record<string, unknown>).PI_ROLLBACK_OVERLAY_BASH);
        if (val !== undefined) return val;
      }
    } catch {}
  }
  return process.platform === "linux";
}

/** Whether `cwd` is a valid, safe OverlayFS `lowerdir` (cannot be `/`, pseudo-fs, or contain tmpdir). */
export function canUseOverlayForCwd(cwd: string, tempParent: string = tmpdir()): boolean {
  if (process.platform !== "linux") return false;
  if (!existsSync(cwd)) return false;
  let canonical: string;
  try {
    const st = lstatSync(cwd);
    if (!st.isDirectory()) return false;
    canonical = realpathSync(cwd);
  } catch {
    return false;
  }
  if (dirname(canonical) === canonical) return false;
  if (isNonWorkspacePath(canonical)) return false;
  // OverlayFS forbids commas/colons in unescaped lowerdir mount options; fall back cleanly if present.
  if (canonical.includes(",") || canonical.includes(":")) return false;
  // upperdir/workdir live in tempParent and must never sit inside lowerdir.
  const canonicalTmp = existsSync(tempParent) ? realpathSync(tempParent) : resolve(tempParent);
  if (isWithin(canonical, canonicalTmp)) return false;
  return true;
}

// Bootstrap script executed inside `unshare -rm`.
// Args: $1=mountOpts $2=lower $3=origBind $4=upper $5=deletedList $6=mountedMarker $7=shellPath $8=command $9=realHome
// 1. Bind-mounts untouched lowerdir at $origBind.
// 2. Mounts OverlayFS directly over $lower so pwd and absolute paths under cwd stay identical.
// 3. Touches $mountedMarker so caller knows the command actually entered the overlay.
// 4. Points uid 0's passwd home at the real user home. unshare -r is required to mount
//    overlay, but getpwuid(0) must not send ssh and similar tools to /root.
// 5. Runs the user's command and captures its exit code.
// 6. For any directory present in $upper (including opaque dirs from `rm -rf d && mkdir d`),
//    records entries that existed in $origBind but vanished from $lower into $deletedList (NUL-delimited).
const OVERLAY_BOOTSTRAP = `
mount --bind "$2" "$3" || exit 125
mount -t overlay overlay -o "$1" "$2" || exit 125
cd -P "$2" || exit 125
export PWD="$2"
: > "$6"
real_home="$HOME"
if [ -z "$real_home" ]; then real_home="$9"; fi
passwd_overlay=""
if [ -n "$real_home" ] && [ -f /etc/passwd ]; then
  passwd_overlay=$(mktemp)
  if awk -F: -v home="$real_home" 'BEGIN{OFS=":"} $3==0 {$6=home} {print}' /etc/passwd > "$passwd_overlay" && mount --bind "$passwd_overlay" /etc/passwd; then
    :
  else
    rm -f "$passwd_overlay"
    passwd_overlay=""
  fi
fi
"$7" -c "$8"
ec=$?
find "$4" -type d -print0 2>/dev/null | while IFS= read -r -d '' udir; do
  rel="\${udir#"$4"}"
  rel="\${rel#/}"
  if [ -n "$rel" ]; then
    orig_dir="$3/$rel"
    merged_dir="$2/$rel"
  else
    orig_dir="$3"
    merged_dir="$2"
  fi
  [ -d "$orig_dir" ] || continue
  for entry in "$orig_dir"/* "$orig_dir"/.[!.]* "$orig_dir"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="\${entry##*/}"
    if [ ! -e "$merged_dir/$name" ] && [ ! -L "$merged_dir/$name" ]; then
      if [ -n "$rel" ]; then
        printf '%s/%s\\0' "$rel" "$name" >> "$5"
      else
        printf '%s\\0' "$name" >> "$5"
      fi
    fi
  done
done
if [ -n "$passwd_overlay" ]; then rm -f "$passwd_overlay"; fi
exit "$ec"
`;

/** Execute `command` inside an isolated OverlayFS mounted over `cwd`. */
export async function execInOverlay(
  command: string,
  cwd: string,
  options: OverlayExecOptions,
): Promise<OverlayExecResult> {
  const lower = realpathSync(cwd);
  const baseDir = mkdtempSync(join(tmpdir(), "pi-rb-ovl-"));
  const upperDir = join(baseDir, "upper");
  const workDir = join(baseDir, "work");
  const origDir = join(baseDir, "orig");
  const deletedList = join(baseDir, "deleted.nul");
  const mountedMarker = join(baseDir, "mounted");
  mkdirSync(upperDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(origDir, { recursive: true });

  const mountOpts = `lowerdir=${lower},upperdir=${upperDir},workdir=${workDir},userxattr`;
  const shellPath = options.shellPath || process.env.SHELL || "/bin/bash";
  const actualShell = existsSync(shellPath) ? shellPath : "/bin/sh";

  let aborted = false;
  let timedOut = false;

  const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "unshare",
      ["-rm", "bash", "-c", OVERLAY_BOOTSTRAP, "_", mountOpts, lower, origDir, upperDir, deletedList, mountedMarker, actualShell, command, homedir()],
      {
        cwd: lower,
        env: { ...(options.env ?? process.env), PWD: lower },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const killGroup = () => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      setTimeout(() => {
        if (child.pid === undefined) return;
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }, 200).unref();
    };

    const onAbort = () => {
      aborted = true;
      killGroup();
    };

    if (options.signal?.aborted) {
      aborted = true;
      killGroup();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    if (options.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, options.timeout * 1000);
      timer.unref();
    }

    child.stdout?.on("data", (chunk: Buffer) => options.onData(chunk));
    child.stderr?.on("data", (chunk: Buffer) => options.onData(chunk));

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      rejectPromise(err);
    });

    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (code !== null) resolvePromise(code);
      else if (sig) resolvePromise(128 + (sig === "SIGKILL" ? 9 : sig === "SIGTERM" ? 15 : 1));
      else resolvePromise(null);
    });
  });

  let deletedRelPaths: string[] = [];
  if (existsSync(deletedList)) {
    try {
      const raw = readFileSync(deletedList, "utf8");
      deletedRelPaths = raw.split("\0").filter(Boolean);
    } catch {}
  }

  return {
    exitCode,
    mounted: existsSync(mountedMarker),
    aborted,
    timedOut,
    baseDir,
    upperDir,
    deletedRelPaths,
    cleanup: () => cleanupOverlayDir(baseDir),
  };
}

function isRollbackStoreRel(relPath: string): boolean {
  const norm = relPath.replaceAll("\\", "/");
  return /(?:^|\/)\.pi\/(?:\.rollback-snapshots|agent\/rollback-snapshots)(?:\/|$)/.test(norm);
}

function writeAtomicDurable(destPath: string, content: Buffer, mode: number): void {
  mkdirSync(dirname(destPath), { recursive: true });
  const temp = join(dirname(destPath), `.${basename(destPath)}.pi-ovl-${process.pid}-${randomUUID()}`);
  const fd = openSync(temp, "wx", mode);
  try {
    writeFileSync(fd, content);
    try {
      fchmodSync(fd, mode);
    } catch {
      chmodSync(temp, mode);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, destPath);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

/** Recursively collect every file and symlink inside `dir` before removing it, so deletions are rollback-able. */
function captureDirectoryFilesAsDeleted(dir: string, blobRoot: string, changes: Map<string, OverlayFileChange>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isDirectory()) {
      captureDirectoryFilesAsDeleted(full, blobRoot, changes);
    } else if (st.isFile() || st.isSymbolicLink()) {
      if (!changes.has(full)) {
        const before = captureFileState(full, blobRoot);
        changes.set(full, { path: full, before, after: { kind: "missing" } });
      }
    }
  }
}

function deleteLowerPath(lowerPath: string, blobRoot: string, changes: Map<string, OverlayFileChange>): void {
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(lowerPath);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    captureDirectoryFilesAsDeleted(lowerPath, blobRoot, changes);
    rmSync(lowerPath, { recursive: true, force: true });
  } else if (st.isFile() || st.isSymbolicLink()) {
    if (!changes.has(lowerPath)) {
      const before = captureFileState(lowerPath, blobRoot);
      changes.set(lowerPath, { path: lowerPath, before, after: { kind: "missing" } });
    }
    rmSync(lowerPath, { force: true });
  } else {
    rmSync(lowerPath, { force: true });
  }
}

/**
 * Commit all changes recorded in `upperDir` (plus `deletedRelPaths` from opaque
 * directories) back to `lowerDir`, returning exact per-file `before`/`after`
 * `FileState` diffs backed by `BLOB_ROOT`.
 */
export function commitOverlay(
  lowerDir: string,
  upperDir: string,
  deletedRelPaths: readonly string[],
  blobRoot = BLOB_ROOT,
): { changes: OverlayFileChange[]; touchedPaths: string[] } {
  const canonicalLower = realpathSync(lowerDir);
  const changes = new Map<string, OverlayFileChange>();
  const touched = new Set<string>();

  // Transaction: if any disk write fails part-way, restore every path captured
  // so far from its pre-committed blob before rethrowing. This prevents a
  // half-written lowerdir that has no matching rollback mutation record.
  const rollbackPartialCommit = (): void => {
    // Restore in reverse insertion order: a directory replaced by a file records
    // its children first and the parent path last, so the parent (recorded as
    // missing) must be removed before the children recreate the directory tree.
    const recorded = [...changes.values()];
    for (const change of recorded.reverse()) {
      try {
        restoreFileState(change.path, change.before, blobRoot);
      } catch {
        // Best-effort recovery; never mask the original commit failure.
      }
    }
  };

  try {
  // 1. Apply deletions discovered from opaque directories / whiteouts first,
  //    so recreated files in step 2 cleanly land on top of them.
  for (const rel of deletedRelPaths) {
    if (!rel || isRollbackStoreRel(rel)) continue;
    const lowerPath = resolve(canonicalLower, rel);
    if (!isWithin(canonicalLower, lowerPath) || lowerPath === canonicalLower) continue;
    // If upperDir recreated this exact path as a non-whiteout, step 2 handles replacement.
    const upperPath = resolve(upperDir, rel);
    let upperExists = false;
    try {
      const ust = lstatSync(upperPath);
      upperExists = !(ust.isCharacterDevice() && ust.rdev === 0);
    } catch {}
    if (upperExists) continue;
    deleteLowerPath(lowerPath, blobRoot, changes);
    touched.add(lowerPath);
  }

  // 2. Walk upperDir and commit creations, modifications, symlinks, and whiteouts.
  const walkUpper = (curUpper: string, curRel: string): void => {
    for (const name of readdirSync(curUpper)) {
      const rel = curRel ? join(curRel, name) : name;
      if (isRollbackStoreRel(rel)) continue;
      const upperPath = join(curUpper, name);
      const lowerPath = resolve(canonicalLower, rel);
      if (!isWithin(canonicalLower, lowerPath) || lowerPath === canonicalLower) continue;

      const ust = lstatSync(upperPath);

      // OverlayFS whiteout (char device 0:0): path was deleted.
      if (ust.isCharacterDevice() && ust.rdev === 0) {
        deleteLowerPath(lowerPath, blobRoot, changes);
        touched.add(lowerPath);
        continue;
      }

      if (ust.isDirectory()) {
        let lst: ReturnType<typeof lstatSync> | undefined;
        try { lst = lstatSync(lowerPath); } catch {}
        if (lst && !lst.isDirectory()) {
          // Regular file or symlink replaced by a directory.
          deleteLowerPath(lowerPath, blobRoot, changes);
        }
        if (!existsSync(lowerPath)) {
          mkdirSync(lowerPath, { recursive: true, mode: ust.mode & 0o777 });
        }
        walkUpper(upperPath, rel);
        continue;
      }

      if (ust.isSymbolicLink()) {
        const target = readlinkSync(upperPath);
        let lst: ReturnType<typeof lstatSync> | undefined;
        try { lst = lstatSync(lowerPath); } catch {}
        let before: FileState;
        if (lst?.isDirectory()) {
          captureDirectoryFilesAsDeleted(lowerPath, blobRoot, changes);
          rmSync(lowerPath, { recursive: true, force: true });
          before = { kind: "missing" };
        } else if (lst) {
          before = changes.get(lowerPath)?.before ?? captureFileState(lowerPath, blobRoot);
          // Record pre-state before mutating lowerPath so rollbackPartialCommit recovers it on failure.
          changes.set(lowerPath, { path: lowerPath, before, after: { kind: "missing" } });
          rmSync(lowerPath, { force: true });
        } else {
          before = changes.get(lowerPath)?.before ?? { kind: "missing" };
          changes.set(lowerPath, { path: lowerPath, before, after: { kind: "missing" } });
        }
        mkdirSync(dirname(lowerPath), { recursive: true });
        symlinkSync(target, lowerPath);
        touched.add(lowerPath);
        const after: FileState = { kind: "symlink", target };
        if (!sameFileState(before, after)) changes.set(lowerPath, { path: lowerPath, before, after });
        else changes.delete(lowerPath);
        continue;
      }

      if (ust.isFile()) {
        let lst: ReturnType<typeof lstatSync> | undefined;
        try { lst = lstatSync(lowerPath); } catch {}
        let before: FileState;
        if (lst?.isDirectory()) {
          // Directory replaced by a regular file.
          captureDirectoryFilesAsDeleted(lowerPath, blobRoot, changes);
          rmSync(lowerPath, { recursive: true, force: true });
          before = { kind: "missing" };
          changes.set(lowerPath, { path: lowerPath, before, after: { kind: "missing" } });
        } else if (lst?.isFile() || lst?.isSymbolicLink()) {
          before = changes.get(lowerPath)?.before ?? captureFileState(lowerPath, blobRoot);
          // Record pre-state before mutating lowerPath so rollbackPartialCommit recovers it on failure.
          changes.set(lowerPath, { path: lowerPath, before, after: { kind: "missing" } });
          if (lst.isSymbolicLink()) rmSync(lowerPath, { force: true });
        } else {
          before = changes.get(lowerPath)?.before ?? { kind: "missing" };
          changes.set(lowerPath, { path: lowerPath, before, after: { kind: "missing" } });
          if (lst) rmSync(lowerPath, { force: true });
        }
        const content = readFileSync(upperPath);
        writeAtomicDurable(lowerPath, content, ust.mode & 0o777);
        const after = captureFileState(lowerPath, blobRoot);
        touched.add(lowerPath);
        if (!sameFileState(before, after)) {
          changes.set(lowerPath, { path: lowerPath, before, after });
        } else {
          changes.delete(lowerPath);
        }
      }
    }
  };

    if (existsSync(upperDir)) walkUpper(upperDir, "");
  } catch (error) {
    rollbackPartialCommit();
    throw error;
  }

  return {
    changes: [...changes.values()],
    touchedPaths: [...touched],
  };
}
