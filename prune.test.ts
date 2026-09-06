import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafeLayoutRoot,
  createLease,
  parsePruneConfig,
  readPruneSettings,
  pruneSnapshots,
  releaseLease,
  type PruneConfig,
  type PruneDependencies,
  type ProcessLiveness,
} from "./prune.js";

const DAY = 24 * 60 * 60 * 1_000;
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-rollback-prune-"));
  cleanup.push(path);
  return path;
}

function tokens(): () => string {
  let value = 0;
  return () => (++value).toString(16).padStart(32, "0");
}

function deps(now: () => number, states: Record<number, ProcessLiveness> = {}): PruneDependencies {
  return {
    now,
    pid: 100,
    token: tokens(),
    processStartIdentity: () => "process-start",
    processLiveness: (pid) => states[pid] ?? "alive",
  };
}

function config(overrides: Partial<PruneConfig> = {}): PruneConfig {
  return {
    enabled: true,
    retentionMs: 7 * DAY,
    maxBytes: 0,
    intervalMs: 0,
    migrationGraceMs: 0,
    ...overrides,
  };
}

function candidate(layoutRoot: string, relativePath: string, lastUsedAt: number, bytes = 8192): string {
  const path = join(layoutRoot, ...relativePath.split("/"));
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "payload"), Buffer.alloc(bytes, relativePath));
  writeFileSync(join(path, ".activity.json"), `${JSON.stringify({ lastUsedAt })}\n`);
  return path;
}

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";
const C = "cccccccccccccccccccccccc";

test("prune config accepts defaults and zero while invalid values disable with one warning value", () => {
  const defaults = parsePruneConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.retentionMs, 7 * DAY);
  assert.equal(defaults.maxBytes, 10 * 1024 ** 3);
  assert.equal(defaults.intervalMs, 6 * 60 * 60 * 1_000);
  assert.equal(defaults.migrationGraceMs, 7 * DAY);

  const zero = parsePruneConfig({
    PI_ROLLBACK_RETENTION_DAYS: "0",
    PI_ROLLBACK_MAX_STORE_GB: "0",
    PI_ROLLBACK_PRUNE_INTERVAL_HOURS: "0",
    PI_ROLLBACK_MIGRATION_GRACE_DAYS: "0",
  });
  assert.equal(zero.enabled, true);
  assert.deepEqual([zero.retentionMs, zero.maxBytes, zero.intervalMs, zero.migrationGraceMs], [0, 0, 0, 0]);
  assert.equal(parsePruneConfig({ PI_ROLLBACK_PRUNE: "0" }).warning, undefined);

  for (const env of [
    { PI_ROLLBACK_PRUNE: "yes" },
    { PI_ROLLBACK_RETENTION_DAYS: "-1" },
    { PI_ROLLBACK_MAX_STORE_GB: "NaN" },
    { PI_ROLLBACK_PRUNE_INTERVAL_HOURS: "Infinity" },
    { PI_ROLLBACK_MIGRATION_GRACE_DAYS: "" },
  ]) {
    const parsed = parsePruneConfig(env);
    assert.equal(parsed.enabled, false);
    assert.match(parsed.warning!, /disabled/);
  }
});
test("prune config loads global settings and environment values take precedence", () => {
  const settingsPath = join(root(), "settings.json");
  writeFileSync(settingsPath, `\uFEFF${JSON.stringify({
    unrelated: "preserved",
    PI_ROLLBACK_PRUNE: true,
    PI_ROLLBACK_RETENTION_DAYS: 14,
    PI_ROLLBACK_MAX_STORE_GB: 20,
    PI_ROLLBACK_PRUNE_INTERVAL_HOURS: 12,
    PI_ROLLBACK_MIGRATION_GRACE_DAYS: 3,
  })}`);

  const loaded = readPruneSettings(settingsPath);
  assert.equal(loaded.warning, undefined);
  assert.deepEqual(Object.keys(loaded.settings).sort(), [
    "PI_ROLLBACK_MAX_STORE_GB",
    "PI_ROLLBACK_MIGRATION_GRACE_DAYS",
    "PI_ROLLBACK_PRUNE",
    "PI_ROLLBACK_PRUNE_INTERVAL_HOURS",
    "PI_ROLLBACK_RETENTION_DAYS",
  ]);
  const fromSettings = parsePruneConfig({}, loaded.settings);
  assert.deepEqual(
    [fromSettings.enabled, fromSettings.retentionMs, fromSettings.maxBytes, fromSettings.intervalMs, fromSettings.migrationGraceMs],
    [true, 14 * DAY, 20 * 1024 ** 3, 12 * 60 * 60 * 1_000, 3 * DAY],
  );

  const withEnvironmentOverride = parsePruneConfig({ PI_ROLLBACK_MAX_STORE_GB: "4" }, loaded.settings);
  assert.equal(withEnvironmentOverride.maxBytes, 4 * 1024 ** 3);
  assert.equal(parsePruneConfig({ PI_ROLLBACK_PRUNE: "0" }, loaded.settings).enabled, false);
});

test("settings read and validation failures disable pruning safely", () => {
  const settingsPath = join(root(), "settings.json");
  writeFileSync(settingsPath, "{invalid");
  const malformed = readPruneSettings(settingsPath);
  assert.match(malformed.warning!, /disabled/);
  assert.deepEqual(malformed.settings, {});

  const invalidValue = parsePruneConfig({}, { PI_ROLLBACK_RETENTION_DAYS: false });
  assert.equal(invalidValue.enabled, false);
  assert.match(invalidValue.warning!, /PI_ROLLBACK_RETENTION_DAYS/);
  assert.equal(readPruneSettings(join(root(), "missing.json")).warning, undefined);
});


test("multiple live leases protect a candidate until every owner releases", () => {
  const layoutRoot = root();
  candidate(layoutRoot, A, 0);
  const dependencies = deps(() => DAY);
  const first = createLease(layoutRoot, "sandbox", A, dependencies);
  const second = createLease(layoutRoot, "sandbox", A, dependencies);

  let report = pruneSnapshots({ layoutRoot, mode: "sandbox", config: config({ retentionMs: 0 }), dependencies });
  assert.equal(existsSync(join(layoutRoot, A)), true);
  assert.ok(report.protected.includes(A));
  releaseLease(first);
  report = pruneSnapshots({ layoutRoot, mode: "sandbox", config: config({ retentionMs: 0 }), dependencies });
  assert.equal(existsSync(join(layoutRoot, A)), true);
  releaseLease(second);
  report = pruneSnapshots({ layoutRoot, mode: "sandbox", config: config({ retentionMs: 0 }), dependencies });
  assert.deepEqual(report.removed, [A]);
});

test("a provably dead stale lease is removed and no longer protects its store", () => {
  const layoutRoot = root();
  candidate(layoutRoot, A, 0);
  const dependencies = deps(() => DAY, { 200: "dead" });
  const stale = createLease(layoutRoot, "sandbox", A, { ...dependencies, pid: 200 });
  const report = pruneSnapshots({ layoutRoot, mode: "sandbox", config: config({ retentionMs: 0 }), dependencies });
  assert.deepEqual(report.removed, [A]);
  assert.equal(existsSync(stale.path), false);
});

test("age cleanup handles normal session and legacy candidates", () => {
  const layoutRoot = root();
  const now = 20 * DAY;
  candidate(layoutRoot, `sessions/${A}`, now - 10 * DAY);
  candidate(layoutRoot, B, now - 8 * DAY);
  candidate(layoutRoot, `sessions/${C}`, now - DAY);
  const report = pruneSnapshots({ layoutRoot, mode: "normal", config: config(), dependencies: deps(() => now) });
  assert.deepEqual(report.removed, [`sessions/${A}`, B]);
  assert.equal(existsSync(join(layoutRoot, "sessions", C)), true);
});

test("size pruning removes oldest eligible stores first and treats the cap as soft", () => {
  const layoutRoot = root();
  const now = 10 * DAY;
  candidate(layoutRoot, A, 1, 16_384);
  candidate(layoutRoot, B, 2, 16_384);
  candidate(layoutRoot, C, 3, 16_384);
  const dependencies = deps(() => now);
  const initial = pruneSnapshots({
    layoutRoot,
    mode: "sandbox",
    config: config({ retentionMs: 100 * DAY, maxBytes: 0 }),
    dependencies,
  });
  const cap = initial.remainingBytes - 1;
  const report = pruneSnapshots({
    layoutRoot,
    mode: "sandbox",
    config: config({ retentionMs: 100 * DAY, maxBytes: cap }),
    dependencies,
  });
  assert.deepEqual(report.removed, [A]);

  const protectedRoot = root();
  candidate(protectedRoot, A, 1, 32_768);
  candidate(protectedRoot, B, 2, 8192);
  const soft = pruneSnapshots({
    layoutRoot: protectedRoot,
    mode: "sandbox",
    currentCandidate: A,
    config: config({ retentionMs: 100 * DAY, maxBytes: 1 }),
    dependencies: deps(() => now),
  });
  assert.deepEqual(soft.removed, [B]);
  assert.equal(existsSync(join(protectedRoot, A)), true);
  assert.ok(soft.remainingBytes > 1);
});

test("pre-feature candidates receive a marker and migration grace before deletion", () => {
  const layoutRoot = root();
  const path = join(layoutRoot, A);
  mkdirSync(path);
  writeFileSync(join(path, "payload"), "old");
  utimesSync(path, new Date(0), new Date(0));
  utimesSync(join(path, "payload"), new Date(0), new Date(0));
  let now = 10 * DAY;
  const dependencies = deps(() => now);
  let report = pruneSnapshots({
    layoutRoot,
    mode: "sandbox",
    config: config({ retentionMs: 2 * DAY, migrationGraceMs: 2 * DAY }),
    dependencies,
  });
  assert.deepEqual(report.removed, []);
  const marker = JSON.parse(readFileSync(join(path, ".activity.json"), "utf8"));
  assert.equal(marker.discoveredAt, now);
  utimesSync(join(path, "payload"), new Date(now + DAY), new Date(now + DAY));
  now += 2 * DAY;
  report = pruneSnapshots({
    layoutRoot,
    mode: "sandbox",
    config: config({ retentionMs: 2 * DAY, migrationGraceMs: 2 * DAY }),
    dependencies,
  });
  assert.deepEqual(report.removed, []);
  assert.equal(JSON.parse(readFileSync(join(path, ".activity.json"), "utf8")).lastUsedAt, 11 * DAY);

  now += DAY;
  report = pruneSnapshots({
    layoutRoot,
    mode: "sandbox",
    config: config({ retentionMs: 2 * DAY, migrationGraceMs: 2 * DAY }),
    dependencies,
  });
  assert.deepEqual(report.removed, [A]);
});

test("candidate discovery refuses symlinks, files, and unknown names", () => {
  const layoutRoot = root();
  const outside = root();
  writeFileSync(join(outside, "precious"), "keep");
  symlinkSync(outside, join(layoutRoot, A), "dir");
  writeFileSync(join(layoutRoot, B), "not a directory");
  mkdirSync(join(layoutRoot, "unknown-name"));
  writeFileSync(join(layoutRoot, "random-file"), "keep");

  const report = pruneSnapshots({
    layoutRoot,
    mode: "sandbox",
    config: config({ retentionMs: 0 }),
    dependencies: deps(() => DAY),
  });
  assert.deepEqual(report.removed, []);
  assert.equal(readFileSync(join(outside, "precious"), "utf8"), "keep");
  assert.ok(report.skipped.includes(A));
  assert.ok(report.skipped.includes(B));
  assert.ok(report.skipped.includes("unknown-name"));
  assert.ok(report.skipped.includes("random-file"));
});

test("sandbox layout refuses a symlinked ancestor", () => {
  const workspace = root();
  const outside = root();
  symlinkSync(outside, join(workspace, ".pi"), "dir");
  const layoutRoot = join(workspace, ".pi", ".rollback-snapshots");
  assert.throws(() => assertSafeLayoutRoot(layoutRoot, workspace), /symbolic-link rollback layout ancestor/);
  const report = pruneSnapshots({
    layoutRoot,
    containmentRoot: workspace,
    mode: "sandbox",
    config: config({ retentionMs: 0 }),
    dependencies: deps(() => DAY),
  });
  assert.deepEqual(report.removed, []);
  assert.match(report.errors.join("\n"), /symbolic-link rollback layout ancestor/);
});

test("later prune runs finish valid quarantined deletion and leave unknown trash alone", () => {
  const layoutRoot = root();
  const trash = join(layoutRoot, ".trash");
  const owner = "f".repeat(32);
  const quarantined = `${owner}-${A}`;
  mkdirSync(join(trash, quarantined), { recursive: true });
  writeFileSync(join(trash, quarantined, "payload"), "old");
  writeFileSync(join(trash, quarantined, ".delete-intent.json"), `${JSON.stringify({ owner, candidate: A, mode: "sandbox", createdAt: 0 })}\n`);
  const unauthenticated = `${"e".repeat(32)}-${C}`;
  mkdirSync(join(trash, unauthenticated));
  mkdirSync(join(trash, "unknown"));
  const report = pruneSnapshots({ layoutRoot, mode: "sandbox", config: config(), dependencies: deps(() => DAY) });
  assert.equal(existsSync(join(trash, quarantined)), false);
  assert.equal(existsSync(join(trash, "unknown")), true);
  assert.equal(existsSync(join(trash, unauthenticated)), true);
  assert.ok(report.removed.includes(`.trash/${quarantined}`));
  assert.ok(report.bytesRemoved > 0);
});

test("a prune lock is reclaimed only when its owner is provably dead", () => {
  const layoutRoot = root();
  candidate(layoutRoot, A, 0);
  const lock = join(layoutRoot, ".prune-lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({
    owner: "e".repeat(32),
    pid: 200,
    startIdentity: "old-start",
    createdAt: 0,
  })}\n`);
  const report = pruneSnapshots({
    layoutRoot,
    mode: "sandbox",
    config: config({ retentionMs: 0 }),
    dependencies: deps(() => DAY, { 200: "dead" }),
  });
  assert.deepEqual(report.removed, [A]);
  assert.equal(existsSync(lock), false);
});

test("malformed lease and lock metadata fail closed", () => {
  const leaseRoot = root();
  candidate(leaseRoot, A, 0);
  mkdirSync(join(leaseRoot, ".leases"));
  writeFileSync(join(leaseRoot, ".leases", `${"a".repeat(32)}.json`), "not-json");
  const leaseReport = pruneSnapshots({
    layoutRoot: leaseRoot,
    mode: "sandbox",
    config: config({ retentionMs: 0 }),
    dependencies: deps(() => DAY),
  });
  assert.equal(existsSync(join(leaseRoot, A)), true);
  assert.match(leaseReport.errors.join("\n"), /Unreadable rollback lease/);

  const lockRoot = root();
  candidate(lockRoot, A, 0);
  mkdirSync(join(lockRoot, ".prune-lock"));
  writeFileSync(join(lockRoot, ".prune-lock", "owner.json"), "{}");
  const lockReport = pruneSnapshots({
    layoutRoot: lockRoot,
    mode: "sandbox",
    config: config({ retentionMs: 0 }),
    dependencies: deps(() => DAY),
  });
  assert.equal(existsSync(join(lockRoot, A)), true);
  assert.match(lockReport.errors.join("\n"), /lock is unreadable/);
});
