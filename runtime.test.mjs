// pi-rollback regression tests, driven through the real Pi extension loader so
// `pi.exec`, entry appends, and the registered commands/tools behave exactly as
// in production.
// Run: node --test runtime.test.mjs
//
// Covers the audit findings:
// - a failed or cancelled rollback must restore the exact pre-rollback
//   workspace state, not the journaled after-state (out-of-band edits survive),
// - restoring a file must never recursively delete a directory that replaced it,
// - per-session bookkeeping (run/turn counters, labels, unflushed captures) must
//   not leak when one long-lived agent process moves to the next session,
// - a destructive-command guard failure must not lose protection for the rest
//   of the turn,
// - plus the journal helpers the rollback engine relies on (destructive-command
//   detection, path scoping, file-state restore semantics).
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = process.env.PI_RUNTIME_DIR ?? "/home/stan/.local/share/pi-framework/pi-runtime";
const fromRuntime = (path) => import(pathToFileURL(join(root, path)).href);
const { loadExtensions, createExtensionRuntime } = await fromRuntime("dist/core/extensions/loader.js");

// The package lives outside this repo (installed under ~/.pi/agent/local).
const PACKAGE_DIR = process.env.PI_ROLLBACK_PACKAGE_DIR ?? fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_INDEX = join(PACKAGE_DIR, "index.ts");
const PACKAGE_JOURNAL = join(PACKAGE_DIR, "journal.ts");

// The loader only surfaces the default export, so a probe module re-exports the
// journal helpers on globalThis and injects isolated store roots (never the real
// ~/.pi/agent/rollback-snapshots).
const PROBE = `
import rollbackExtension from ${JSON.stringify(PACKAGE_INDEX)};
import * as journal from ${JSON.stringify(PACKAGE_JOURNAL)};
export default function probe(pi: any) {
	(globalThis as any).__piRollbackJournal = journal;
	rollbackExtension(pi, {
		normalLayoutRoot: process.env.PI_ROLLBACK_TEST_LAYOUT,
		blobRoot: process.env.PI_ROLLBACK_TEST_BLOBS,
		pruneSettingsPath: process.env.PI_ROLLBACK_TEST_SETTINGS,
		pruneEnv: { PI_ROLLBACK_PRUNE: "0" },
	});
}
`;

async function loadRollback(t, { deepTracking = false } = {}) {
	const work = await mkdtemp(join(tmpdir(), "pi-rb-work-"));
	const layout = await mkdtemp(join(tmpdir(), "pi-rb-layout-"));
	const blobs = await mkdtemp(join(tmpdir(), "pi-rb-blobs-"));
	const agentDir = await mkdtemp(join(tmpdir(), "pi-rb-agent-"));
	const probePath = join(work, ".rollback-probe.ts");
	await writeFile(probePath, PROBE);
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		layout: process.env.PI_ROLLBACK_TEST_LAYOUT,
		blobs: process.env.PI_ROLLBACK_TEST_BLOBS,
		settings: process.env.PI_ROLLBACK_TEST_SETTINGS,
		deep: process.env.PI_ROLLBACK_DEEP_TRACKING,
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_ROLLBACK_TEST_LAYOUT = layout;
	process.env.PI_ROLLBACK_TEST_BLOBS = blobs;
	process.env.PI_ROLLBACK_TEST_SETTINGS = join(agentDir, "settings.json");
	process.env.PI_ROLLBACK_DEEP_TRACKING = deepTracking ? "1" : "0";
	t.after(async () => {
		for (const [key, value] of [
			["PI_CODING_AGENT_DIR", previous.agentDir],
			["PI_ROLLBACK_TEST_LAYOUT", previous.layout],
			["PI_ROLLBACK_TEST_BLOBS", previous.blobs],
			["PI_ROLLBACK_TEST_SETTINGS", previous.settings],
			["PI_ROLLBACK_DEEP_TRACKING", previous.deep],
		]) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const dir of [work, layout, blobs, agentDir]) await rm(dir, { recursive: true, force: true });
	});

	const branch = [];
	const labels = new Map();
	const notifications = [];
	const navigations = [];
	const emitted = [];
	const control = { failNextSetLabel: false };
	let entrySeq = 0;
	let leafId = "e0";
	branch.push({ type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "start" }] } });

	const runtime = createExtensionRuntime();
	runtime.appendEntry = (customType, data) => {
		const id = `e${++entrySeq}`;
		branch.push({ type: "custom", id, customType, data });
		leafId = id;
		return id;
	};
	runtime.setLabel = (id, label) => {
		if (control.failNextSetLabel) {
			control.failNextSetLabel = false;
			throw new Error("simulated label failure");
		}
		labels.set(id, label);
	};
	runtime.sendUserMessage = async (content) => {
		emitted.push(content);
	};

	const loaded = await loadExtensions([probePath], work, undefined, runtime);
	assert.deepEqual(loaded.errors, [], "probe extension must load without errors");
	const extension = loaded.extensions[0];
	const journal = globalThis.__piRollbackJournal;
	assert.ok(journal, "probe must expose the journal helpers");

	const ctxFor = () => ({
		cwd: work,
		hasUI: true,
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			select: async () => undefined,
			input: async () => undefined,
			confirm: async () => true,
		},
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => branch,
			getLeafId: () => leafId,
			getSessionId: () => "session-a",
		},
		waitForIdle: async () => {},
		navigateTree: async (entryId, options) => {
			navigations.push({ entryId, options });
			return { cancelled: false };
		},
	});
	const emit = async (name, event = {}, ctx = ctxFor()) => {
		let result;
		for (const handler of extension.handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
		return result;
	};
	const entriesOf = (customType) => branch.filter((entry) => entry.type === "custom" && entry.customType === customType).map((entry) => entry.data);
	const runTool = async (name, params) => {
		const tool = extension.tools.get(name);
		assert.ok(tool, `${name} tool must be registered`);
		return tool.definition.execute("call-1", params, undefined, undefined, ctxFor());
	};
	const runCommand = async (name, args) => {
		const command = extension.commands.get(name);
		assert.ok(command, `${name} command must be registered`);
		return command.handler(args, ctxFor());
	};

	// A turn is the unit that flushes the journal, so tests drive the same
	// lifecycle the agent does: agent_start -> turn_start -> tool_call -> turn_end.
	const beginTurn = async (turnIndex = 0) => {
		if (turnIndex === 0) await emit("agent_start");
		await emit("turn_start", { turnIndex });
	};
	const writeViaTool = async (toolName, path, content) => {
		await emit("tool_call", { toolName, input: { path } });
		await mkdir(join(work, path, ".."), { recursive: true });
		await writeFile(join(work, path), content);
	};

	return { work, layout, blobs, branch, labels, notifications, navigations, emitted, control, extension, journal, ctxFor, emit, entriesOf, runTool, runCommand, beginTurn, writeViaTool };
}

test("checkpoint -> edit -> rollback restores files, deletions, and creations end to end", async (t) => {
	const harness = await loadRollback(t);
	const { work } = harness;
	await writeFile(join(work, "a.txt"), "alpha-v1");
	await mkdir(join(work, "sub"), { recursive: true });
	await writeFile(join(work, "sub", "b.ts"), "export const b = 1;\n");
	await writeFile(join(work, "keep.txt"), "keep-me");

	await harness.beginTurn(0);
	// The checkpoint anchors on the leaf before itself, and the rollback later
	// navigates to the checkpoint entry so the restore point survives.
	const beforeEntryId = harness.branch.at(-1).id;
	const saved = await harness.runTool("checkpoint", { label: "before edits" });
	assert.equal(saved.details.saved, true);
	const checkpointEntryId = harness.branch.at(-1).id;
	const checkpoint = harness.entriesOf("pi-rollback-checkpoint").at(-1);
	assert.equal(checkpoint.label, "before edits");
	assert.equal(checkpoint.entryId, beforeEntryId);
	assert.equal(harness.labels.get(beforeEntryId), "before edits");

	// Journaled edits: modify one file, delete another, create a third.
	await harness.writeViaTool("write", "a.txt", "alpha-v2");
	await harness.emit("tool_call", { toolName: "bash", input: { command: "rm keep.txt" } });
	await rm(join(work, "keep.txt"));
	await harness.writeViaTool("write", "new.txt", "brand new");
	await harness.emit("turn_end", { turnIndex: 0 });
	assert.equal(harness.entriesOf("pi-rollback-mutation").length, 3, "every journaled change must be recorded once");

	await harness.runCommand("rollback", "before edits");

	assert.deepEqual(harness.navigations.at(-1), {
		entryId: checkpointEntryId,
		options: {
			summarize: true,
			customInstructions: "Keep only validated findings from the abandoned rollback branch.",
			label: "rollback-before edits",
		},
	});
	assert.equal(await readFile(join(work, "a.txt"), "utf8"), "alpha-v1", "modified file must be restored");
	assert.equal(await readFile(join(work, "sub", "b.ts"), "utf8"), "export const b = 1;\n", "untouched file must survive");
	assert.equal(await readFile(join(work, "keep.txt"), "utf8"), "keep-me", "deleted file must come back");
	assert.equal(existsSync(join(work, "new.txt")), false, "file created after the checkpoint must be removed");

	const result = harness.entriesOf("pi-rollback-result").at(-1);
	assert.equal(result.ok, true);
	assert.equal(result.targetLabel, "before edits");
	const redo = harness.entriesOf("pi-rollback-redo").at(-1);
	assert.equal(redo.targetEntryId, checkpointEntryId);

	// Redo restores the post-checkpoint state.
	await harness.runCommand("redo", "");
	assert.equal(await readFile(join(work, "a.txt"), "utf8"), "alpha-v2");
	assert.equal(existsSync(join(work, "keep.txt")), false);
	assert.equal(await readFile(join(work, "new.txt"), "utf8"), "brand new");
});

test("a cancelled rollback restores the exact workspace state, including unjournaled edits", async (t) => {
	// Root (bash) mutations are replayed as whole workspace trees. Unlike the
	// per-file journal, nothing reconciles a tree with out-of-band edits, so the
	// undo path must restore the captured pre-rollback tree instead of the
	// journaled "after" tree.
	const harness = await loadRollback(t, { deepTracking: true });
	const { work } = harness;
	await writeFile(join(work, "f.txt"), "v1");
	await harness.beginTurn(0);
	await harness.runTool("checkpoint", { label: "base" });
	// A shell write: journaled as a workspace tree snapshot, not a file mutation.
	await harness.emit("tool_call", { toolName: "bash", input: { command: "echo v2 > f.txt" } });
	await writeFile(join(work, "f.txt"), "v2");
	await harness.emit("turn_end", { turnIndex: 0 });
	assert.equal(harness.entriesOf("pi-rollback-mutation").length, 1, "the shell write must be journaled as one root mutation");

	// An edit the journal does not know about, made after the last capture.
	await writeFile(join(work, "f.txt"), "external-v3");

	// navigateTree cancels: the rollback must be undone exactly, so the
	// unjournaled "external-v3" content must survive instead of being rewound
	// to the journaled "v2".
	const ctx = harness.ctxFor();
	ctx.navigateTree = async (entryId) => {
		harness.navigations.push({ entryId });
		return { cancelled: true };
	};
	const command = harness.extension.commands.get("rollback");
	await command.handler("base", ctx);

	assert.equal(await readFile(join(work, "f.txt"), "utf8"), "external-v3");
	const result = harness.entriesOf("pi-rollback-result").at(-1);
	assert.equal(result.ok, false);
	assert.equal(result.error, "Rollback cancelled");
	assert.deepEqual(harness.entriesOf("pi-rollback-redo"), [], "a cancelled rollback must not arm redo");
});

test("session resume continues counters and drops unflushed captures", async (t) => {
	const harness = await loadRollback(t);
	const { work } = harness;
	await writeFile(join(work, "s.txt"), "one");
	await harness.beginTurn(0);
	assert.equal(harness.entriesOf("pi-rollback-checkpoint").at(-1).label, "rollback-before-1-0");

	// A tool writes a file, but the turn ends abruptly (session switch) before
	// the journal flush: the capture belongs to the old branch.
	await harness.writeViaTool("write", "s.txt", "two");
	const mutationsBefore = harness.entriesOf("pi-rollback-mutation").length;

	// An abrupt session switch can arrive without a preceding session_shutdown,
	// leaving the capture unflushed.
	await harness.emit("session_start");
	await harness.beginTurn(0);

	assert.equal(
		harness.notifications.some((item) => item.message.includes("dropped 1 unflushed capture")),
		true,
		"the stale capture must be reported, not silently flushed into the new session",
	);
	assert.equal(harness.entriesOf("pi-rollback-mutation").length, mutationsBefore, "new session journal must stay clean");
	assert.equal(
		harness.entriesOf("pi-rollback-checkpoint").at(-1).label,
		"rollback-before-2-0",
		"run counters continue from the loaded branch",
	);
});

test("destructive commands are guarded once per turn and a failed guard is retried", async (t) => {
	const harness = await loadRollback(t);
	const destructiveCheckpoints = () => harness.entriesOf("pi-rollback-checkpoint").filter((item) => item.label.startsWith("auto-before-destructive"));
	await harness.beginTurn(0);

	// A transient guard failure must leave the turn unguarded so the next
	// destructive command retries, instead of losing protection silently.
	harness.control.failNextSetLabel = true;
	await harness.emit("tool_call", { toolName: "bash", input: { command: "rm -rf build" } });
	assert.equal(destructiveCheckpoints().length, 0, "the failed guard must not claim to have guarded the turn");
	assert.equal(
		harness.notifications.some((item) => item.message.includes("destructive guard skipped")),
		true,
		"the skipped guard must be reported",
	);
	await harness.emit("tool_call", { toolName: "bash", input: { command: "rm -rf dist" } });
	assert.equal(destructiveCheckpoints().length, 1, "the next destructive command must retry the guard");
	await harness.emit("tool_call", { toolName: "bash", input: { command: "git reset --hard HEAD" } });
	assert.equal(destructiveCheckpoints().length, 1, "a second destructive command in the same turn must not stack checkpoints");
	await harness.emit("turn_start", { turnIndex: 1 });
	await harness.emit("tool_call", { toolName: "bash", input: { command: "find . -name '*.tmp' -delete" } });
	assert.equal(destructiveCheckpoints().length, 2, "the next turn is guarded again");
});

test("rollback notes are delivered once per change, never once per request", async (t) => {
	const harness = await loadRollback(t);
	const { work } = harness;
	await writeFile(join(work, "n.txt"), "original");
	await harness.beginTurn(0);
	await harness.runTool("checkpoint", { label: "before edits" });

	const noteOf = (result) => result?.messages?.find((message) => message.customType === "pi-rollback-context");
	const first = await harness.emit("context", { messages: [{ role: "user", content: "continue" }] });
	const note = noteOf(first);
	assert.ok(note, "a named checkpoint must be announced, or rollback(targetLabel) is unusable");
	assert.match(note.content, /automatic note, not a user message/);
	assert.match(note.content, /Restore points/);
	assert.match(note.content, /"before edits"/);
	assert.match(note.content, /targetLabel/);

	// `context` runs for every request, so an unchanged state must stay silent:
	// the 2026-10-18 session 01a14cd5 repeated this line ~119 times and the model
	// spent reasoning steps deciding it was "just noise".
	for (let request = 0; request < 5; request++) {
		const repeat = await harness.emit("context", { messages: [{ role: "user", content: "continue" }] });
		assert.equal(noteOf(repeat), undefined, "an unchanged note must not be re-appended");
	}

	// A rollback truncates the branch, so without the projection the model never
	// learns that it happened.
	await harness.writeViaTool("write", "n.txt", "changed");
	await harness.emit("turn_end", { turnIndex: 0 });
	await harness.runCommand("rollback", "before edits");
	await harness.emit("turn_start", { turnIndex: 1 });
	const third = await harness.emit("context", { messages: [] });
	const outcome = noteOf(third);
	assert.ok(outcome, "the post-rollback turn must see the outcome");
	assert.match(outcome.content, /Rollback ok: restored 1 file\(s\) to "before edits"/);
	// Delivered once: the next request is clean again.
	const after = await harness.emit("context", { messages: [] });
	assert.equal(noteOf(after), undefined);
	assert.equal(await readFile(join(work, "n.txt"), "utf8"), "original");
});

test("a named checkpoint survives the rollback that restores it, and turn targets work", async (t) => {
	const harness = await loadRollback(t);
	const { work, branch } = harness;
	await writeFile(join(work, "state.txt"), "start");
	await harness.beginTurn(0);
	await harness.runTool("checkpoint", { label: "base" });
	await harness.writeViaTool("write", "state.txt", "turn-0");
	await harness.emit("turn_end", { turnIndex: 0 });
	await harness.emit("turn_start", { turnIndex: 1 });
	await harness.writeViaTool("write", "state.txt", "turn-1");
	await harness.emit("turn_end", { turnIndex: 1 });
	await harness.emit("turn_start", { turnIndex: 2 });

	// turn 1 undoes the last completed turn only (the turn-1 write).
	await harness.runCommand("rollback", "turn 1");
	assert.equal(await readFile(join(work, "state.txt"), "utf8"), "turn-0");
	assert.equal(harness.entriesOf("pi-rollback-result").at(-1).ok, true);

	// The named checkpoint is the navigation target, so it is still there and a
	// second restore to it works (previously it truncated itself away).
	assert.equal(
		branch.some((entry) => entry.customType === "pi-rollback-checkpoint" && entry.data?.label === "base"),
		true,
	);
	await harness.runCommand("rollback", "base");
	assert.equal(await readFile(join(work, "state.txt"), "utf8"), "start");
});

test("two failed edits on the same file add a rollback nudge to the context", async (t) => {
	const harness = await loadRollback(t);
	const call = (id, args) => ({ type: "message", id: `${id}-call`, message: { role: "assistant", content: [{ type: "toolCall", id, name: "edit", arguments: args }] } });
	const failed = (id) => ({ type: "message", id: `${id}-result`, message: { role: "toolResult", toolCallId: id, toolName: "edit", isError: true, content: [] } });
	const noteOf = (result) => result?.messages?.find((message) => message.customType === "pi-rollback-context");

	await harness.beginTurn(0);
	// A completed turn gives the nudge a rollback target to point at.
	await harness.emit("turn_end", { turnIndex: 0 });
	harness.branch.push(call("f1", { path: "src/a.ts" }), failed("f1"));
	const one = noteOf(await harness.emit("context", { messages: [] }));
	assert.ok(!one || !/consecutive failed edit/.test(one.content), "a single failure must not nudge");

	harness.branch.push(call("f2", { path: "src/a.ts" }), failed("f2"));
	const two = noteOf(await harness.emit("context", { messages: [] }));
	assert.ok(two, "the second failure must be surfaced");
	assert.match(two.content, /2 consecutive failed edits on src\/a\.ts/);
	// The nudge is keyed by file, not by request: a repeat request stays silent.
	assert.equal(noteOf(await harness.emit("context", { messages: [] })), undefined);
	assert.match(two.content, /rollback\(\{turns:1\}\)/);

	// A successful edit on the same file clears the nudge.
	harness.branch.push({ type: "message", id: "ok-call", message: { role: "assistant", content: [{ type: "toolCall", id: "ok", name: "edit", arguments: { path: "src/a.ts" } }] } });
	harness.branch.push({ type: "message", id: "ok-result", message: { role: "toolResult", toolCallId: "ok", toolName: "edit", isError: false, content: [] } });
	const three = noteOf(await harness.emit("context", { messages: [] }));
	assert.ok(!three || !/consecutive failed edit/.test(three.content), "a success must clear the nudge");
});

test("journal: file states round-trip and directory conflicts fail closed", async (t) => {
	const harness = await loadRollback(t);
	const { journal, blobs } = harness;
	const dir = await mkdtemp(join(tmpdir(), "pi-rb-journal-"));
	t.after(async () => rm(dir, { recursive: true, force: true }));

	const file = join(dir, "tool.sh");
	await writeFile(file, "#!/bin/sh\necho hi\n");
	await chmod(file, 0o755);
	const state = journal.captureFileState(file, blobs);
	assert.equal(state.kind, "file");
	await writeFile(file, "overwritten");
	await chmod(file, 0o644);
	journal.restoreFileState(file, state, blobs);
	assert.equal(await readFile(file, "utf8"), "#!/bin/sh\necho hi\n");
	assert.equal((await stat(file)).mode & 0o777, 0o755, "mode must be restored");

	// Missing state removes a regular file but refuses a directory.
	const extra = join(dir, "extra.txt");
	await writeFile(extra, "x");
	journal.restoreFileState(extra, { kind: "missing" }, blobs);
	assert.equal(existsSync(extra), false);
	await mkdir(extra);
	assert.throws(() => journal.restoreFileState(extra, { kind: "missing" }, blobs), /Refusing to remove directory/);
	assert.equal(existsSync(extra), true);

	// A restored file must not delete a directory that took its place.
	await rm(extra, { recursive: true });
	await mkdir(join(extra, "nested"), { recursive: true });
	await writeFile(join(extra, "nested", "work.txt"), "unrelated");
	assert.throws(() => journal.restoreFileState(extra, state, blobs), /Refusing to replace directory with a restored file/);
	assert.equal(await readFile(join(extra, "nested", "work.txt"), "utf8"), "unrelated", "the directory tree must survive");
});

test("journal: mutation paths, destructive detection, and shell hints stay conservative", async (t) => {
	const harness = await loadRollback(t);
	const { journal, work } = harness;
	await mkdir(join(work, "src"), { recursive: true });
	await writeFile(join(work, "src", "x.ts"), "x");
	const cwd = await (await import("node:fs/promises")).realpath(work);

	assert.deepEqual(journal.mutationPaths("write", { path: "src/x.ts" }, cwd, false), [join(cwd, "src", "x.ts")]);
	assert.deepEqual(journal.mutationPaths("ts_morph", { filePath: "src/x.ts" }, cwd, false), [join(cwd, "src", "x.ts")]);
	assert.deepEqual(journal.mutationPaths("read", { path: "src/x.ts" }, cwd, false), [], "read-only tools never journal");
	assert.deepEqual(journal.mutationPaths("write", { path: "/etc/passwd" }, cwd, true), [], "sandbox mode drops external paths");
	assert.deepEqual(journal.mutationPaths("write", { path: "/etc/passwd" }, cwd, false), ["/etc/passwd"]);

	for (const command of [
		"rm -rf build",
		"sudo rm file",
		"git reset --hard HEAD",
		"git checkout -- .",
		"git clean -fdx",
		"find . -name '*.tmp' -delete",
		"xargs rm < list.txt",
		"dd if=/dev/zero of=disk.img",
		"psql -c 'DROP TABLE users'",
		"Remove-Item -Recurse -Force .\\dist",
	]) {
		assert.equal(journal.isDestructiveCommand(command), true, `must flag: ${command}`);
	}
	for (const command of [
		"echo hello > out.txt",
		"npm test",
		"git status",
		"grep -rn perform src/",
		"chmod 644 file.txt",
		"ls -la",
	]) {
		assert.equal(journal.isDestructiveCommand(command), false, `must not flag: ${command}`);
	}

	const hints = journal.bashPathHints("cd sub && git -C repo status", cwd, "linux");
	assert.deepEqual(hints, [join(cwd, "sub"), join(cwd, "repo")]);
	assert.deepEqual(journal.bashPathHints("rm -rf /", cwd, "linux"), [], "filesystem root is never hinted");
});
