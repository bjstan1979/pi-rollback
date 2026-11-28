import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  canUseOverlayForCwd,
  commitOverlay,
  execInOverlay,
  isOverlaySupported,
  parseOverlayEnabled,
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
