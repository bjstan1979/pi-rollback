import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const HASH = /^[0-9a-f]{24}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const ACTIVITY_FILE = ".activity.json";
const DELETE_INTENT_FILE = ".delete-intent.json";
const LAST_PRUNE_FILE = ".last-prune.json";
const DAY = 24 * 60 * 60 * 1_000;
const HOUR = 60 * 60 * 1_000;
const GB = 1024 ** 3;

export type PruneMode = "normal" | "sandbox";
export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface PruneConfig {
  enabled: boolean;
  retentionMs: number;
  maxBytes: number;
  intervalMs: number;
  migrationGraceMs: number;
  warning?: string;
}

export interface PruneDependencies {
  now?: () => number;
  pid?: number;
  token?: () => string;
  processStartIdentity?: (pid: number) => string | undefined;
  processLiveness?: (pid: number, startIdentity?: string) => ProcessLiveness;
}

export interface LeaseHandle {
  path: string;
  owner: string;
  candidate: string;
  layoutRoot: string;
  record: LeaseRecord;
}

export interface PruneReport {
  planned: string[];
  removed: string[];
  bytesRemoved: number;
  remainingBytes: number;
  skipped: string[];
  protected: string[];
  errors: string[];
}

interface LeaseRecord {
  owner: string;
  pid: number;
  startIdentity?: string;
  candidate: string;
  createdAt: number;
}

interface LockRecord {
  owner: string;
  pid: number;
  startIdentity?: string;
  createdAt: number;
}
interface DeleteIntentRecord {
  owner: string;
  candidate: string;
  mode: PruneMode;
  createdAt: number;
}

interface ActivityRecord {
  lastUsedAt: number;
  discoveredAt?: number;
}

interface Candidate {
  path: string;
  relativePath: string;
  bytes: number;
  activity: ActivityRecord;
  migrationProtected: boolean;
}

interface TrashCandidate {
  path: string;
  relativePath: string;
  bytes: number;
}

export interface PruneOptions {
  layoutRoot: string;
  mode: PruneMode;
  currentCandidate?: string;
  containmentRoot?: string;
  config: PruneConfig;
  dependencies?: PruneDependencies;
}

export const PRUNE_SETTING_NAMES = [
  "PI_ROLLBACK_PRUNE",
  "PI_ROLLBACK_RETENTION_DAYS",
  "PI_ROLLBACK_MAX_STORE_GB",
  "PI_ROLLBACK_PRUNE_INTERVAL_HOURS",
  "PI_ROLLBACK_MIGRATION_GRACE_DAYS",
] as const;

export type PruneSettingName = (typeof PRUNE_SETTING_NAMES)[number];
export type PruneSettings = Partial<Record<PruneSettingName, unknown>>;

export interface PruneSettingsLoadResult {
  settings: PruneSettings;
  warning?: string;
}

export function readPruneSettings(path: string): PruneSettingsLoadResult {
  if (!existsSync(path)) return { settings: {} };
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("settings root must be a JSON object");
    const record = value as Record<string, unknown>;
    return { settings: Object.fromEntries(PRUNE_SETTING_NAMES.filter((name) => name in record).map((name) => [name, record[name]])) };
  } catch (error) {
    return {
      settings: {},
      warning: `Automatic rollback pruning disabled: unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function configuredValue(env: NodeJS.ProcessEnv, settings: PruneSettings, name: PruneSettingName): unknown {
  return env[name] !== undefined ? env[name] : settings[name];
}

function parseNonNegative(value: unknown, name: PruneSettingName, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" && typeof value !== "string") throw new Error(`${name} must be a finite non-negative number`);
  if (typeof value === "string" && !value.trim()) throw new Error(`${name} must be a finite non-negative number`);
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a finite non-negative number`);
  return parsed;
}

function parseToggle(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new Error("PI_ROLLBACK_PRUNE must be 0, 1, false, or true");
}

export function parsePruneConfig(env: NodeJS.ProcessEnv = process.env, settings: PruneSettings = {}): PruneConfig {
  const disabled: PruneConfig = { enabled: false, retentionMs: 7 * DAY, maxBytes: 10 * GB, intervalMs: 6 * HOUR, migrationGraceMs: 7 * DAY };
  try {
    if (!parseToggle(configuredValue(env, settings, "PI_ROLLBACK_PRUNE"))) return disabled;
    const retentionMs = parseNonNegative(configuredValue(env, settings, "PI_ROLLBACK_RETENTION_DAYS"), "PI_ROLLBACK_RETENTION_DAYS", 7) * DAY;
    const maxBytes = parseNonNegative(configuredValue(env, settings, "PI_ROLLBACK_MAX_STORE_GB"), "PI_ROLLBACK_MAX_STORE_GB", 10) * GB;
    const intervalMs = parseNonNegative(configuredValue(env, settings, "PI_ROLLBACK_PRUNE_INTERVAL_HOURS"), "PI_ROLLBACK_PRUNE_INTERVAL_HOURS", 6) * HOUR;
    const migrationGraceMs = parseNonNegative(configuredValue(env, settings, "PI_ROLLBACK_MIGRATION_GRACE_DAYS"), "PI_ROLLBACK_MIGRATION_GRACE_DAYS", 7) * DAY;
    if (![retentionMs, maxBytes, intervalMs, migrationGraceMs].every(Number.isFinite)) throw new Error("configured value is too large");
    return { enabled: true, retentionMs, maxBytes, intervalMs, migrationGraceMs };
  } catch (error) {
    return { ...disabled, warning: `Automatic rollback pruning disabled: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function defaultToken(): string {
  return randomUUID().replaceAll("-", "");
}

function readProcStartIdentity(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    if (close < 0) return undefined;
    return value.slice(close + 2).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function defaultLiveness(pid: number, startIdentity?: string): ProcessLiveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  if (process.platform === "linux" && startIdentity !== undefined) {
    try {
      const current = readProcStartIdentity(pid);
      if (current === undefined) return existsSync(`/proc/${pid}`) ? "unknown" : "dead";
      return current === startIdentity ? "alive" : "dead";
    } catch {
      return "unknown";
    }
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}

function runtime(dependencies: PruneDependencies = {}) {
  return {
    now: dependencies.now ?? Date.now,
    pid: dependencies.pid ?? process.pid,
    token: dependencies.token ?? defaultToken,
    startIdentity: dependencies.processStartIdentity ?? readProcStartIdentity,
    liveness: dependencies.processLiveness ?? defaultLiveness,
  };
}

function isContained(root: string, path: string): boolean {
  const scoped = relative(resolve(root), resolve(path));
  return scoped !== "" && !scoped.startsWith(`..${sep}`) && scoped !== ".." && !isAbsolute(scoped);
}

function ensureDirectory(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe rollback pruning directory: ${path}`);
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function atomicJson(path: string, value: unknown, token: string): void {
  const temporary = join(dirname(path), `.tmp-${token}`);
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  try {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symbolic-link metadata path: ${path}`);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function validCandidateRelative(mode: PruneMode, candidate: string): boolean {
  if (isAbsolute(candidate) || candidate.includes("\\")) return false;
  const parts = candidate.split("/");
  return mode === "normal"
    ? (parts.length === 1 && HASH.test(parts[0]!)) || (parts.length === 2 && parts[0] === "sessions" && HASH.test(parts[1]!))
    : parts.length === 1 && HASH.test(parts[0]!);
}

export function assertSafeLayoutRoot(layoutRoot: string, containmentRoot?: string): void {
  const target = resolve(layoutRoot);
  if (!containmentRoot) {
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error(`Unsafe symbolic-link rollback layout: ${target}`);
    return;
  }
  const root = resolve(containmentRoot);
  const scoped = relative(root, target);
  if (scoped === "" || scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) {
    throw new Error(`Rollback layout escapes workspace: ${target}`);
  }
  let current = root;
  for (const part of scoped.split(sep)) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Unsafe symbolic-link rollback layout ancestor: ${current}`);
  }
}

function parseLease(value: unknown, mode: PruneMode): LeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lease is not an object");
  const record = value as Partial<LeaseRecord>;
  if (typeof record.owner !== "string" || !TOKEN.test(record.owner)) throw new Error("invalid lease owner");
  if (!Number.isSafeInteger(record.pid) || record.pid! <= 0) throw new Error("invalid lease PID");
  if (record.startIdentity !== undefined && (typeof record.startIdentity !== "string" || !record.startIdentity)) throw new Error("invalid lease process identity");
  if (typeof record.candidate !== "string" || !validCandidateRelative(mode, record.candidate)) throw new Error("invalid lease candidate");
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) || record.createdAt < 0) throw new Error("invalid lease timestamp");
  return record as LeaseRecord;
}

function parseLock(value: unknown): LockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lock owner is not an object");
  const record = value as Partial<LockRecord>;
  if (typeof record.owner !== "string" || !TOKEN.test(record.owner)) throw new Error("invalid lock owner");
  if (!Number.isSafeInteger(record.pid) || record.pid! <= 0) throw new Error("invalid lock PID");
  if (record.startIdentity !== undefined && (typeof record.startIdentity !== "string" || !record.startIdentity)) throw new Error("invalid lock process identity");
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) || record.createdAt < 0) throw new Error("invalid lock timestamp");
  return record as LockRecord;
}

function parseDeleteIntent(value: unknown, mode: PruneMode, owner: string): DeleteIntentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("delete intent is not an object");
  const record = value as Partial<DeleteIntentRecord>;
  if (record.owner !== owner || !TOKEN.test(owner)) throw new Error("invalid delete intent owner");
  if (record.mode !== mode) throw new Error("invalid delete intent mode");
  if (typeof record.candidate !== "string" || !validCandidateRelative(mode, record.candidate)) throw new Error("invalid delete intent candidate");
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt) || record.createdAt < 0) throw new Error("invalid delete intent timestamp");
  return record as DeleteIntentRecord;
}

function readJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Metadata is not a regular file: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function pruneLockActive(layoutRoot: string, dependencies: PruneDependencies): boolean {
  const lockPath = join(layoutRoot, ".prune-lock");
  if (!existsSync(lockPath)) return false;
  const rt = runtime(dependencies);
  let record: LockRecord;
  try {
    record = parseLock(readJson(join(lockPath, "owner.json")));
  } catch (error) {
    throw new Error(`Rollback prune lock is unreadable; refusing snapshot access: ${String(error)}`);
  }
  if (rt.liveness(record.pid, record.startIdentity) !== "dead") return true;
  const stalePath = join(layoutRoot, `.stale-prune-lock-${rt.token()}`);
  try {
    renameSync(lockPath, stalePath);
    rmSync(stalePath, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(lockPath)) throw error;
  }
  return false;
}

export function createLease(layoutRoot: string, mode: PruneMode, candidate: string, dependencies: PruneDependencies = {}): LeaseHandle {
  if (!validCandidateRelative(mode, candidate)) throw new Error(`Invalid rollback lease candidate: ${candidate}`);
  const rt = runtime(dependencies);
  const owner = rt.token();
  if (!TOKEN.test(owner)) throw new Error("Invalid generated rollback lease token");
  ensureDirectory(layoutRoot);
  const leases = join(layoutRoot, ".leases");
  ensureDirectory(leases);
  const record: LeaseRecord = {
    owner,
    pid: rt.pid,
    startIdentity: rt.startIdentity(rt.pid),
    candidate,
    createdAt: rt.now(),
  };
  if (record.startIdentity === undefined) delete record.startIdentity;
  const path = join(leases, `${owner}.json`);
  atomicJson(path, record, rt.token());
  try {
    if (pruneLockActive(layoutRoot, dependencies)) {
      throw new Error("Rollback lease creation overlapped active pruning; retry protection before snapshot access");
    }
  } catch (error) {
    try { unlinkSync(path); } catch {}
    throw error;
  }
  return { path, owner, candidate, layoutRoot, record };
}

export function refreshLease(handle: LeaseHandle, mode: PruneMode, dependencies: PruneDependencies = {}): LeaseHandle {
  const expected = join(handle.layoutRoot, ".leases", `${handle.owner}.json`);
  if (resolve(handle.path) !== resolve(expected)) throw new Error("Invalid rollback lease handle path");
  try {
    const existing = parseLease(readJson(handle.path), mode);
    if (
      existing.owner === handle.owner
      && existing.candidate === handle.candidate
      && existing.pid === handle.record.pid
      && existing.startIdentity === handle.record.startIdentity
    ) return handle;
  } catch {}
  return createLease(handle.layoutRoot, mode, handle.candidate, dependencies);
}

export function releaseLease(handle: LeaseHandle): void {
  try {
    const expected = join(handle.layoutRoot, ".leases", `${handle.owner}.json`);
    if (resolve(handle.path) !== resolve(expected)) return;
    const value = readJson(handle.path) as Partial<LeaseRecord>;
    if (value.owner === handle.owner) unlinkSync(handle.path);
  } catch {}
}

export function touchActivity(candidatePath: string, now: number = Date.now()): void {
  const stat = lstatSync(candidatePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe rollback candidate: ${candidatePath}`);
  const marker = join(candidatePath, ACTIVITY_FILE);
  atomicJson(marker, { lastUsedAt: now }, defaultToken());
}

export function readLastPruneAt(layoutRoot: string): number | undefined {
  const path = join(layoutRoot, LAST_PRUNE_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const value = readJson(path) as { completedAt?: unknown };
    return typeof value.completedAt === "number" && Number.isFinite(value.completedAt) && value.completedAt >= 0
      ? value.completedAt
      : undefined;
  } catch {
    return undefined;
  }
}

export function touchLastPruneAt(layoutRoot: string, completedAt: number): void {
  if (!Number.isFinite(completedAt) || completedAt < 0) throw new Error("Invalid rollback prune completion timestamp");
  ensureDirectory(layoutRoot);
  atomicJson(join(layoutRoot, LAST_PRUNE_FILE), { completedAt }, defaultToken());
}

function allocatedBytes(stat: Stats): number {
  return typeof stat.blocks === "number" && Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;
}

function scanTree(path: string, root = path, includeRootMtime = true): { bytes: number; latestMtime: number } {
  const stat = lstatSync(path);
  let bytes = allocatedBytes(stat);
  let latestMtime = path === root && !includeRootMtime ? 0 : stat.mtimeMs;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { bytes, latestMtime };
  for (const name of readdirSync(path)) {
    if (path === root && name === ACTIVITY_FILE) continue;
    const child = scanTree(join(path, name), root, includeRootMtime);
    bytes += child.bytes;
    latestMtime = Math.max(latestMtime, child.latestMtime);
  }
  return { bytes, latestMtime };
}

function readActivity(candidatePath: string): ActivityRecord {
  const value = readJson(join(candidatePath, ACTIVITY_FILE));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("activity marker is not an object");
  const marker = value as Partial<ActivityRecord>;
  if (typeof marker.lastUsedAt !== "number" || !Number.isFinite(marker.lastUsedAt) || marker.lastUsedAt < 0) throw new Error("invalid activity timestamp");
  if (marker.discoveredAt !== undefined && (typeof marker.discoveredAt !== "number" || !Number.isFinite(marker.discoveredAt) || marker.discoveredAt < 0)) {
    throw new Error("invalid discovery timestamp");
  }
  return marker as ActivityRecord;
}

function inspectCandidate(path: string, relativePath: string, now: number, migrationGraceMs: number, token: () => string): Candidate {
  const markerPath = join(path, ACTIVITY_FILE);
  const hadMarker = existsSync(markerPath);
  const scanned = scanTree(path, path, !hadMarker);
  let activity: ActivityRecord;
  if (hadMarker) {
    activity = readActivity(path);
    if (activity.discoveredAt !== undefined && scanned.latestMtime > activity.lastUsedAt) {
      activity = { ...activity, lastUsedAt: scanned.latestMtime };
      atomicJson(markerPath, activity, token());
    }
  } else {
    activity = { lastUsedAt: scanned.latestMtime, discoveredAt: now };
    atomicJson(markerPath, activity, token());
  }
  return {
    path,
    relativePath,
    bytes: scanned.bytes,
    activity,
    migrationProtected: activity.discoveredAt !== undefined && activity.discoveredAt + migrationGraceMs > now,
  };
}

function enumerateCandidates(layoutRoot: string, mode: PruneMode, skipped: string[]): Array<{ path: string; relativePath: string }> {
  if (!existsSync(layoutRoot)) return [];
  ensureDirectory(layoutRoot);
  const result: Array<{ path: string; relativePath: string }> = [];
  const add = (path: string, relativePath: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      skipped.push(relativePath);
      return;
    }
    if (!isContained(layoutRoot, path) || !validCandidateRelative(mode, relativePath)) {
      skipped.push(relativePath);
      return;
    }
    result.push({ path, relativePath });
  };
  for (const entry of readdirSync(layoutRoot, { withFileTypes: true })) {
    const path = join(layoutRoot, entry.name);
    if (mode === "normal" && entry.name === "sessions") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        skipped.push("sessions");
        continue;
      }
      for (const child of readdirSync(path, { withFileTypes: true })) {
        const relativePath = `sessions/${child.name}`;
        if (HASH.test(child.name)) add(join(path, child.name), relativePath);
        else skipped.push(relativePath);
      }
    } else if (HASH.test(entry.name)) {
      add(path, entry.name);
    } else if (!["blobs", ".leases", ".trash", ".prune-lock", ".last-prune.json", "locks"].includes(entry.name)) {
      skipped.push(entry.name);
    }
  }
  return result;
}

function activeLeases(layoutRoot: string, mode: PruneMode, dependencies: PruneDependencies): Set<string> {
  const leases = join(layoutRoot, ".leases");
  if (!existsSync(leases)) return new Set();
  ensureDirectory(leases);
  const rt = runtime(dependencies);
  const active = new Set<string>();
  for (const entry of readdirSync(leases, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{32}\.json$/.test(entry.name)) {
      throw new Error(`Malformed rollback lease entry: ${join(leases, entry.name)}`);
    }
    const path = join(leases, entry.name);
    let record: LeaseRecord;
    try {
      record = parseLease(readJson(path), mode);
    } catch (error) {
      throw new Error(`Unreadable rollback lease ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const state = rt.liveness(record.pid, record.startIdentity);
    if (state === "dead") {
      try {
        const current = parseLease(readJson(path), mode);
        if (current.owner === record.owner) unlinkSync(path);
      } catch {}
    } else {
      active.add(record.candidate);
    }
  }
  return active;
}

function acquireLock(layoutRoot: string, dependencies: PruneDependencies): { path: string; owner: string } | undefined {
  const rt = runtime(dependencies);
  const lockPath = join(layoutRoot, ".prune-lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = rt.token();
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        const record: LockRecord = { owner, pid: rt.pid, startIdentity: rt.startIdentity(rt.pid), createdAt: rt.now() };
        if (record.startIdentity === undefined) delete record.startIdentity;
        atomicJson(join(lockPath, "owner.json"), record, rt.token());
        return { path: lockPath, owner };
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale: LockRecord;
      try {
        stale = parseLock(readJson(join(lockPath, "owner.json")));
      } catch (readError) {
        throw new Error(`Rollback prune lock is unreadable; refusing to prune: ${readError instanceof Error ? readError.message : String(readError)}`);
      }
      if (rt.liveness(stale.pid, stale.startIdentity) !== "dead") return undefined;
      const stalePath = join(layoutRoot, `.stale-prune-lock-${rt.token()}`);
      try {
        renameSync(lockPath, stalePath);
        rmSync(stalePath, { recursive: true, force: true });
      } catch (reclaimError) {
        if (attempt === 1) throw reclaimError;
      }
    }
  }
  return undefined;
}

function releaseLock(lock: { path: string; owner: string }): void {
  try {
    const record = parseLock(readJson(join(lock.path, "owner.json")));
    if (record.owner === lock.owner) rmSync(lock.path, { recursive: true, force: true });
  } catch {}
}

function inspectTrash(layoutRoot: string, mode: PruneMode, report: PruneReport): TrashCandidate[] {
  const trash = join(layoutRoot, ".trash");
  if (!existsSync(trash)) return [];
  ensureDirectory(trash);
  const planned: TrashCandidate[] = [];
  for (const entry of readdirSync(trash, { withFileTypes: true })) {
    const path = join(trash, entry.name);
    const match = entry.name.match(/^([0-9a-f]{32})-([0-9a-f]{24})$/);
    if (!match || !entry.isDirectory() || entry.isSymbolicLink()) {
      report.skipped.push(relative(layoutRoot, path));
      continue;
    }
    try {
      const intent = parseDeleteIntent(readJson(join(path, DELETE_INTENT_FILE)), mode, match[1]!);
      if (basename(intent.candidate) !== match[2]) throw new Error("delete intent does not match quarantine name");
      planned.push({ path, relativePath: relative(layoutRoot, path), bytes: scanTree(path).bytes });
    } catch {
      report.skipped.push(relative(layoutRoot, path));
    }
  }
  return planned;
}

function sameActivity(a: ActivityRecord, b: ActivityRecord): boolean {
  return a.lastUsedAt === b.lastUsedAt && a.discoveredAt === b.discoveredAt;
}

export function pruneSnapshots(options: PruneOptions): PruneReport {
  const report: PruneReport = { planned: [], removed: [], bytesRemoved: 0, remainingBytes: 0, skipped: [], protected: [], errors: [] };
  if (!options.config.enabled) {
    if (options.config.warning) report.errors.push(options.config.warning);
    return report;
  }
  const layoutRoot = resolve(options.layoutRoot);
  const dependencies = options.dependencies ?? {};
  const rt = runtime(dependencies);
  try {
    assertSafeLayoutRoot(layoutRoot, options.containmentRoot);
    ensureDirectory(layoutRoot);
    const lock = acquireLock(layoutRoot, dependencies);
    if (!lock) {
      report.errors.push("Rollback pruning skipped because another live process owns the prune lock");
      return report;
    }
    try {
      const leased = activeLeases(layoutRoot, options.mode, dependencies);
      const trashPlan = inspectTrash(layoutRoot, options.mode, report);
      if (options.currentCandidate) {
        if (!validCandidateRelative(options.mode, options.currentCandidate)) throw new Error(`Invalid current rollback candidate: ${options.currentCandidate}`);
        leased.add(options.currentCandidate);
      }
      const candidates: Candidate[] = [];
      let incompletePlan = false;
      for (const item of enumerateCandidates(layoutRoot, options.mode, report.skipped)) {
        try {
          const candidate = inspectCandidate(item.path, item.relativePath, rt.now(), options.config.migrationGraceMs, rt.token);
          candidates.push(candidate);
          if (leased.has(item.relativePath)) report.protected.push(item.relativePath);
        } catch (error) {
          incompletePlan = true;
          report.protected.push(item.relativePath);
          report.errors.push(`Could not safely inspect ${item.path}: ${String(error)}`);
        }
      }
      report.remainingBytes = candidates.reduce((sum, item) => sum + item.bytes, 0);
      if (incompletePlan) return report;
      const inactive = candidates.filter((item) => !leased.has(item.relativePath));
      const expired = inactive
        .filter((item) => !item.migrationProtected && item.activity.lastUsedAt + options.config.retentionMs <= rt.now())
        .sort((a, b) => a.activity.lastUsedAt - b.activity.lastUsedAt || a.relativePath.localeCompare(b.relativePath));
      const planned = new Set(expired.map((item) => item.relativePath));
      let projected = report.remainingBytes - expired.reduce((sum, item) => sum + item.bytes, 0);
      if (options.config.maxBytes > 0 && projected > options.config.maxBytes) {
        const oldest = inactive
          .filter((item) => !item.migrationProtected && !planned.has(item.relativePath))
          .sort((a, b) => a.activity.lastUsedAt - b.activity.lastUsedAt || a.relativePath.localeCompare(b.relativePath));
        for (const item of oldest) {
          if (projected <= options.config.maxBytes) break;
          planned.add(item.relativePath);
          projected -= item.bytes;
        }
      }
      const byRelative = new Map(candidates.map((item) => [item.relativePath, item]));
      const candidatePlan = [...planned];
      report.planned = [...trashPlan.map((item) => item.relativePath), ...candidatePlan];
      for (const item of trashPlan) {
        try {
          const stat = lstatSync(item.path);
          if (!stat.isDirectory() || stat.isSymbolicLink() || !isContained(layoutRoot, item.path)) throw new Error("quarantine path changed or became unsafe");
          rmSync(item.path, { recursive: true, force: true });
          report.removed.push(item.relativePath);
          report.bytesRemoved += item.bytes;
        } catch (error) {
          report.errors.push(`Could not remove quarantined snapshot ${item.path}: ${String(error)}`);
        }
      }
      for (const relativePath of candidatePlan) {
        const candidate = byRelative.get(relativePath)!;
        let currentLeases: Set<string>;
        try {
          currentLeases = activeLeases(layoutRoot, options.mode, dependencies);
        } catch (error) {
          report.errors.push(`Could not revalidate rollback leases: ${String(error)}`);
          break;
        }
        if (options.currentCandidate) currentLeases.add(options.currentCandidate);
        if (currentLeases.has(relativePath)) {
          report.protected.push(relativePath);
          continue;
        }
        try {
          const stat = lstatSync(candidate.path);
          if (!stat.isDirectory() || stat.isSymbolicLink() || !isContained(layoutRoot, candidate.path)) throw new Error("candidate path changed or became unsafe");
          const activity = readActivity(candidate.path);
          if (!sameActivity(activity, candidate.activity)) {
            report.protected.push(relativePath);
            continue;
          }
          const trash = join(layoutRoot, ".trash");
          ensureDirectory(trash);
          const owner = rt.token();
          if (!TOKEN.test(owner)) throw new Error("Invalid generated rollback quarantine token");
          const quarantined = join(trash, `${owner}-${basename(candidate.path)}`);
          renameSync(candidate.path, quarantined);
          atomicJson(join(quarantined, DELETE_INTENT_FILE), {
            owner,
            candidate: relativePath,
            mode: options.mode,
            createdAt: rt.now(),
          } satisfies DeleteIntentRecord, rt.token());
          rmSync(quarantined, { recursive: true, force: true });
          report.removed.push(relativePath);
          report.bytesRemoved += candidate.bytes;
          report.remainingBytes -= candidate.bytes;
        } catch (error) {
          report.errors.push(`Could not remove rollback snapshot ${candidate.path}: ${String(error)}`);
        }
      }
    } finally {
      releaseLock(lock);
    }
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  }
  return report;
}
