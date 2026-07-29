#!/usr/bin/env node
/**
 * PreCompact hook — orchestration state capture.
 *
 * Compaction discards the integration picture exactly when it is most expensive to lose:
 * a long multi-worker session. This writes a deterministic snapshot to the OS temp
 * directory before compaction runs; `session-brief.mjs` surfaces it on the next
 * SessionStart.
 *
 * What it captures, all read out of the transcript rather than inferred:
 *   - every worker dispatched this session, and the outcome each reported
 *   - every file the session wrote
 *
 * What it CANNOT capture, and does not pretend to: what was reconciled, which findings
 * were accepted or rejected, and which decisions are settled. That is orchestrator
 * reasoning and no hook can recover it from a transcript. The snapshot says so in its own
 * text so a post-compaction session does not mistake it for a full handoff.
 *
 * Written to the temp directory rather than the repository: nothing to .gitignore, no
 * cleanup discipline, and no session residue committed by accident.
 *
 * Fail-open by design. This is an observability surface, not an authorization boundary:
 * every failure path exits 0 and compaction proceeds. It never blocks compaction, even
 * though the event allows it.
 */

import {
  readFileSync, writeFileSync, statSync, existsSync, openSync, readSync, closeSync, chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/** A long session's transcript can be large; only the tail is worth scanning. */
const MAX_TRANSCRIPT_BYTES = 4_000_000;
const MAX_FILES_LISTED = 40;
/**
 * Anchored to the report contract's `## Result` heading, matching `worker-ledger.mjs`.
 * An unanchored search would take the first of these words appearing anywhere in the
 * report — "the tests PASS locally, but then I hit an ambiguity" ahead of a `## Result` of
 * BLOCKED yields exactly the wrong outcome, in the snapshot whose entire job is to survive
 * a session that ended badly.
 */
const RESULT_RE = /^##\s*Result\s*\r?\n+\s*(DONE|PARTIAL|BLOCKED|PASS|FAIL)\b/im;
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

/**
 * Read the entire hook payload from stdin synchronously.
 *
 * @returns {string} The raw stdin contents, or `""` if stdin cannot be read — this hook is
 *   fail-open, so a read failure must look like "no payload" rather than throw.
 */
function readStdinSync() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Must resolve the same way as session-brief.mjs, or the handoff is never found.
 *
 * @param {object} payload - The parsed hook payload; only `payload.cwd` is read.
 * @returns {string} Absolute path to the project root.
 */
function projectRoot(payload) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv && existsSync(fromEnv)) return resolve(fromEnv);
  if (payload && payload.cwd && existsSync(payload.cwd)) return resolve(payload.cwd);
  return process.cwd();
}

/**
 * The snapshot filename is keyed by project as well as session. On macOS the temp directory
 * is per-user, but on Linux it is a shared `/tmp`, so a filename keyed only by session id
 * would let one project's session — or another user's — surface a snapshot that is not its
 * own. The reader also checks ownership; this keys the name so the two never even collide.
 *
 * @param {string} root - Absolute path to the project root.
 * @param {string} sessionId - The session id from the hook payload.
 * @returns {string} The snapshot filename (not a full path), keyed by project and session.
 */
function snapshotName(root, sessionId) {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
  return `claude-orchestration-${key}-${sessionId}.md`;
}

/**
 * Transcript lines wrap the API message; tolerate shapes that do not match.
 *
 * @param {object} entry - One parsed JSONL transcript line.
 * @returns {object[]} The message's content blocks, or `[]` when the shape does not match.
 */
function blocks(entry) {
  const content = entry && entry.message && entry.message.content;
  return Array.isArray(content) ? content : [];
}

/**
 * Extract the plain text carried by a `tool_result` content block.
 *
 * @param {object} block - A content block; reads `block.content`, which is either a string
 *   or an array of sub-blocks each carrying `.text`.
 * @returns {string} The block's text, or `""` when `block.content` is neither shape.
 */
function resultText(block) {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((x) => (x && typeof x.text === "string" ? x.text : "")).join("\n");
  }
  return "";
}

/**
 * Read at most the last MAX_TRANSCRIPT_BYTES, without pulling the whole file into memory
 * first. Reading it all and then slicing would defeat the point of the cap and can hit
 * V8's string-length ceiling on a pathological transcript — a process-level failure that
 * the surrounding try/catch would not reliably convert into a clean exit 0.
 *
 * @param {string} path - Absolute path to the transcript JSONL file.
 * @returns {string} The transcript text, or its last MAX_TRANSCRIPT_BYTES bytes (starting at
 *   the next full line) when the file exceeds that size.
 */
function readTranscript(path) {
  const size = statSync(path).size;
  if (size <= MAX_TRANSCRIPT_BYTES) return readFileSync(path, "utf8");

  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(MAX_TRANSCRIPT_BYTES);
    const read = readSync(fd, buf, 0, MAX_TRANSCRIPT_BYTES, size - MAX_TRANSCRIPT_BYTES);
    const tail = buf.subarray(0, read).toString("utf8");
    // The read almost certainly lands mid-line; drop the partial leading record.
    return tail.slice(tail.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
}

/**
 * Walk the transcript once, collecting every worker dispatched via the `Agent` tool (with
 * its reported outcome, if any) and every file path written by `Edit`, `Write`, or
 * `NotebookEdit`.
 *
 * @param {string} text - Transcript text, one JSON object per line.
 * @returns {{dispatched: Map<string, {agent: string, description: string,
 *   outcome: (string|null)}>, filesTouched: Set<string>}} `dispatched` is keyed by the
 *   `Agent` tool_use id; `outcome` is the `## Result` value matched via RESULT_RE, or null
 *   if the worker never returned.
 */
function scan(text) {
  const dispatched = new Map(); // tool_use_id -> { agent, description, outcome }
  const filesTouched = new Set();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const b of blocks(entry)) {
      if (!b || typeof b !== "object") continue;

      if (b.type === "tool_use" && b.name === "Agent") {
        dispatched.set(b.id, {
          agent: (b.input && b.input.subagent_type) || "unknown",
          description: (b.input && b.input.description) || "",
          outcome: null,
        });
      } else if (b.type === "tool_use" && WRITE_TOOLS.includes(b.name)) {
        if (b.input && typeof b.input.file_path === "string") filesTouched.add(b.input.file_path);
      } else if (b.type === "tool_result" && dispatched.has(b.tool_use_id)) {
        const found = resultText(b).match(RESULT_RE);
        dispatched.get(b.tool_use_id).outcome = found ? found[1] : "returned";
      }
    }
  }

  return { dispatched, filesTouched };
}

/**
 * Render the pre-compaction snapshot as Markdown.
 *
 * @param {object} payload - The parsed PreCompact hook payload; reads `payload.trigger`.
 * @param {Map<string, {agent: string, description: string, outcome: (string|null)}>} dispatched
 *   - Workers dispatched this session, as produced by `scan()`.
 * @param {Set<string>} filesTouched - File paths written this session, as produced by `scan()`.
 * @returns {string} The rendered snapshot text, terminated with a trailing newline.
 */
function render(payload, dispatched, filesTouched) {
  const lines = [
    `# Orchestration state captured before compaction (${payload.trigger || "unknown"} trigger)`,
    "",
    "Mechanically extracted from the transcript. It records what was dispatched and what " +
      "was written — not what was reconciled, accepted, rejected, or decided. Those are " +
      "yours to re-state; this snapshot cannot recover them.",
    "",
  ];

  if (dispatched.size) {
    lines.push(`## Workers dispatched (${dispatched.size})`, "");
    for (const w of dispatched.values()) {
      const status =
        w.outcome === null ? "**no result recorded — still running or cut off**" : w.outcome;
      lines.push(`- ${w.agent} — ${w.description || "(no description)"} → ${status}`);
    }
    lines.push("");
  }

  if (filesTouched.size) {
    const all = [...filesTouched];
    lines.push(`## Files written this session (${all.length})`, "");
    for (const f of all.slice(0, MAX_FILES_LISTED)) lines.push(`- ${f}`);
    if (all.length > MAX_FILES_LISTED) lines.push(`- … ${all.length - MAX_FILES_LISTED} more`);
    lines.push("", "Confirm against `git diff` before reporting anything done.");
  }

  return lines.join("\n") + "\n";
}

try {
  const raw = readStdinSync();
  if (!raw.trim()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  if (typeof payload.transcript_path !== "string") process.exit(0);

  let text;
  try {
    text = readTranscript(payload.transcript_path);
  } catch {
    process.exit(0);
  }

  const { dispatched, filesTouched } = scan(text);
  // A session with no workers and no writes has no integration picture worth carrying.
  if (!dispatched.size && !filesTouched.size) process.exit(0);

  const id = typeof payload.session_id === "string" ? payload.session_id : "unknown";
  // Mode 0600: on a shared /tmp the snapshot names this session's files and workers, which
  // is nobody else's business. The `mode` option only applies when the file is created, so
  // a second PreCompact in the same session would inherit whatever mode the first left.
  // chmod after writing makes the permission hold on every write, not just the first.
  const out = join(tmpdir(), snapshotName(projectRoot(payload), id));
  writeFileSync(out, render(payload, dispatched, filesTouched), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(out, 0o600);
  } catch {
    /* best effort: a snapshot that exists with looser mode still beats no snapshot */
  }
  process.exit(0);
} catch {
  // Observability surface: never block compaction.
  process.exit(0);
}
