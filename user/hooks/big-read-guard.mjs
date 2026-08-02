#!/usr/bin/env node
/**
 * PreToolUse hook — big-read guard.
 *
 * Warns, never blocks. Fires on the `Read` tool and names the cost of an unbounded read of a
 * large file before it lands in the main thread's context.
 *
 * ## Why this matters enough for a hook
 *
 * Context re-send dominates token spend in this system — everything read into the main
 * thread is part of the prompt on every subsequent turn, not just the turn that read it. A
 * single unbounded read of a 50KB source file costs its tokens once to load and then again,
 * unchanged, on every turn for the rest of the session. The read tool has no memory of this;
 * only a hook watching it does.
 *
 * ## Why warn and not block
 *
 * `PreToolUse` permits `permissionDecision: "deny"`, and this hook never emits one, and never
 * emits `updatedInput` either. An early version of this idea rewrote the Read's input to point
 * at a filtered or truncated copy of the file — that was tried and measured as a net loss: it
 * silently changed what the caller received, which is worse than the caller paying the token
 * cost knowingly. Sometimes the whole file genuinely is the right read. This hook's job is to
 * make sure that is a choice, not a default nobody looked at.
 *
 * ## Why text and image files get different warnings
 *
 * A text file's token cost is well approximated by bytes / 4, so the warning can quote a
 * concrete number. An image is tokenized by pixel dimensions, not by file size — a 50KB
 * icon and a 50KB photo of very different dimensions cost nothing alike, and this hook only
 * has `statSync`, which cannot see dimensions. Quoting a bytes/4 estimate for an image would
 * state a number that has no relationship to the truth, which is worse than stating none.
 *
 * ## Fail-open by design
 *
 * This is an observability surface, not an authorization boundary: malformed input, a
 * missing file, a stat failure — every path exits 0 with no output, and the Read proceeds
 * untouched. No subprocess, no file-content read: inspecting the file to warn about the cost
 * of reading it would spend exactly what it exists to save.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, extname } from "node:path";

/** Byte-count threshold at or above which an unbounded text/image Read gets a warning. */
const DEFAULT_THRESHOLD_BYTES = 50000;

/** Extensions tokenized by pixel dimensions rather than byte size — matched case-insensitively. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

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
 * The configurable size floor for the warning, read fresh on every invocation since this is a
 * short-lived process.
 *
 * @returns {number} `CLAUDE_BIG_READ_BYTES` parsed as a positive finite number, or
 *   `DEFAULT_THRESHOLD_BYTES` when the variable is unset, non-numeric, or non-positive — a
 *   malformed override must degrade to the default, not to "no threshold at all".
 */
function thresholdBytes() {
  const raw = process.env.CLAUDE_BIG_READ_BYTES;
  if (!raw) return DEFAULT_THRESHOLD_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD_BYTES;
}

/**
 * @param {string} path - Absolute file path from `tool_input.file_path`.
 * @returns {boolean} True when the extension is one this hook cannot estimate tokens for by
 *   byte size, because images are tokenized by pixel dimensions instead.
 */
function isImagePath(path) {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Build the warning for a large unbounded text-file read.
 *
 * @param {string} path - The file path being read.
 * @param {number} size - The file's size in bytes.
 * @returns {string} The `additionalContext` message.
 */
function textWarning(path, size) {
  const approxTokens = Math.round(size / 4);
  return (
    `Big Read guard: \`${path}\` is ${size.toLocaleString()} bytes (~${approxTokens.toLocaleString()} ` +
    "tokens) and this Read has no `offset`/`limit`, so the whole file is about to land in the " +
    "main thread's context — and re-bill at that size on every subsequent turn of this " +
    "session, not just this one.\n\n" +
    "Cheaper alternatives: a bounded read with `offset`/`limit` if only part of the file " +
    "matters, `Grep` to locate the relevant region first, or delegating the read to a " +
    "subagent whose context does not land on the main thread.\n\n" +
    "This is a warning, not a gate — if the whole file is genuinely needed here, proceed."
  );
}

/**
 * Build the warning for a large unbounded image read.
 *
 * @param {string} path - The file path being read.
 * @param {number} size - The file's size in bytes, shown for context only — it does not
 *   determine the image's token cost.
 * @returns {string} The `additionalContext` message.
 */
function imageWarning(path, size) {
  return (
    `Big Read guard: \`${path}\` is a ${size.toLocaleString()}-byte image about to land in the ` +
    "main thread's context. Images are tokenized by pixel dimensions, not file size, so no " +
    "byte-based token estimate is given here — but whatever the true cost is, it re-bills on " +
    "every subsequent turn of this session, not just this one.\n\n" +
    "Cheaper alternative: inspecting the image inside a subagent keeps it off the main " +
    "thread's context.\n\n" +
    "This is a warning, not a gate — if the image is genuinely needed here, proceed."
  );
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

  // Registered with matcher "Read", but a settings file edited by hand may point it wider.
  if (payload.tool_name !== "Read") process.exit(0);

  const input = payload.tool_input;
  if (!input || typeof input !== "object") process.exit(0);

  const filePath = input.file_path;
  if (typeof filePath !== "string" || !filePath.trim() || !isAbsolute(filePath)) process.exit(0);

  // A bounded read is already limited — nothing to warn about.
  if (input.offset !== undefined || input.limit !== undefined) process.exit(0);

  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    process.exit(0);
  }
  if (!stat.isFile()) process.exit(0);

  const size = stat.size;
  if (size < thresholdBytes()) process.exit(0);

  const additionalContext = isImagePath(filePath)
    ? imageWarning(filePath, size)
    : textWarning(filePath, size);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext,
      },
    })
  );
  process.exit(0);
} catch {
  // Observability surface: never disrupt a call.
  process.exit(0);
}
