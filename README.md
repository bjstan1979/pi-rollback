# pi-rollback

Global Pi extension for rolling conversation context and workspace files back to an earlier checkpoint.

## Install

```bash
pi install git:github.com/bjstan1979/pi-rollback
```

Then restart Pi or run `/reload`. Review the source before installation: Pi extensions execute with the same filesystem permissions as Pi.

## Usage

```text
/checkpoint before-refactor
/checkpoints
/rollback 1
/rollback before-refactor
/rollback before-refactor -- Try the smaller fix.
/rollback entry:<session-entry-id>
/redo
/rollback-prune
```

For the slash command, a numeric target counts checkpoints, not whole agent runs. Use an explicit label such as `rollback-before-1-0` when you want a specific run boundary.

Pi also exposes an LLM-callable `rollback` tool. Its `count` addresses whole agent runs and is resolved to a stable `targetEntryId` before the follow-up command is queued. Automatic checkpoints are captured before and after each model turn.

### Extension integration

Other Pi extensions can dispatch a run-relative rollback with a correlation ID:

```text
/rollback {"runCount":1,"requestId":"control-123","continuePrompt":"Retry from the restored state."}
```

Completion is persisted as a `pi-rollback-result` session entry and emitted on the shared `pi-rollback:result` event. The result includes `requestId`, `ok`, the resolved `targetEntryId`, restored file count, and an error on failure.

### Redo

`/redo` reverses the most recent rollback: it restores each mutation's `after` state and navigates back to the exact pre-rollback session leaf, making that branch's checkpoints active again.

Rollback never deletes later checkpoints; they remain on the original inactive branch. Redo returns to that branch, so its checkpoints appear in `/checkpoints` again. Redo is single-level and is refused if the rollback branch or covered files changed, preventing it from overwriting new work.

## Tracking modes

### Normal Pi

- `write`, `edit`, `undo_last_edit`, and `ts_morph` are journaled by their actual canonical file path, including paths outside Pi's cwd.
- File contents are deduplicated in `~/.pi/agent/rollback-snapshots/blobs/`.
- Bash/PowerShell full-tree snapshots are disabled by default so turn submission never blocks on large or historical roots.
- Set `PI_ROLLBACK_DEEP_TRACKING=1` before starting Pi to opt into shell snapshots for cwd and roots inferred from the current command, plus next-turn checks for directly journaled files. Historical shell roots are never rescanned at turn boundaries.

### HCOM sandbox

Detected only when `HCOM_WORKER_SANDBOX` is `workspace` or `podman-workspace`; `off` remains normal mode.

- Tracking and restore are strictly cwd-only.
- Full cwd snapshots cover file tools and shell commands.
- Session-isolated shadow repositories are stored below `<cwd>/.pi/.rollback-snapshots/` because cwd is the writable sandbox boundary; that directory excludes itself from snapshots.
- Podman workers use a persistent workspace-private `PI_CODING_AGENT_DIR`; install/copy this extension into that private extension directory before starting the worker. Host-global extensions are not mirrored automatically.

## Storage lifecycle

Whole session snapshot stores are pruned automatically. Normal Pi prunes session stores under `~/.pi/agent/rollback-snapshots/sessions/` plus legacy direct 24-character hash directories in `~/.pi/agent/rollback-snapshots/`. A sandbox prunes only direct 24-character session directories in its current workspace's `<cwd>/.pi/.rollback-snapshots/`; it never scans other workspaces. Unknown names, files, symlinks (including sandbox layout ancestors), infrastructure directories, active stores, the current session store, and stores referenced anywhere in the loaded session tree are not deletion candidates.

The default policy runs on session start and then at most every 6 hours after an agent settles. By default the extension reads these top-level keys from the global Pi settings file (`$PI_CODING_AGENT_DIR/settings.json`, normally `~/.pi/agent/settings.json`). Process environment variables with the same names override file values, which makes one-off launches possible without editing the file.

```json
{
  "PI_ROLLBACK_PRUNE": 1,
  "PI_ROLLBACK_RETENTION_DAYS": 7,
  "PI_ROLLBACK_MAX_STORE_GB": 10,
  "PI_ROLLBACK_PRUNE_INTERVAL_HOURS": 6,
  "PI_ROLLBACK_MIGRATION_GRACE_DAYS": 7
}
```

Configuration semantics:

- `PI_ROLLBACK_PRUNE=1` enables automatic pruning; set it to `0` to disable it.
- `PI_ROLLBACK_RETENTION_DAYS=7` removes inactive stores after seven days.
- `PI_ROLLBACK_MAX_STORE_GB=10` is a soft whole-store cap. After age cleanup, the oldest eligible inactive stores are removed until the known candidate total is below the cap. Active/current stores are never removed, so they may leave the store over cap. Set this to `0` for no size cap.
- `PI_ROLLBACK_PRUNE_INTERVAL_HOURS=6` controls settled-event opportunities; `0` checks every opportunity.
- `PI_ROLLBACK_MIGRATION_GRACE_DAYS=7` protects stores first discovered without an activity marker; `0` removes that migration delay.

All numeric settings accept finite non-negative JSON numbers or numeric strings. `PI_ROLLBACK_PRUNE` accepts `0`, `1`, `false`, or `true`. One invalid, negative, blank, or non-finite effective value disables automatic pruning for that Pi process and emits one warning. An unreadable or malformed settings file also disables pruning. `/rollback-prune` applies the configured policy immediately (there is no force mode) and reports reclaimed and remaining allocated bytes.

Successful shadow-Git captures atomically update store activity. During the migration grace window, pre-feature stores also refresh from nested filesystem activity so an older running extension is not mistaken for an idle store. Per-process leases contain an owner token, PID, Linux process-start identity when available, candidate path, and creation time; multiple live leases can protect the same store. Pruning uses an atomic owner-record lock, reclaims it only when its owner is provably dead, plans all candidate removals before changing the store, revalidates leases/activity before each removal, and atomically quarantines each store in `.trash` before deletion. Quarantine cleanup requires a matching deletion-intent record; unverifiable directories are left untouched. Malformed or unreadable lease, lock, activity, or candidate metadata fails closed rather than weakening protection.

Pruning is deliberately whole-store only: it does not delete checkpoints, Git refs, or Git objects inside a retained session. Reference-safe garbage collection for content-addressed `blobs/` is intentionally deferred, so that shared blob directory can still grow; this release addresses growth from accumulated shadow repositories without risking blobs referenced by journal entries.

Once an inactive session store is pruned, resuming that old conversation does not recreate its historical shadow-Git trees. Conversation navigation may still work, but rollback/redo operations that require those removed workspace snapshots will fail safely. Keep a longer retention window if old sessions must remain fully resumable.

## Safety

- Conversation rollback uses Pi's non-destructive `ctx.navigateTree()`.
- Project Git branches, commits, index, and stash list are not modified.
- Root restores are reversed if a Git operation, tree navigation, or cancellation interrupts the rollback.
- A sandbox process refuses checkpoint data targeting paths outside its cwd.

## Limits

- `PI_ROLLBACK_DEEP_TRACKING=1` requires `git` on `PATH` and can be slow for large shell/root snapshots; leave it disabled unless shell rollback is worth the latency.
- Arbitrary shell side effects cannot be inferred perfectly. Commands using dynamic environment variables, complex subshells, generated paths, databases, services, network resources, or files outside detected roots may not be recoverable.
- Ignored or unreadable files are excluded from root snapshots unless they were directly journaled by a native file tool; other Git failures still fail closed.
- Deep-tracking shadow Git operations are serialized only within one Pi process. Running two Pi processes against the same session simultaneously is unsupported; their session leases prevent pruning, but they can still contend on the same Git index.
- File attributes such as setuid/setgid bits, POSIX ACLs, extended attributes (xattr), and directory permission bits are not tracked or restored.
- File restore operates strictly on regular files; restoring a path that has since been converted to a directory is refused to prevent unintended data loss.
