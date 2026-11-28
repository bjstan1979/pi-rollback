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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

export type SshConfigBindStatus =
  | "skipped-empty"
  | "bound"
  | "rejected"
  | "bind-failed"
  | "remount-ro-failed";

export interface SshConfigPrepResult {
  status: "skipped-empty" | "staged" | "rejected";
  count: number;
  stagingDir?: string;
  reason?: string;
}

export interface OverlayExecResult {
  exitCode: number | null;
  mounted: boolean;
  aborted: boolean;
  timedOut: boolean;
  baseDir: string;
  upperDir: string;
  deletedRelPaths: string[];
  sshConfigStatus?: SshConfigBindStatus;
  sshConfigDetail?: string;
  cleanup: () => void;
}

export type OverlayProbeReason =
  | "ok"
  | "non-linux"
  | "no-host-uid-gid"
  | "outer-unshare-denied"
  | "outer-mount-failed"
  | "inner-unshare-unsupported-flag"
  | "inner-unshare-denied"
  | "inner-write-failed"
  | "probe-error";

export interface OverlayProbeResult {
  supported: boolean;
  reason: OverlayProbeReason;
  detail?: string;
}

let cachedProbeResult: OverlayProbeResult | undefined;

function getHostUidGid(): { uid: number; gid: number } | undefined {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (typeof uid !== "number" || typeof gid !== "number") return undefined;
  return { uid, gid };
}

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

function isUsernsPermissionError(stderr: string): boolean {
  return /uid_map|gid_map|operation not permitted|permission denied|不允许的操作|权限不够/i.test(stderr);
}

/**
 * Probe once per process whether two-layer unprivileged OverlayFS works on this host:
 *   1. Outer `unshare -rm` mounts OverlayFS (userns#1 uid 0 owns mntns#1).
 *   2. Inner `unshare --user --map-user=<uid> --map-group=<gid>` inherits mntns#1
 *      and writes as the real host uid/gid with zero root privileges.
 * Distinguishes AppArmor/userns denial from kernel mount failure or old util-linux (< 2.38).
 */
export function probeOverlaySupport(forceReprobe = false): OverlayProbeResult {
  if (!forceReprobe && cachedProbeResult !== undefined) return cachedProbeResult;
  if (process.platform !== "linux") {
    cachedProbeResult = { supported: false, reason: "non-linux" };
    return cachedProbeResult;
  }
  const host = getHostUidGid();
  if (!host) {
    cachedProbeResult = { supported: false, reason: "no-host-uid-gid" };
    return cachedProbeResult;
  }
  const base = mkdtempSync(join(tmpdir(), "pi-rb-ovl-probe-"));
  try {
    const lower = join(base, "l");
    const upper = join(base, "u");
    const work = join(base, "w");
    const mountedFlag = join(base, "mounted");
    mkdirSync(lower, { recursive: true });
    mkdirSync(upper, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(lower, "a"), "ok\n");
    const opts = `lowerdir=${lower},upperdir=${upper},workdir=${work},userxattr`;
    const probeScript = [
      'mount -t overlay overlay -o "$1" "$2" || exit 121',
      'cd -P "$2" || exit 121',
      ': > "$3"',
      `unshare --user --map-user="$4" --map-group="$5" -- sh -c '[ "$(id -u)" = "$1" ] && [ "$(id -g)" = "$2" ] && echo new > a' _ "$4" "$5"`,
    ].join("; ");
    const res = spawnSync(
      "unshare",
      ["-rm", "sh", "-c", probeScript, "_", opts, lower, mountedFlag, String(host.uid), String(host.gid)],
      { timeout: 5_000, encoding: "utf8" },
    );
    const stderr = (res.stderr ?? "").trim();
    if (res.error) {
      cachedProbeResult = { supported: false, reason: "probe-error", detail: res.error.message };
      return cachedProbeResult;
    }
    const outerMounted = existsSync(mountedFlag);
    if (!outerMounted) {
      if (res.status === 121) {
        cachedProbeResult = { supported: false, reason: "outer-mount-failed", detail: stderr || undefined };
      } else {
        cachedProbeResult = {
          supported: false,
          reason: isUsernsPermissionError(stderr) ? "outer-unshare-denied" : "outer-mount-failed",
          detail: stderr || undefined,
        };
      }
      return cachedProbeResult;
    }
    if (res.status !== 0) {
      if (/unrecognized option|invalid option|--map-user|--map-group/i.test(stderr)) {
        cachedProbeResult = { supported: false, reason: "inner-unshare-unsupported-flag", detail: stderr };
      } else if (isUsernsPermissionError(stderr)) {
        cachedProbeResult = { supported: false, reason: "inner-unshare-denied", detail: stderr };
      } else {
        cachedProbeResult = { supported: false, reason: "inner-write-failed", detail: stderr || undefined };
      }
      return cachedProbeResult;
    }
    const upperFile = join(upper, "a");
    const ok = existsSync(upperFile)
      && readFileSync(upperFile, "utf8").trim() === "new"
      && readFileSync(join(lower, "a"), "utf8").trim() === "ok"
      && lstatSync(upperFile).uid === host.uid
      && lstatSync(upperFile).gid === host.gid;
    cachedProbeResult = ok
      ? { supported: true, reason: "ok" }
      : { supported: false, reason: "inner-write-failed", detail: "upper file missing, content mismatch, or host uid/gid mismatch" };
    return cachedProbeResult;
  } catch (error) {
    cachedProbeResult = {
      supported: false,
      reason: "probe-error",
      detail: error instanceof Error ? error.message : String(error),
    };
    return cachedProbeResult;
  } finally {
    cleanupOverlayDir(base);
  }
}

/** Probe once per process whether two-layer unprivileged OverlayFS works on this kernel. */
export function isOverlaySupported(forceReprobe = false): boolean {
  return probeOverlaySupport(forceReprobe).supported;
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

const MAX_SSH_DROPIN_BYTES = 256 * 1024;
const DEFAULT_ALLOWED_SSH_SYMLINK_PREFIXES = [
  "/etc/ssh",
  "/usr/lib/systemd/ssh_config.d",
  "/lib/systemd/ssh_config.d",
  "/usr/share/openssh",
  "/run/ssh",
  "/run/systemd",
];

function isPathUnderPrefix(target: string, prefix: string): boolean {
  const rel = relative(prefix, target);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/**
 * Stage `/etc/ssh/ssh_config.d/*.conf` as user-owned 0644 copies for read-only
 * bind-mounting inside the overlay mount namespace.
 *
 * Security invariants (fail-closed):
 * - Empty or missing source dir -> `skipped-empty` (zero mount overhead on WSL).
 * - Every `*.conf` entry must validate and copy cleanly; if ANY entry is unreadable,
 *   non-regular (FIFO/device/dir), oversized (>256 KiB), a broken symlink, or a
 *   symlink escaping trusted system prefixes, staging is aborted and removed so ssh
 *   never runs against a silently truncated policy set.
 */
export function prepareSshConfigDropins(
  sourceDir: string,
  stagingDir: string,
  allowedSymlinkPrefixes: readonly string[] = DEFAULT_ALLOWED_SSH_SYMLINK_PREFIXES,
): SshConfigPrepResult {
  if (!existsSync(sourceDir)) return { status: "skipped-empty", count: 0 };
  let srcStat: ReturnType<typeof lstatSync>;
  try {
    srcStat = statSync(sourceDir);
  } catch (error) {
    return { status: "rejected", count: 0, reason: `stat sourceDir failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!srcStat.isDirectory()) return { status: "skipped-empty", count: 0 };

  let names: string[];
  try {
    names = readdirSync(sourceDir).filter((name) => name.endsWith(".conf")).sort();
  } catch (error) {
    return { status: "rejected", count: 0, reason: `readdir failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (names.length === 0) return { status: "skipped-empty", count: 0 };

  const canonicalSource = realpathSync(sourceDir);
  const canonicalPrefixes = new Set<string>([canonicalSource]);
  for (const prefix of allowedSymlinkPrefixes) {
    try {
      canonicalPrefixes.add(existsSync(prefix) ? realpathSync(prefix) : resolve(prefix));
    } catch {
      canonicalPrefixes.add(resolve(prefix));
    }
  }

  const stagedFiles: Array<{ name: string; content: Buffer }> = [];
  for (const name of names) {
    const entryPath = join(sourceDir, name);
    let lst: ReturnType<typeof lstatSync>;
    try {
      lst = lstatSync(entryPath);
    } catch (error) {
      return { status: "rejected", count: 0, reason: `lstat failed on ${name}: ${error instanceof Error ? error.message : String(error)}` };
    }

    let resolvedPath = entryPath;
    if (lst.isSymbolicLink()) {
      try {
        resolvedPath = realpathSync(entryPath);
      } catch {
        return { status: "rejected", count: 0, reason: `broken symlink: ${name}` };
      }
      const allowed = [...canonicalPrefixes].some((prefix) => isPathUnderPrefix(resolvedPath, prefix));
      if (!allowed) {
        return { status: "rejected", count: 0, reason: `symlink target outside allowed prefixes: ${name} -> ${resolvedPath}` };
      }
    } else if (!lst.isFile()) {
      return { status: "rejected", count: 0, reason: `non-regular drop-in entry: ${name}` };
    }

    let targetStat: ReturnType<typeof statSync>;
    try {
      targetStat = statSync(resolvedPath);
    } catch (error) {
      return { status: "rejected", count: 0, reason: `stat target failed on ${name}: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!targetStat.isFile()) {
      return { status: "rejected", count: 0, reason: `target is not a regular file: ${name} -> ${resolvedPath}` };
    }
    if (targetStat.size > MAX_SSH_DROPIN_BYTES) {
      return { status: "rejected", count: 0, reason: `drop-in exceeds ${MAX_SSH_DROPIN_BYTES} bytes: ${name} (${targetStat.size})` };
    }

    try {
      const content = readFileSync(resolvedPath);
      if (content.length > MAX_SSH_DROPIN_BYTES) {
        return { status: "rejected", count: 0, reason: `drop-in read exceeds ${MAX_SSH_DROPIN_BYTES} bytes: ${name}` };
      }
      stagedFiles.push({ name, content });
    } catch (error) {
      return { status: "rejected", count: 0, reason: `read failed on ${name}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  try {
    mkdirSync(stagingDir, { recursive: true, mode: 0o755 });
    chmodSync(stagingDir, 0o755);
    for (const file of stagedFiles) {
      const dest = join(stagingDir, file.name);
      writeFileSync(dest, file.content, { mode: 0o644 });
      chmodSync(dest, 0o644);
    }
    return { status: "staged", count: stagedFiles.length, stagingDir };
  } catch (error) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    return { status: "rejected", count: 0, reason: `stage write failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Bootstrap script executed inside outer `unshare -rm` (userns#1 uid 0 owning mntns#1).
// Args: $1=mountOpts $2=lower $3=origBind $4=upper $5=deletedList $6=mountedMarker $7=shellPath $8=command $9=hostUid ${10}=hostGid ${11}=sshStagedDir ${12}=sshDiagFile
// 1. Bind-mounts untouched lowerdir at $origBind.
// 2. Mounts OverlayFS directly over $lower so pwd and absolute paths under cwd stay identical.
// 3. Enters an inner user namespace (`unshare --user --map-user=$9 --map-group=${10}`, WITHOUT `-m`)
//    that inherits mntns#1 with identity mapping back to the real host uid/gid and zero root caps.
//    Touches $mountedMarker right inside the inner namespace before `exec`ing the user's shell,
//    so caller only marks `mounted=true` once both namespaces and the overlay are active.
// 4. After the inner command exits, outer userns#1 (still holding mntns#1) scans directories in
//    $upper (including opaque dirs from `rm -rf d && mkdir d`) and records vanished entries into
//    $deletedList (NUL-delimited).
const OVERLAY_BOOTSTRAP = `
mount --bind "$2" "$3" || exit 125
mount -t overlay overlay -o "$1" "$2" || exit 125
cd -P "$2" || exit 125
export PWD="$2"
if [ -n "\${11}" ] && [ -d /etc/ssh/ssh_config.d ]; then
  if ssh_err=$(mount --bind "\${11}" /etc/ssh/ssh_config.d 2>&1); then
    if ! ssh_ro_err=$(mount -o remount,ro,bind /etc/ssh/ssh_config.d 2>&1); then
      printf 'remount-ro-failed:%s\n' "$ssh_ro_err" > "\${12}"
    fi
  else
    printf 'bind-failed:%s\n' "$ssh_err" > "\${12}"
  fi
fi
unshare --user --map-user="$9" --map-group="\${10}" -- sh -c ': > "$1" || exit 125; exec "$2" -c "$3"' _ "$6" "$7" "$8"
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
  const sshConfigDir = join(baseDir, "ssh_config.d");
  const sshDiagFile = join(baseDir, "ssh-bind.diag");
  const sshPrep = prepareSshConfigDropins("/etc/ssh/ssh_config.d", sshConfigDir);
  const sshBindArg = sshPrep.status === "staged" ? sshConfigDir : "";
  mkdirSync(upperDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(origDir, { recursive: true });

  const mountOpts = `lowerdir=${lower},upperdir=${upperDir},workdir=${workDir},userxattr`;
  const shellPath = options.shellPath || process.env.SHELL || "/bin/bash";
  const actualShell = existsSync(shellPath) ? shellPath : "/bin/sh";

  let aborted = false;
  let timedOut = false;

  const host = getHostUidGid();
  if (!host) {
    cleanupOverlayDir(baseDir);
    throw new Error("Host uid/gid unavailable for two-namespace OverlayFS execution");
  }

  const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "unshare",
      [
        "-rm",
        "bash",
        "-c",
        OVERLAY_BOOTSTRAP,
        "_",
        mountOpts,
        lower,
        origDir,
        upperDir,
        deletedList,
        mountedMarker,
        actualShell,
        command,
        String(host.uid),
        String(host.gid),
        sshBindArg,
        sshDiagFile,
      ],
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

  let sshConfigStatus: SshConfigBindStatus;
  let sshConfigDetail: string | undefined;
  if (sshPrep.status === "skipped-empty") {
    sshConfigStatus = "skipped-empty";
  } else if (sshPrep.status === "rejected") {
    sshConfigStatus = "rejected";
    sshConfigDetail = sshPrep.reason;
  } else if (existsSync(sshDiagFile)) {
    const diag = readFileSync(sshDiagFile, "utf8").trim();
    if (diag.startsWith("remount-ro-failed:")) {
      sshConfigStatus = "remount-ro-failed";
      sshConfigDetail = diag.slice("remount-ro-failed:".length).trim();
    } else {
      sshConfigStatus = "bind-failed";
      sshConfigDetail = diag.replace(/^bind-failed:/, "").trim();
    }
  } else {
    sshConfigStatus = "bound";
  }

  return {
    exitCode,
    mounted: existsSync(mountedMarker),
    aborted,
    timedOut,
    baseDir,
    upperDir,
    deletedRelPaths,
    sshConfigStatus,
    sshConfigDetail,
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
