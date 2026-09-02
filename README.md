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
/rollback {"targetLabel":"before-refactor"}
/rollback {"targetLabel":"before-refactor","continuePrompt":"Try the smaller fix."}
/rollback {"targetEntryId":"<session-entry-id>"}
```

Pi also exposes an LLM-callable `rollback` tool. Its `count` addresses whole agent runs and is resolved to a stable `targetEntryId` before the follow-up command is queued. Automatic checkpoints are captured before and after each model turn.

## Tracking modes

### Normal Pi

- `write`, `edit`, `undo_last_edit`, and `ts_morph` are journaled by their actual canonical file path, including paths outside Pi's cwd.
- File contents are deduplicated in `~/.pi/agent/rollback-snapshots/blobs/`.
- Bash/PowerShell use shadow-Git snapshots for cwd, previously touched project roots, and roots inferred from `cd`, `git -C`, and absolute path arguments.
- Later external edits to known files/roots are recorded at the next turn boundary, preserving the prior agent-written state.

### HCOM sandbox

Detected only when `HCOM_WORKER_SANDBOX` is `workspace` or `podman-workspace`; `off` remains normal mode.

- Tracking and restore are strictly cwd-only.
- Full cwd snapshots cover file tools and shell commands.
- The shadow repository is stored at `<cwd>/.pi/.rollback-snapshots/` because cwd is the writable sandbox boundary; that directory excludes itself from snapshots.
- Podman workers use a persistent workspace-private `PI_CODING_AGENT_DIR`; install/copy this extension into that private extension directory before starting the worker. Host-global extensions are not mirrored automatically.

## Safety

- Conversation rollback uses Pi's non-destructive `ctx.navigateTree()`.
- Project Git branches, commits, index, and stash list are not modified.
- Restores are reversed if tree navigation fails or is cancelled.
- A sandbox process refuses checkpoint data targeting paths outside its cwd.

## Limits

- Requires `git` on `PATH` for shell/root snapshots.
- Arbitrary shell side effects cannot be inferred perfectly. Commands using dynamic environment variables, generated paths, databases, services, network resources, or files outside detected roots may not be recoverable.
- Ignored files are excluded from root snapshots unless they were directly journaled by a native file tool.
- No redo command or automatic snapshot pruning yet.
