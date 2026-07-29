#!/usr/bin/env node
/**
 * SubagentStart hook — Task Packet check.
 *
 * Warns, never blocks. The SubagentStart event cannot block subagent startup, so this is
 * not a gate and is not written as one. `additionalContext` on SubagentStart reaches the
 * *subagent*, not the orchestrator — which is the useful direction: a worker told its
 * packet is incomplete returns BLOCKED instead of inventing a design.
 *
 * Scoped by matcher in settings.json to implementer, fast-implementer, and reviewer.
 * `verifier` is exempt: its packet is a command list, and a missing-field warning there is
 * noise rather than signal.
 *
 * Fail-open by design. This is an observability surface, not an authorization boundary:
 * every failure path exits 0 and the subagent starts normally.
 */

import { readFileSync } from "node:fs";

/**
 * Each field is matched loosely — heading, bold label, or list item all count — because
 * the packet is prose written by an orchestrator, not a form. The cost of a false warning
 * is one extra paragraph in a worker's context; the cost of a false pass is a worker
 * inventing a design. Bias accordingly, but do not fire on prose that clearly carries the
 * field under a different name.
 */
const FIELDS = [
  ["Intent",      /(^|\n)[\s#*_>-]*(intent|goal|objective|what must be true)\b/i],
  ["Files",       /(^|\n)[\s#*_>-]*(files?|read-write|read-only|scope)\b/i],
  ["Anchors",     /(^|\n)[\s#*_>-]*(anchors?|patterns?\s+to\s+match|follow\s+the\s+existing)\b/i],
  ["Constraints", /(^|\n)[\s#*_>-]*(constraints?|must not|do not change)\b/i],
  ["Done means",  /(^|\n)[\s#*_>-]*(done[-\s]means|done when|acceptance|verified? (by|with))\b/i],
];

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

  const prompt = typeof payload.prompt_text === "string" ? payload.prompt_text : "";
  if (!prompt.trim()) process.exit(0);

  const missing = FIELDS.filter(([, re]) => !re.test(prompt)).map(([label]) => label);
  if (!missing.length) process.exit(0);

  const named = missing.map((m) => `**${m}**`).join(", ");
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext:
          `Task Packet check: this dispatch did not name ${named}.\n\n` +
          "Do not invent what is missing. If proceeding would mean guessing at a design " +
          "decision, at which files are in scope, or at what counts as done, return " +
          "BLOCKED naming the missing field — that is cheaper than work built on a guess.\n\n" +
          "If the task is genuinely mechanical and fully specified without them, proceed. " +
          "This is a warning, not a gate.",
      },
    })
  );
  process.exit(0);
} catch {
  // Observability surface: never disrupt a dispatch.
  process.exit(0);
}
