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

/** Extensions that make a write count as "changed code" worth verifying. */
const CODE_RE = /\.(m?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|scala|ex|exs|c|h|cc|cpp|sql)$/i;
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit"];

function readStdinSync() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Must resolve the same way as the other hooks, or the marker lands somewhere else. */
function projectRoot(payload) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv && existsSync(fromEnv)) return resolve(fromEnv);
  if (payload && payload.cwd && existsSync(payload.cwd)) return resolve(payload.cwd);
  return process.cwd();
}

function verifyCommands(root) {
  try {
    const cfg = JSON.parse(readFileSync(join(root, ".claude", "continuity.json"), "utf8"));
    const list = cfg && cfg.verifyCommands;
    return Array.isArray(list) ? list.filter((c) => typeof c === "string" && c.trim()) : [];
  } catch {
    return [];
  }
}

/** Read only the bytes appended since the previous turn. */
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

function blocks(entry) {
  const content = entry && entry.message && entry.message.content;
  return Array.isArray(content) ? content : [];
}

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
        if (typeof p === "string" && CODE_RE.test(p)) state.edited = true;
      } else if (b.name === "Bash") {
        const cmd = String((b.input && b.input.command) || "");
        if (commands.some((c) => cmd.includes(c))) state.verified = true;
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
