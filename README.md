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

## Safety

- Conversation rollback uses Pi's non-destructive `ctx.navigateTree()`.
- Project Git branches, commits, index, and stash list are not modified.
- Root restores are reversed if a Git operation, tree navigation, or cancellation interrupts the rollback.
- A sandbox process refuses checkpoint data targeting paths outside its cwd.

## Limits

- `PI_ROLLBACK_DEEP_TRACKING=1` requires `git` on `PATH` and can be slow for large shell/root snapshots; leave it disabled unless shell rollback is worth the latency.
- Arbitrary shell side effects cannot be inferred perfectly. Commands using dynamic environment variables, complex subshells, generated paths, databases, services, network resources, or files outside detected roots may not be recoverable.
- Ignored or unreadable files are excluded from root snapshots unless they were directly journaled by a native file tool; other Git failures still fail closed.
- Snapshot trees are pinned against Git garbage collection, but automatic snapshot pruning is not implemented yet. Content-addressed blobs accumulate in `~/.pi/agent/rollback-snapshots/blobs/` without automatic GC.
- File attributes such as setuid/setgid bits, POSIX ACLs, extended attributes (xattr), and directory permission bits are not tracked or restored.
- File restore operates strictly on regular files; restoring a path that has since been converted to a directory is refused to prevent unintended data loss.
