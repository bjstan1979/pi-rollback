import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  canUseOverlayForCwd,
  commitOverlay,
  execInOverlay,
  isOverlaySupported,
  parseOverlayEnabled,
  prepareSshConfigDropins,
  probeOverlaySupport,
} from "./overlay.js";
import { captureFileState, restoreFileState } from "./journal.js";

const readlinkSafe = (p: string): string => readlinkSync(p);

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) {
    const dir = cleanup.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("parseOverlayEnabled defaults to true on Linux and honors env > settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rb-ovl-cfg-"));
  cleanup.push(dir);
  const settings = join(dir, "settings.json");
  assert.equal(parseOverlayEnabled(settings, {}), process.platform === "linux");
  writeFileSync(settings, JSON.stringify({ PI_ROLLBACK_OVERLAY_BASH: false }));
  assert.equal(parseOverlayEnabled(settings, {}), false);
  assert.equal(parseOverlayEnabled(settings, { PI_ROLLBACK_OVERLAY_BASH: "1" }), true);
  assert.equal(parseOverlayEnabled(settings, { PI_ROLLBACK_OVERLAY_BASH: "0" }), false);
});

test("probeOverlaySupport reports structured diagnostic for two-namespace OverlayFS", () => {
  const result = probeOverlaySupport(true);
  if (result.supported) {
    assert.equal(result.reason, "ok");
  } else {
    assert.notEqual(result.reason, "ok");
  }
  assert.equal(isOverlaySupported(), result.supported);
});

test("OverlayFS two-namespace execution preserves real host uid/gid, zero CapEff, passwd home, upper ownership, and opaque rollback", async (t) => {
  if (!isOverlaySupported()) {
    t.skip("unprivileged two-namespace OverlayFS not supported on this host");
    return;
  }
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  assert.equal(typeof hostUid, "number");
  assert.equal(typeof hostGid, "number");

  const home = realpathSync(homedir());
  const cwd = mkdtempSync(join(home, ".pi-rb-ovl-twons-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "pi-rb-ovl-twons-blobs-"));
  cleanup.push(cwd, blobRoot);

  mkdirSync(join(cwd, "sub"), { recursive: true });
  writeFileSync(join(cwd, "a.txt"), "before\n");
  writeFileSync(join(cwd, "sub", "old.txt"), "old-sub\n");

  const chunks: string[] = [];
  const res = await execInOverlay(
    [
      'echo "UID=$(id -u)"',
      'echo "GID=$(id -g)"',
      `echo "CAPEFF=$(awk '/^CapEff:/{print $2}' /proc/self/status)"`,
      'echo "PW_HOME=$(getent passwd "$(id -u)" | cut -d: -f6)"',
      'echo "after" > a.txt',
      'rm -rf sub && mkdir sub && echo "fresh" > sub/new.txt',
    ].join(" && "),
    cwd,
    { onData: (b) => chunks.push(b.toString("utf8")), env: { ...process.env, BASH_ENV: "" } },
  );
  try {
    assert.equal(res.mounted, true);
    assert.equal(res.aborted, false);
    assert.equal(res.timedOut, false);
    assert.equal(res.exitCode, 0);

    const out = Object.fromEntries(
      chunks.join("").trim().split("\n").map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      }),
    );
    assert.equal(out.UID, String(hostUid), "inner process must run as real host uid, not uid 0");
    assert.equal(out.GID, String(hostGid), "inner process must run as real host gid");
    assert.equal(out.CAPEFF, "0000000000000000", "inner process must have zero effective capabilities");
    assert.equal(out.PW_HOME, homedir(), "getent passwd $(id -u) must resolve to real user home");
    if (hostUid !== 0) assert.notEqual(out.PW_HOME, "/root");

    // Host upperdir files must be owned by real host uid/gid, while lowerdir stays untouched pre-commit.
    const upperStat = lstatSync(join(res.upperDir, "a.txt"));
    assert.equal(upperStat.uid, hostUid);
    assert.equal(upperStat.gid, hostGid);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "before\n");
    assert.equal(readFileSync(join(cwd, "sub", "old.txt"), "utf8"), "old-sub\n");

    // Commit and verify byte-for-byte rollback including opaque directory replacement.
    const { changes } = commitOverlay(cwd, res.upperDir, res.deletedRelPaths, blobRoot);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "after\n");
    assert.equal(existsSync(join(cwd, "sub", "old.txt")), false);
    assert.equal(readFileSync(join(cwd, "sub", "new.txt"), "utf8"), "fresh\n");

    for (const change of [...changes].reverse()) {
      restoreFileState(change.path, change.before, blobRoot);
    }
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "before\n");
    assert.equal(readFileSync(join(cwd, "sub", "old.txt"), "utf8"), "old-sub\n");
    assert.equal(existsSync(join(cwd, "sub", "new.txt")), false);
  } finally {
    res.cleanup();
  }
});

test("canUseOverlayForCwd rejects /, system paths, and directories containing tmpdir", () => {
  assert.equal(canUseOverlayForCwd("/"), false);
  assert.equal(canUseOverlayForCwd("/dev"), false);
  assert.equal(canUseOverlayForCwd(tmpdir()), false);
  const work = mkdtempSync(join(tmpdir(), "pi-rb-ovl-cwd-"));
  cleanup.push(work);
  assert.equal(canUseOverlayForCwd(work), process.platform === "linux");
});

test("OverlayFS captures opaque script writes, rm -rf, and opaque directory replacement and rolls back byte-for-byte", async (t) => {
  if (!isOverlaySupported()) {
    t.skip("unprivileged OverlayFS not supported on this host");
    return;
  }
  const home = realpathSync(homedir());
  const cwd = mkdtempSync(join(home, ".pi-rb-ovl-home-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "pi-rb-ovl-blobs-"));
  cleanup.push(cwd, blobRoot);

  mkdirSync(join(cwd, "sub"), { recursive: true });
  mkdirSync(join(cwd, "gone"), { recursive: true });
  writeFileSync(join(cwd, "a.txt"), "orig-a\n");
  writeFileSync(join(cwd, "sub", "old.txt"), "orig-old\n");
  writeFileSync(join(cwd, "gone", "keep.txt"), "orig-keep\n");

  const chunks: string[] = [];
  const res = await execInOverlay(
    `python3 -c '
import pathlib
pathlib.Path("a.txt").write_text("edited-by-python\\n")
pathlib.Path("created.txt").write_text("brand-new\\n")
' && rm -rf gone && rm -rf sub && mkdir sub && echo fresh > sub/new.txt && pwd`,
    cwd,
    { onData: (b) => chunks.push(b.toString("utf8")), env: { ...process.env, BASH_ENV: "" } },
  );
  try {
    assert.equal(res.mounted, true);
    assert.equal(res.aborted, false);
    assert.equal(res.exitCode, 0);
    // Command saw the REAL cwd path, not a temp mount path.
    assert.equal(chunks.join("").trim(), realpathSync(cwd));
    // Before commit, host lowerdir is still completely untouched!
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "orig-a\n");
    assert.equal(existsSync(join(cwd, "created.txt")), false);
    assert.equal(existsSync(join(cwd, "gone", "keep.txt")), true);

    const { changes } = commitOverlay(cwd, res.upperDir, res.deletedRelPaths, blobRoot);
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "edited-by-python\n");
    assert.equal(readFileSync(join(cwd, "created.txt"), "utf8"), "brand-new\n");
    assert.equal(existsSync(join(cwd, "gone", "keep.txt")), false);
    assert.equal(existsSync(join(cwd, "sub", "old.txt")), false);
    assert.equal(readFileSync(join(cwd, "sub", "new.txt"), "utf8"), "fresh\n");

    // Roll back every recorded FileMutation in reverse order -> byte-for-byte original!
    for (const change of [...changes].reverse()) {
      restoreFileState(change.path, change.before, blobRoot);
    }
    assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "orig-a\n");
    assert.equal(existsSync(join(cwd, "created.txt")), false);
    assert.equal(readFileSync(join(cwd, "gone", "keep.txt"), "utf8"), "orig-keep\n");
    assert.equal(readFileSync(join(cwd, "sub", "old.txt"), "utf8"), "orig-old\n");
    assert.equal(existsSync(join(cwd, "sub", "new.txt")), false);
  } finally {
    res.cleanup();
    assert.equal(existsSync(res.baseDir), false, "overlay temp dir must be cleaned up including 0000 work/work");
  }
});

test("captureFileState handles symlinks and broken symlinks without misreporting missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rb-ovl-symlink-state-"));
  cleanup.push(dir);
  const target = join(dir, "target.txt");
  writeFileSync(target, "hello\n");
  const link = join(dir, "link");
  symlinkSync(target, link);
  assert.deepEqual(captureFileState(link), { kind: "symlink", target });
  const broken = join(dir, "broken");
  symlinkSync(join(dir, "nope"), broken);
  assert.deepEqual(captureFileState(broken), { kind: "symlink", target: join(dir, "nope") });
  // Round-trip: restore a symlink state onto a regular file.
  rmSync(link);
  writeFileSync(link, "was a file\n");
  restoreFileState(link, { kind: "symlink", target });
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(link, "utf8"), "hello\n");
});

test("OverlayFS symlink delete and replace are journaled and roll back byte-for-byte", async (t) => {
  if (!isOverlaySupported()) {
    t.skip("unprivileged OverlayFS not supported on this host");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "pi-rb-ovl-symlink-"));
  const blobRoot = mkdtempSync(join(tmpdir(), "pi-rb-ovl-symlink-blobs-"));
  cleanup.push(cwd, blobRoot);
  const keptTarget = join(cwd, "kept.txt");
  writeFileSync(keptTarget, "kept\n");
  const deletedLink = join(cwd, "deleted-link");
  symlinkSync(keptTarget, deletedLink);
  const replacedLink = join(cwd, "replaced-link");
  const oldTarget = join(cwd, "old-target.txt");
  writeFileSync(oldTarget, "old\n");
  symlinkSync(oldTarget, replacedLink);
  const newTarget = join(cwd, "new-target.txt");

  const res = await execInOverlay(
    `rm deleted-link && rm replaced-link && ln -s ${newTarget} replaced-link`,
    cwd,
    { onData: () => {}, env: { ...process.env, BASH_ENV: "" } },
  );
  try {
    assert.equal(res.mounted, true);
    assert.equal(res.exitCode, 0);
    const { changes } = commitOverlay(cwd, res.upperDir, res.deletedRelPaths, blobRoot);
    assert.equal(existsSync(deletedLink), false);
    assert.equal(lstatSync(replacedLink).isSymbolicLink(), true);
    assert.equal(readlinkSafe(replacedLink), newTarget);
    assert.ok(changes.some((c) => c.path === deletedLink && c.before.kind === "symlink"));
    assert.ok(changes.some((c) => c.path === replacedLink && c.before.kind === "symlink"));
    for (const change of [...changes].reverse()) restoreFileState(change.path, change.before, blobRoot);
    assert.equal(lstatSync(deletedLink).isSymbolicLink(), true);
    assert.equal(readlinkSafe(deletedLink), keptTarget);
    assert.equal(readlinkSafe(replacedLink), oldTarget);
    assert.equal(readFileSync(replacedLink, "utf8"), "old\n");
  } finally {
    res.cleanup();
  }
});

test("OverlayFS transactional abort discards upperdir and leaves host files untouched", async (t) => {
  if (!isOverlaySupported()) {
    t.skip("unprivileged OverlayFS not supported on this host");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "pi-rb-ovl-abort-"));
  cleanup.push(cwd);
  writeFileSync(join(cwd, "precious.txt"), "untouched\n");

  const controller = new AbortController();
  const promise = execInOverlay(
    "echo corrupted > precious.txt && sleep 10",
    cwd,
    {
      signal: controller.signal,
      onData: () => {},
    },
  );
  setTimeout(() => controller.abort(), 150);
  const res = await promise;
  try {
    assert.equal(res.aborted, true);
    // Host file was never touched because upperdir is discarded on abort.
    assert.equal(readFileSync(join(cwd, "precious.txt"), "utf8"), "untouched\n");
  } finally {
    res.cleanup();
  }
});

test("OverlayFS replacing a symlink with a regular file captures the symlink and rolls back byte-for-byte", async () => {
  if (!isOverlaySupported()) return;
  const dir = mkdtempSync(join(tmpdir(), "pi-rb-ovl-sym2file-"));
  const blobs = mkdtempSync(join(tmpdir(), "pi-rb-ovl-sym2file-blobs-"));
  try {
    writeFileSync(join(dir, "target.txt"), "real target\n");
    symlinkSync("target.txt", join(dir, "link.txt"));

    const res = await execInOverlay("rm link.txt && printf 'plain file\\n' > link.txt", dir, {
      onData: () => {},
      env: { ...process.env, BASH_ENV: "" },
    });
    assert.equal(res.exitCode, 0);
    assert.equal(res.mounted, true);

    const { changes } = commitOverlay(dir, res.upperDir, res.deletedRelPaths, blobs);
    res.cleanup();

    // On disk: now a regular file.
    assert.equal(lstatSync(join(dir, "link.txt")).isFile(), true);
    assert.equal(readFileSync(join(dir, "link.txt"), "utf8"), "plain file\n");

    const linkChange = changes.find((c) => c.path.endsWith("/link.txt"));
    assert.ok(linkChange, "symlink->file change must be recorded");
    assert.deepEqual(linkChange.before, { kind: "symlink", target: "target.txt" });
    assert.equal(linkChange.after.kind, "file");

    // Roll back: must restore the original symlink, NOT delete it!
    restoreFileState(linkChange.path, linkChange.before, blobs);
    assert.equal(lstatSync(join(dir, "link.txt")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(dir, "link.txt")), "target.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(blobs, { recursive: true, force: true });
  }
});

test("OverlayFS two-namespace ssh -G succeeds with real known_hosts and user-owned ssh_config.d drop-ins", async (t) => {
  if (!isOverlaySupported()) {
    t.skip("unprivileged two-namespace OverlayFS not supported on this host");
    return;
  }
  if (!existsSync("/usr/bin/ssh")) {
    t.skip("/usr/bin/ssh not installed on this host");
    return;
  }
  const hostUid = process.getuid?.();
  const cwd = mkdtempSync(join(tmpdir(), "pi-rb-ovl-ssh-"));
  cleanup.push(cwd);
  const chunks: string[] = [];
  const res = await execInOverlay(
    '/usr/bin/ssh -G localhost && for f in /etc/ssh/ssh_config.d/*.conf; do [ -e "$f" ] && stat -L -c "DROPIN_UID=%u" "$f"; done; true',
    cwd,
    { onData: (b) => chunks.push(b.toString("utf8")), env: { ...process.env, BASH_ENV: "" } },
  );
  try {
    assert.equal(res.mounted, true);
    assert.equal(res.exitCode, 0);
    const output = chunks.join("");
    assert.equal(/Bad owner or permissions/i.test(output), false);
    assert.match(output, new RegExp(`userknownhostsfile\\s+${homedir().replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/\\.ssh/known_hosts`));
    for (const line of output.split("\n")) {
      if (line.startsWith("DROPIN_UID=")) {
        assert.equal(line.slice("DROPIN_UID=".length).trim(), String(hostUid));
      }
    }
  } finally {
    res.cleanup();
    assert.equal(existsSync(res.baseDir), false);
  }
});

test("prepareSshConfigDropins fails closed when any drop-in is unreadable (never binds partial config)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rb-ssh-fc-"));
  cleanup.push(dir);
  const src = join(dir, "ssh_config.d");
  const staged = join(dir, "staged");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "10-good.conf"), "SendEnv LANG\n", { mode: 0o644 });
  const bad = join(src, "20-unreadable.conf");
  writeFileSync(bad, "StrictHostKeyChecking yes\n", { mode: 0o600 });
  chmodSync(bad, 0o000);
  try {
    // Only enforceable when not running as real root (root bypasses 0000 DAC checks).
    if (process.getuid?.() === 0) return;
    const res = prepareSshConfigDropins(src, staged);
    assert.equal(res.status, "rejected");
    assert.equal(res.count, 0);
    assert.match(res.reason ?? "", /read failed/i);
    assert.equal(existsSync(staged), false, "staging dir must not exist after fail-closed rejection");
  } finally {
    chmodSync(bad, 0o600);
  }
});

test("prepareSshConfigDropins allows trusted symlinks, skips empty dir, and rejects escaping symlinks, devices, and oversized files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rb-ssh-sym-"));
  cleanup.push(dir);

  // 1. Empty directory (WSL scenario): skipped-empty with zero staging overhead.
  const emptySrc = join(dir, "empty");
  const emptyStaged = join(dir, "empty-staged");
  mkdirSync(emptySrc, { recursive: true });
  assert.deepEqual(prepareSshConfigDropins(emptySrc, emptyStaged), { status: "skipped-empty", count: 0 });
  assert.equal(existsSync(emptyStaged), false);

  // 2. Trusted symlink (simulating 20-systemd-ssh-proxy.conf -> /usr/lib/systemd/ssh_config.d/...).
  const trustedTargetDir = join(dir, "trusted-systemd");
  const untrustedTargetDir = join(dir, "untrusted");
  mkdirSync(trustedTargetDir, { recursive: true });
  mkdirSync(untrustedTargetDir, { recursive: true });
  const trustedConf = join(trustedTargetDir, "20-systemd-ssh-proxy.conf");
  writeFileSync(trustedConf, "Host machine/*\n  ProxyCommand none\n", { mode: 0o644 });
  const untrustedConf = join(untrustedTargetDir, "evil.conf");
  writeFileSync(untrustedConf, "ProxyCommand evil\n", { mode: 0o644 });

  const okSrc = join(dir, "ok-src");
  const okStaged = join(dir, "ok-staged");
  mkdirSync(okSrc, { recursive: true });
  symlinkSync(trustedConf, join(okSrc, "20-systemd-ssh-proxy.conf"));
  const okRes = prepareSshConfigDropins(okSrc, okStaged, [trustedTargetDir]);
  assert.equal(okRes.status, "staged");
  assert.equal(okRes.count, 1);
  assert.equal(readFileSync(join(okStaged, "20-systemd-ssh-proxy.conf"), "utf8"), "Host machine/*\n  ProxyCommand none\n");
  assert.equal(lstatSync(join(okStaged, "20-systemd-ssh-proxy.conf")).mode & 0o777, 0o644);

  // 3. Escaping symlink outside allowed prefixes -> rejected (fail-closed).
  const escSrc = join(dir, "esc-src");
  const escStaged = join(dir, "esc-staged");
  mkdirSync(escSrc, { recursive: true });
  symlinkSync(trustedConf, join(escSrc, "10-ok.conf"));
  symlinkSync(untrustedConf, join(escSrc, "20-evil.conf"));
  const escRes = prepareSshConfigDropins(escSrc, escStaged, [trustedTargetDir]);
  assert.equal(escRes.status, "rejected");
  assert.match(escRes.reason ?? "", /outside allowed prefixes/i);
  assert.equal(existsSync(escStaged), false);

  // 4. Symlink to /dev/zero (non-regular device) -> rejected immediately without hanging.
  const devSrc = join(dir, "dev-src");
  const devStaged = join(dir, "dev-staged");
  mkdirSync(devSrc, { recursive: true });
  symlinkSync("/dev/zero", join(devSrc, "99-zero.conf"));
  const devRes = prepareSshConfigDropins(devSrc, devStaged, ["/dev"]);
  assert.equal(devRes.status, "rejected");
  assert.match(devRes.reason ?? "", /not a regular file/i);
  assert.equal(existsSync(devStaged), false);

  // 5. Oversized file (>256 KiB) -> rejected.
  const bigSrc = join(dir, "big-src");
  const bigStaged = join(dir, "big-staged");
  mkdirSync(bigSrc, { recursive: true });
  writeFileSync(join(bigSrc, "huge.conf"), "a".repeat(300 * 1024));
  const bigRes = prepareSshConfigDropins(bigSrc, bigStaged);
  assert.equal(bigRes.status, "rejected");
  assert.match(bigRes.reason ?? "", /exceeds/i);
  assert.equal(existsSync(bigStaged), false);
});
