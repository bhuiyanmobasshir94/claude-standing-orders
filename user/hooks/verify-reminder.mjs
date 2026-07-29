#!/usr/bin/env node
/**
 * Stop hook — verification reminder.
 *
 * "Verify before claiming" is the assumption the rest of this system rests on, and it is
 * otherwise only prose. This is the weakest honest mechanisation of it.
 *
 * It is a reminder, never a gate. It cannot block, does not try, and fires at most once per
 * session. A gate here would have to decide which command counts as verification for this
 * project; every heuristic for that produces false negatives, and a gate that blocks a
 * session which *did* verify gets switched off within a week — which is worse than no gate,
 * because switching it off also removes the reminder.
 *
 * So it does not guess. It reads `verifyCommands` from `.claude/continuity.json`:
 *
 *     { "verifyCommands": ["make test", "make lint"] }
 *
 * Without that key it exits silently and is completely inert. No project is nagged on a
 * heuristic it never agreed to, and the false-positive rate is zero by construction rather
 * than by tuning.
 *
 * Stop fires on every assistant turn, so the transcript is scanned incrementally from a
 * saved byte offset rather than re-read each time. Cost stays flat as a session grows.
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

/**
 * Writes that count as "changed code" worth verifying.
 *
 * Infrastructure counts. A session that rewrites only a CI workflow, a Terraform module, a
 * shell script, or a Dockerfile has changed what runs in production every bit as much as one
 * that edits a `.py`, and treating those as documentation meant the reminder stayed silent on
 * exactly the changes hardest to undo.
 */
const CODE_RE =
  /\.(m?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|scala|ex|exs|c|h|cc|cpp|sql|sh|bash|zsh|ya?ml|tf|tfvars|proto|gradle|rake)$/i;
/** Extensionless files whose basename alone marks them as build or deploy inputs. */
const CODE_BASENAMES = /^(dockerfile|makefile|justfile|rakefile|procfile|jenkinsfile)$/i;
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

/**
 * A path counts when either its extension or its bare filename says it is code.
 *
 * @param {string} p - File path to check.
 * @returns {boolean} True when `p` matches CODE_RE or its basename matches CODE_BASENAMES.
 */
function isCodePath(p) {
  if (CODE_RE.test(p)) return true;
  const base = p.split(/[\\/]/).pop() || "";
  return CODE_BASENAMES.test(base);
}

/**
 * Did this Bash invocation actually *run* one of the declared verification commands?
 *
 * A plain substring test answers yes to `echo "remember to run make test"` and to
 * `grep "make test" Makefile`, which silently suppresses the reminder for the rest of the
 * session. So the command must begin a shell segment: the string is split on the separators
 * that start a new command, leading environment assignments are stripped, and the declared
 * command has to sit at the front of what remains.
 *
 * This trades one error for the other on purpose. It can miss an unusual invocation and remind
 * a session that did verify — mild noise, and the reminder's own text tells the reader to say
 * so and finish. The failure it removes is worse and invisible: silence that reads as proof.
 *
 * @param {string} cmd - The full command string from a `Bash` tool call.
 * @param {string[]} commands - The project's declared `verifyCommands`.
 * @returns {boolean} True when some shell segment of `cmd`, after stripping leading
 *   environment assignments, starts with one of `commands`.
 */
function ranVerification(cmd, commands) {
  const segments = String(cmd).split(/\n|;|&&|\|\||\|/);
  for (const segment of segments) {
    const cleaned = segment.trim().replace(/^(?:[A-Za-z_][\w]*=\S*\s+)*/, "");
    if (commands.some((c) => cleaned.startsWith(c))) return true;
  }
  return false;
}

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
 * Read this project's declared verification commands.
 *
 * @param {string} root - Absolute path to the project root.
 * @returns {string[]} The `verifyCommands` list from `.claude/continuity.json`, filtered to
 *   non-empty strings — or `[]` when the file is missing, unreadable, or declares none. An
 *   empty result is what keeps this hook inert for a project that has not opted in.
 */
function verifyCommands(root) {
  try {
    const cfg = JSON.parse(readFileSync(join(root, ".claude", "continuity.json"), "utf8"));
    const list = cfg && cfg.verifyCommands;
    return Array.isArray(list) ? list.filter((c) => typeof c === "string" && c.trim()) : [];
  } catch {
    return [];
  }
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
 * @param {object} entry - One parsed JSONL transcript line.
 * @returns {object[]} The message's content blocks, or `[]` when the shape does not match.
 */
function blocks(entry) {
  const content = entry && entry.message && entry.message.content;
  return Array.isArray(content) ? content : [];
}

/**
 * Scan newly appended transcript text for a code edit or a verification run, mutating
 * `state` in place so the caller can persist it as the marker for the next turn.
 *
 * @param {string} text - Newly appended transcript text, one JSON object per line.
 * @param {string[]} commands - The project's declared `verifyCommands`.
 * @param {{edited: boolean, verified: boolean}} state - Mutable scan state; `edited` is set
 *   when a `Write`/`Edit`/`NotebookEdit` touches a code path, `verified` is set when a `Bash`
 *   call runs a declared command or an `Agent` call dispatches `verifier`.
 * @returns {{edited: boolean, verified: boolean}} The same `state` object, mutated.
 */
function scan(text, commands, state) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const b of blocks(entry)) {
      if (!b || b.type !== "tool_use") continue;
      if (WRITE_TOOLS.includes(b.name)) {
        const p = b.input && b.input.file_path;
        if (typeof p === "string" && isCodePath(p)) state.edited = true;
      } else if (b.name === "Bash") {
        const cmd = String((b.input && b.input.command) || "");
        if (ranVerification(cmd, commands)) state.verified = true;
      } else if (b.name === "Agent") {
        // A verifier run is verification, whoever typed the command.
        if ((b.input && b.input.subagent_type) === "verifier") state.verified = true;
      }
    }
  }
  return state;
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

  const root = projectRoot(payload);
  const commands = verifyCommands(root);
  // Opt-in: a project that has not declared its commands is never nagged.
  if (!commands.length) process.exit(0);

  const id = typeof payload.session_id === "string" ? payload.session_id : "unknown";
  const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const markerPath = join(tmpdir(), `claude-verify-${key}-${id}.json`);

  let state = { offset: 0, edited: false, verified: false, reminded: false };
  try {
    if (existsSync(markerPath)) {
      state = { ...state, ...JSON.parse(readFileSync(markerPath, "utf8")) };
    }
  } catch {
    /* a corrupt marker just restarts the scan */
  }

  if (state.reminded) process.exit(0); // at most once per session

  let scanned;
  try {
    scanned = readFrom(payload.transcript_path, state.offset);
  } catch {
    process.exit(0);
  }

  const before = JSON.stringify(state);
  scan(scanned.text, commands, state);
  state.offset = scanned.size;

  const remind = state.edited && !state.verified;
  if (remind) state.reminded = true;

  // Stop fires on every turn. A turn that added nothing to the transcript changes nothing
  // here, so skip the write rather than paying for it once per turn forever.
  if (JSON.stringify(state) !== before) {
    try {
      writeFileSync(markerPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    } catch {
      /* losing the marker costs at most a repeated scan */
    }
  }

  if (!remind) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext:
          "This session changed code, and none of this project's declared verification " +
          `commands ran: ${commands.map((c) => `\`${c}\``).join(", ")}.\n\n` +
          "Run them and report the real output, or name explicitly which parts are " +
          "unverified and why. This is a reminder, not a gate — if verification genuinely " +
          "does not apply to this change, say so and finish.",
      },
    })
  );
  process.exit(0);
} catch {
  // Observability surface: never disrupt a session.
  process.exit(0);
}
