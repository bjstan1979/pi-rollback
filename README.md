# pi-rollback

Global Pi extension for rolling conversation context and workspace files back to an earlier checkpoint.

## Install

```bash
pi install git:github.com/bjstan1979/pi-rollback
```

Then restart Pi or run `/reload`. Review the source before installation: Pi extensions execute with the same filesystem permissions as Pi.

## Usage

Checkpoints are saved automatically before and after every model turn, so undo targets always exist. The human model is "go back to when I said X": restore points anchor on your messages, not on model turns.

```text
/rollback                              # interactive picker (TUI/RPC): one entry per message you sent
/rollback                              # without dialogs (print/json): one checkpoint back
/rollback 3                            # three checkpoints back
/rollback before the big refactor      # fuzzy label match (case-insensitive)
/rollback turn 1                       # undo the last completed turn
/rollback run 2                        # start of the run before last
/rollback before refactor -- Try the smaller fix.
/rollback entry:<session-entry-id>     # exact power-user form
/checkpoint before the big refactor    # bare /checkpoint asks for a label via input dialog
/checkpoints                           # interactive picker (select + confirm); Esc falls back to the text list
/checkpoints all                       # raw turn-level list
/checkpoints 60                        # last 60 raw checkpoints
/checkpoints refactor                  # filter restore points by label or message text
/redo
/rollback-prune
```

Both bare `/rollback` and bare `/checkpoints` open the picker in TUI/RPC modes; `/checkpoints` asks for a one-key confirm before restoring, and Esc at any point falls back to (or just shows) the text listing. The picker and listing show each restore point as the message you sent at that moment, plus named checkpoints and `! before destructive command` guards; turn-level auto checkpoints are collapsed because they carry no human-readable meaning.

Label matching resolves in order: exact, case-insensitive exact, then unique substring. Ambiguous or unknown labels list candidates instead of guessing. A label that itself looks like a number, `run <n>`, or `turn <n>` can be targeted with the `label:` prefix (for example `/rollback label:run 2`).

Target forms are explicit and do not shadow each other:

| Form | Meaning |
|---|---|
| `<n>` / `count` | n checkpoints back |
| `turn <n>` / `turns` | undo the last n **completed** turns (lands at the end of the turn before them, or at the run start when that includes the first turn) |
| `run <n>` / `runs` | start of the n-th agent run back |
| `<label>` | fuzzy match on a named checkpoint |
| `entry:<id>` | exact session entry (power user) |

Rolling back *to* a checkpoint navigates to the checkpoint entry itself, so the restore point stays selectable afterwards (it previously truncated its own record).

`/checkpoints all` prints the raw turn-level list with relative timestamps and the exact command that restores each entry, including run boundaries. It shows every entry; `/checkpoints <n>` shows the last n (all four restore forms work on the full checkpoint list, not just the visible window):

```text
Rollback checkpoints (oldest → newest):
  1. run 1 turn 0 start · auto · 12m ago   (/rollback 4 · /rollback run 1)
  2. run 1 turn 0 end · auto · 11m ago     (/rollback 3)
  3. before the big refactor · 9m ago      (/rollback 2)
  4. run 2 turn 0 start · auto · 4m ago    (/rollback 1 · /rollback run 2)
  … 133 older hidden — /checkpoints <n> shows the last n, /checkpoints all shows every entry, /checkpoints <text> filters by label
Restore with: /rollback <label> · /rollback <n> · /rollback turn <n> · /rollback run <n> · /redo
```

### Agent tools and automatic guards

Pi exposes two LLM-callable tools so agents participate in checkpointing instead of only reacting:

- `checkpoint` — saves a named checkpoint mid-task. Agents are prompted to call it before risky or hard-to-reverse work (bulk edits, migrations, destructive shell commands) and at stable verified states.
- `rollback` — queues a rollback. `turns: N` undoes the last N completed turns (the useful default for a failed repair), `runs: N` returns to the start of the Nth run back, `count: N` counts checkpoints back like `/rollback <n>`, and `targetLabel` (exact or fuzzy, same matching as `/rollback <label>`) / `targetEntryId` restore an explicit checkpoint. With no target it returns to the start of the current agent run. The target is resolved **when the tool is called** and queued as an exact entry, so turns that end before the queued command runs cannot shift it; everything after the target, including the calling turn, is discarded. The command runs on the follow-up turn, so stop making changes after calling it.

The model is also told what happened: a `[pi-rollback]` context note reports the last rollback outcome (`Rollback ok: restored N file(s) to "…"`), lists named restore points with how to save and restore them, and nudges when two consecutive edit attempts on the same file failed (`… fix precisely or rollback({turns:1}) instead of stacking another patch`). Each line is delivered **once per change** — never once per request — because the `context` hook runs for every request: re-appending an unchanged note repeated it in ~136 requests of one real session, where the model then spent 42 reasoning blocks deciding whether it was user input (~9.7k reasoning tokens). Notes are prefixed `automatic note, not a user message`, hidden in the UI, and reset per session.

Additionally, before a plausibly irreversible shell command (`rm`, `git reset --hard`, `git clean`, `git restore`, `find -delete`, `DROP TABLE`, `Remove-Item`, … — once per turn), the extension automatically flushes the journal, saves an `auto-before-destructive-*` checkpoint, and captures a workspace tree baseline. Bash-caused changes are otherwise unjournaled by default; the guard makes that damage revertible with `/rollback destructive`-style label matching even with deep tracking disabled. Set `PI_ROLLBACK_GUARD_DESTRUCTIVE=0` before starting Pi to disable it. When Pi runs directly in `/` or your home directory, the guard still saves the conversation checkpoint but skips the workspace tree baseline (a whole-home snapshot would time out). Detection is conservative: harmless false positives only cost one checkpoint and snapshot.

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

- `write`, `edit`, and `ts_morph` are journaled by their actual canonical file path, including paths outside Pi's cwd.
- File contents are deduplicated in `~/.pi/agent/rollback-snapshots/blobs/`.
- Bash/PowerShell full-tree snapshots are disabled by default so turn submission never blocks on large or historical roots; plausibly destructive commands are still guarded per turn (see above).
- Set `PI_ROLLBACK_DEEP_TRACKING=1` before starting Pi to opt into shell snapshots for cwd and roots inferred from the current command, plus next-turn checks for directly journaled files. Historical shell roots are never rescanned at turn boundaries. Inferred roots never include `/`, your home directory or its ancestors, or pseudo/system paths (`/dev`, `/proc`, `/sys`, `/run`, `/bin`, …), so `> /dev/null` no longer turns `/dev` into a snapshot root.

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
- Shadow Git excludes `**/.pi/.rollback-snapshots/` and `**/.pi/agent/rollback-snapshots/` at every nesting depth, including old stores in nested worktrees, in addition to the dynamically located snapshot repository/store directories. Dynamic paths are escaped as literal Gitignore paths. Ordinary `sessions/` directories (including `.pi/agent/sessions/`) remain eligible user files; there is no generic sessions exclusion.
- After staging, every capture checks the raw NUL-delimited `git ls-files -z` listing for reserved rollback-store path components and dynamic store directories. A matching path or malformed listing rejects the capture with an explicit error **before `write-tree` or `update-ref`**, so failed exclusion rules cannot publish a recursive snapshot ref. The shadow index is rebuilt from empty on every capture, removing old tracked store paths. This prevents new recursive snapshots; it does not delete objects or refs from previously contaminated stores.
- Root restores are reversed if a Git operation, tree navigation, or cancellation interrupts the rollback.
- A sandbox process refuses checkpoint data targeting paths outside its cwd.

## Limits

- `PI_ROLLBACK_DEEP_TRACKING=1` requires `git` on `PATH` and can be slow for large shell/root snapshots; leave it disabled unless shell rollback is worth the latency.
- Arbitrary shell side effects cannot be inferred perfectly. Commands using dynamic environment variables, complex subshells, generated paths, databases, services, network resources, or files outside detected roots may not be recoverable.
- Ignored or unreadable files are excluded from root snapshots unless they were directly journaled by a native file tool; other Git failures still fail closed.
- Deep-tracking shadow Git operations are serialized only within one Pi process. Running two Pi processes against the same session simultaneously is unsupported; their session leases prevent pruning, but they can still contend on the same Git index.
- File attributes such as setuid/setgid bits, POSIX ACLs, extended attributes (xattr), and directory permission bits are not tracked or restored.
- File restore operates strictly on regular files; restoring a path that has since been converted to a directory is refused to prevent unintended data loss.

## External-change reconciliation (0.4.1-local.2)

Files can change outside tool calls: commit formatting hooks (biome, prettier),
generators, any script. Those writes are invisible to the tool-call journal, so
a checkpoint's implied file states could silently lag the real disk — a later
rollback then rewound files to stale pre-hook snapshots and destroyed the
out-of-band edits (observed 2026-09-30: three source files lost commit-hook
formatting after `rollback count=1`).

Fix: `captureExternalChanges()` now runs unconditionally at `turn_start` (it
already ran at `turn_end`/`agent_settled`) and again at the start of every
rollback, before the target resolves. Every turn boundary therefore reconciles
the journal with the actual disk first, so checkpoint targets reflect reality
and out-of-band edits are preserved unless they post-date the chosen
checkpoint. `PI_ROLLBACK_DEEP_TRACKING` continues to gate only bash/powershell
root-tree tracking, which it was always meant to gate.

## Fixes in 0.6.2

- **Tree restore across file↔directory changes.** Restoring a snapshot where a path changed between file and directory failed and could not recover (`AggregateError`). Restore now deletes paths that exist only in the current tree first, then checks out the rest in batches from one `git diff --name-status` (previously two Git processes per changed file).
- **Glob-like file names.** Snapshot checkouts use `--literal-pathspecs`; names containing `*`, `?`, `[` or a leading `:` were interpreted as pathspec patterns.
- **Rollback tool target drift.** `turns`/`count`/`runs`/`targetLabel` are resolved when the tool is called. Previously they were re-resolved after the agent settled, so `turns: 1` usually undid only the final text-only reply turn.
- **Fuzzy `targetLabel` in the tool** now works as documented (it previously required an exact label).
- **`/rollback turn <n>` covering the first turn** lands at the preceding run start instead of being refused.
- **Resumed sessions** continue run numbering from existing checkpoints instead of restarting at 1 (duplicate `rollback-before-1-0` labels, wrong "current run" marker), and do not replay an old rollback outcome as a new context note.
- **`/checkpoints <text>`** filters the full restore history, not only the newest 20 entries.
- **Picker duplicates.** Identical rows (e.g. several runs started with "continue") are numbered so selecting one restores that exact point.
- **Blob writes are atomic** (temp file + rename). A crash mid-write could previously leave a truncated blob that was treated as stored, breaking every later restore of that state.
- **Turn-boundary hashing is memoized by file stat** (dev/inode/size/mode/mtime/ctime, with a racy-write window), so unchanged journaled files are no longer re-read every turn.
- **Rollback ordering.** Request validation runs before any side effect, and external-change reconciliation no longer runs before `waitForIdle()` (it could record in-flight tool writes as external changes). Failure results report the checkpoint entry id like success results.
- **Hook robustness.** Lease errors in `tool_call`, `/rollback`, `/redo` and `/checkpoint` become warnings instead of escaping the handler. `/checkpoint` asks for its label before flushing the journal.
- Deep-tracking path hints expand `~/…` and ignore `cd -`; the destructive guard also recognizes `/bin/rm`, `` `rm` ``, `del`/`erase`/`rd` and `truncate -s`.
- Minor: per-request context note reads the branch once; referenced-store scan is memoized; `/checkpoints all` listing is linear instead of quadratic.
