#!/usr/bin/env node
/**
 * PreToolUse hook — Task Packet check.
 *
 * Warns, never blocks. Fires on the `Agent` tool, reads the packet out of `tool_input.prompt`,
 * and names the required fields the dispatch did not carry.
 *
 * ## Why PreToolUse and not SubagentStart
 *
 * This check lived on `SubagentStart` until it was measured, and there it was inert: it read
 * `payload.prompt_text`, a field the runtime does not send. The whole SubagentStart payload is
 *
 *     session_id, transcript_path, cwd, prompt_id, agent_id, agent_type, hook_event_name
 *
 * so the hook took its "no prompt, nothing to check" exit on every dispatch that ever ran, and
 * never once warned. Reading the packet from disk at that moment is not a workaround either —
 * both possible sources were checked and neither exists yet when SubagentStart fires: the
 * per-subagent transcript (`<session>/subagents/agent-<agent_id>.jsonl`) has not been created,
 * and the parent transcript has not yet been flushed with the `Agent` tool_use block.
 *
 * `PreToolUse` on `Agent` carries `tool_input.prompt` and `tool_input.subagent_type` directly,
 * before the worker starts. That is the only point in the lifecycle where the packet is
 * mechanically available.
 *
 * The cost of the move is real and worth stating: the warning now reaches the **orchestrator**
 * rather than the subagent. The subagent-directed version would have converted "invent a
 * design" into "return BLOCKED naming the missing field". This version instead reaches the
 * author of the packet before the worker is spawned, which is the party that can actually fix
 * it. A warning that lands on the wrong reader beats one that never fires.
 *
 * ## It must not block, even though this event would let it
 *
 * `PreToolUse` permits `permissionDecision: "deny"`. This hook never emits one. The field
 * matching is deliberately loose — the packet is prose written by an orchestrator, not a form —
 * and a blocking gate built on loose matching produces false denials, which get the hook
 * switched off, which removes the warning too. Same argument the verification reminder makes.
 *
 * Fail-open by design. This is an observability surface, not an authorization boundary: every
 * failure path exits 0 and the dispatch proceeds untouched.
 */

import { readFileSync } from "node:fs";

/**
 * Worker roles whose packets are checked.
 *
 * The settings matcher can only select the *tool* (`Agent`), not the agent type, so the role
 * filter lives here. `verifier` is exempt: its packet is a command list, and a missing-field
 * warning there is noise rather than signal. Built-in agents (`Explore`, `Plan`, and the rest)
 * are not this package's workers and are not held to its contract.
 */
const CHECKED_AGENTS = ["implementer", "fast-implementer", "reviewer"];

/**
 * Each field is matched loosely — heading, bold label, or list item all count — because
 * the packet is prose written by an orchestrator, not a form. The cost of a false warning
 * is one extra paragraph in the orchestrator's context; the cost of a false pass is a worker
 * inventing a design. Bias accordingly, but do not fire on prose that clearly carries the
 * field under a different name.
 *
 * `Non-goals` is deliberately absent. It is the packet's one optional field, and requiring it
 * would make this warn on nearly every legitimate dispatch — a warning that always fires is one
 * you stop reading.
 */
const FIELDS = [
  ["Intent",      /(^|\n)[\s#*_>-]*(intent|goal|objective|what must be true)\b/i],
  ["Files",       /(^|\n)[\s#*_>-]*(files?|read-write|read-only|scope)\b/i],
  ["Anchors",     /(^|\n)[\s#*_>-]*(anchors?|patterns?\s+to\s+match|follow\s+the\s+existing)\b/i],
  ["Constraints", /(^|\n)[\s#*_>-]*(constraints?|must not|do not change)\b/i],
  ["Done means",  /(^|\n)[\s#*_>-]*(done[-\s]means|done when|acceptance|verified? (by|with))\b/i],
];

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

try {
  const raw = readStdinSync();
  if (!raw.trim()) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  // Registered with matcher "Agent", but a settings file edited by hand may point it wider.
  if (payload.tool_name && payload.tool_name !== "Agent") process.exit(0);

  const input = payload.tool_input;
  if (!input || typeof input !== "object") process.exit(0);

  const agent = typeof input.subagent_type === "string" ? input.subagent_type : "";
  if (!CHECKED_AGENTS.includes(agent)) process.exit(0);

  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (!prompt.trim()) process.exit(0);

  const missing = FIELDS.filter(([, re]) => !re.test(prompt)).map(([label]) => label);
  if (!missing.length) process.exit(0);

  const named = missing.map((m) => `**${m}**`).join(", ");
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `Task Packet check: this \`${agent}\` dispatch does not name ${named}.\n\n` +
          "A worker that has to guess at a missing field invents a design you did not choose, " +
          "and that failure looks like progress. Either supply the field, or be able to say why " +
          "this slice does not need it.\n\n" +
          "If the task is genuinely mechanical and fully specified without them, proceed. " +
          "This is a warning, not a gate — nothing was blocked.",
      },
    })
  );
  process.exit(0);
} catch {
  // Observability surface: never disrupt a dispatch.
  process.exit(0);
}
