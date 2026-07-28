#!/usr/bin/env node
/**
 * SubagentStop hook — worker ledger.
 *
 * Appends one line per completed worker to `.claude/worker-ledger.jsonl` in the project,
 * so the next session can see which workers ran and how they finished. The session-brief
 * hook reads the tail of this file at startup.
 *
 * Records metadata only: agent type, timestamp, and the Result line if the worker followed
 * the report contract. It does not record file contents, diffs, or worker output bodies.
 *
 * Fail-open by design — a ledger write must never block or slow a session. Every failure
 * path exits 0.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const MAX_NOTE_CHARS = 160;

function readStdinSync() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function projectRoot(payload) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv && existsSync(fromEnv)) return resolve(fromEnv);
  if (payload && payload.cwd && existsSync(payload.cwd)) return resolve(payload.cwd);
  return process.cwd();
}

/** Pull the Result line out of a worker report that follows the contract. */
function extractResult(payload) {
  const candidates = [payload.last_message, payload.output, payload.result, payload.reason];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const m = c.match(/^##\s*Result\s*\r?\n+\s*(DONE|PARTIAL|BLOCKED)\b/im);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function extractNote(payload) {
  const c = payload.last_message;
  if (typeof c !== "string") return null;
  const m = c.match(/^##\s*Blocker\s*\r?\n+([^\n]+)/im);
  if (!m) return null;
  return m[1].trim().slice(0, MAX_NOTE_CHARS);
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

  const agent = payload.agent_type || payload.agentType || "subagent";

  // Built-in read-only agents are noise in a ledger meant to track implementation work.
  if (["Explore", "Plan", "claude-code-guide", "statusline-setup"].includes(agent)) {
    process.exit(0);
  }

  const root = projectRoot(payload);
  const file = join(root, ".claude", "worker-ledger.jsonl");
  mkdirSync(dirname(file), { recursive: true });

  const entry = {
    at: new Date().toISOString().replace("T", " ").slice(0, 16),
    agent,
    result: extractResult(payload),
    note: extractNote(payload),
    session: typeof payload.session_id === "string" ? payload.session_id.slice(0, 8) : null,
  };

  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  process.exit(0);
} catch {
  // Observability surface: never block a session.
  process.exit(0);
}
