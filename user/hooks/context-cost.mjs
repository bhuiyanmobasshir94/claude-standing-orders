#!/usr/bin/env node
/**
 * Stop hook — context cost visibility.
 *
 * Nothing in this system currently tells a session that its own context is what it is
 * paying for, over and over. One measured session ran 861 turns, grew from 33K to 719K
 * context tokens, compacted essentially once, and spent the large majority of three days'
 * total cost doing it — not because any single turn was expensive, but because the whole
 * accumulated context gets re-billed on *every* turn, not just the new input. A session has
 * no way to notice this from the inside. This hook is that notice.
 *
 * It reads `message.usage` off transcript lines — `input_tokens + cache_creation_input_tokens
 * + cache_read_input_tokens` is the size of the context a turn actually re-billed — and
 * tracks the *most recent* value, not the largest ever seen. That distinction matters: a
 * session that crosses a threshold and then compacts has already fixed the problem, and
 * warning it about a peak it no longer carries is a false positive that teaches the reader
 * to ignore the hook. The current figure is also the only one the message can honestly call
 * what this session is paying now. Two thresholds escalate: a warning, then an alert further
 * out, each firing at most once per session so a long-running session gets two nudges total,
 * never a nag per turn.
 *
 * It warns, never blocks. `Stop` permits `decision: "block"`, but this hook is measuring a
 * cost trend, not a policy violation — there is no line past which continuing is *wrong*,
 * only a point past which the session should know what it is choosing. A gate here would
 * have to pick a threshold that is right for every project and every task, which does not
 * exist; a gate that blocks a session doing legitimately large, necessary work gets switched
 * off within a week, and switching it off also removes the notice. Same trade `verify-
 * reminder.mjs` makes for the same reason.
 *
 * It scans incrementally, from a saved byte offset, because `Stop` fires on every assistant
 * turn — re-reading a transcript that is itself hundreds of thousands of tokens long, on
 * every turn, to warn about context growth would be the hook reproducing the exact cost
 * pattern it exists to flag. Cost stays flat as the session grows; only newly appended bytes
 * are ever read.
 *
 * Fail-open by design. This is an observability surface, not an authorization boundary:
 * every path exits 0, and `decision: block` is never emitted.
 */

import {
  readFileSync, writeFileSync, existsSync, statSync, openSync, readSync, closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/** Default token count at which the first, milder warning fires. */
const DEFAULT_WARN_TOKENS = 200_000;
/** Default token count at which the second, more urgent warning fires. */
const DEFAULT_ALERT_TOKENS = 400_000;

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
 * Must resolve the same way as the other hooks, or the marker lands somewhere else.
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
 * Read only the bytes appended since the previous turn.
 *
 * @param {string} path - Absolute path to the transcript JSONL file.
 * @param {number} offset - Byte offset to read from, as saved from the previous scan.
 * @returns {{text: string, size: number}} The newly appended text (`""` when the file has
 *   not grown past `offset`), and the file's current size to save as the next offset.
 */
function readFrom(path, offset) {
  const size = statSync(path).size;
  if (size <= offset) return { text: "", size };
  const fd = openSync(path, "r");
  try {
    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, offset);
    return { text: buf.subarray(0, read).toString("utf8"), size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse a threshold override from the environment, defensively. A non-numeric or non-
 * positive override must not disable the hook — it must fall back to the built-in default,
 * exactly like every other failure path in this file.
 *
 * @param {string} name - Environment variable name to read.
 * @param {number} fallback - Default threshold to use when the variable is unset or invalid.
 * @returns {number} The threshold in tokens.
 */
function thresholdFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {*} v - Candidate value pulled from a transcript's `usage` object.
 * @param {number} fallback - Value to use when `v` is not a finite number.
 * @returns {number} `v` as a number, or `fallback` when it is missing or malformed.
 */
function numberOr(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Scan newly appended transcript text for `message.usage` blocks, mutating
 * `state.currentContext` in place to the size reported by the most recent turn.
 *
 * Context size for a turn is `input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens` — the full size of what that turn re-billed, not just the tokens
 * newly typed into it. That is the number every subsequent turn pays again.
 *
 * The last value wins rather than the largest, so a compaction is reflected as the drop it
 * actually is instead of leaving the session permanently marked at its high-water mark.
 *
 * @param {string} text - Newly appended transcript text, one JSON object per line.
 * @param {{currentContext: number}} state - Mutable scan state.
 * @returns {{currentContext: number}} The same `state` object, mutated.
 */
function scan(text, state) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry && entry.message && entry.message.usage;
    if (!usage || typeof usage !== "object") continue;
    state.currentContext =
      numberOr(usage.input_tokens, 0) +
      numberOr(usage.cache_creation_input_tokens, 0) +
      numberOr(usage.cache_read_input_tokens, 0);
  }
  return state;
}

/**
 * @param {number} n - A token count.
 * @returns {string} `n` rounded to an integer and rendered with thousands separators, without
 *   relying on locale/ICU data being present in the Node build this hook happens to run under.
 */
function withCommas(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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

  const warnThreshold = thresholdFromEnv("CLAUDE_CONTEXT_WARN_TOKENS", DEFAULT_WARN_TOKENS);
  const alertThreshold = thresholdFromEnv("CLAUDE_CONTEXT_ALERT_TOKENS", DEFAULT_ALERT_TOKENS);

  const root = projectRoot(payload);
  const id = typeof payload.session_id === "string" ? payload.session_id : "unknown";
  const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const markerPath = join(tmpdir(), `claude-context-cost-${key}-${id}.json`);

  let state = { offset: 0, currentContext: 0, warned: false, alerted: false };
  try {
    if (existsSync(markerPath)) {
      state = { ...state, ...JSON.parse(readFileSync(markerPath, "utf8")) };
    }
  } catch {
    /* a corrupt marker just restarts the scan */
  }

  if (state.warned && state.alerted) process.exit(0); // both tiers already fired

  let scanned;
  try {
    scanned = readFrom(payload.transcript_path, state.offset);
  } catch {
    process.exit(0);
  }

  const before = JSON.stringify(state);
  scan(scanned.text, state);
  state.offset = scanned.size;

  // Escalating and mutually exclusive per turn: only one hookSpecificOutput can be emitted,
  // so a turn that crosses both thresholds at once reports the higher one and marks both
  // fired — a stale 200K notice right after a 400K one would be noise, not signal.
  let tier = null;
  if (state.currentContext >= alertThreshold && !state.alerted) {
    tier = "alert";
    state.alerted = true;
    state.warned = true;
  } else if (state.currentContext >= warnThreshold && !state.warned) {
    tier = "warn";
    state.warned = true;
  }

  // Stop fires on every turn. A turn that changed nothing here changes nothing to persist,
  // so skip the write rather than paying for it once per turn forever.
  if (JSON.stringify(state) !== before) {
    try {
      writeFileSync(markerPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    } catch {
      /* losing the marker costs at most a repeated scan */
    }
  }

  if (!tier) process.exit(0);

  const tokens = withCommas(state.currentContext);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext:
          `Context cost: this session's context is now ~${tokens} tokens` +
          (tier === "alert" ? " (past the second threshold)" : "") +
          ". Every subsequent turn re-bills approximately that whole amount, not just what " +
          "is newly said — cost grows with turn count from here, not with new work done. " +
          "Options: run `/compact` to shrink it, start a fresh session for the next slice of " +
          "work, or push exploratory reading into a subagent whose context does not land on " +
          "the main thread.",
      },
    })
  );
  process.exit(0);
} catch {
  // Observability surface: never disrupt a session.
  process.exit(0);
}
