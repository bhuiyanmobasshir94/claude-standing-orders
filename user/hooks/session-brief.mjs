#!/usr/bin/env node
/**
 * SessionStart hook — session continuity brief.
 *
 * Reads the repository's committed continuity files and injects a compact brief into the
 * new session's context, so a session on a server starts from the same history as a
 * session on the laptop.
 *
 * Sources (all optional; missing ones are skipped silently):
 *   docs/decisions/DECISIONS.md     — standing decisions
 *   docs/changelogs/YYYY-MM-DD-*.md — recent session changelogs
 *   .claude/worker-ledger.jsonl     — what workers did in recent sessions
 *
 * Fail-open by design. This is an observability surface, not an authorization boundary:
 * a brief that cannot be produced must never block a session. Every failure path exits 0.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_CHANGELOGS = 3;
const MAX_LINES_PER_CHANGELOG = 24;
const MAX_DECISION_LINES = 40;
const MAX_LEDGER_ENTRIES = 8;
const MAX_TOTAL_CHARS = 8000;

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

function head(text, maxLines) {
  const lines = text.split(/\r?\n/);
  const kept = lines.slice(0, maxLines);
  if (lines.length > maxLines) kept.push(`  … (${lines.length - maxLines} more lines)`);
  return kept.join("\n");
}

function recentChangelogs(root) {
  const dir = join(root, "docs", "changelogs");
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md");
  } catch {
    return [];
  }
  // Filenames start with YYYY-MM-DD, so a lexical sort is chronological.
  names.sort().reverse();
  const out = [];
  for (const name of names.slice(0, MAX_CHANGELOGS)) {
    try {
      const body = readFileSync(join(dir, name), "utf8").trim();
      if (body) out.push({ name, body: head(body, MAX_LINES_PER_CHANGELOG) });
    } catch {
      /* skip unreadable entry */
    }
  }
  return out;
}

function decisions(root) {
  const file = join(root, "docs", "decisions", "DECISIONS.md");
  if (!existsSync(file)) return null;
  try {
    const body = readFileSync(file, "utf8").trim();
    return body ? head(body, MAX_DECISION_LINES) : null;
  } catch {
    return null;
  }
}

function ledger(root) {
  const file = join(root, ".claude", "worker-ledger.jsonl");
  if (!existsSync(file)) return [];
  try {
    if (statSync(file).size > 2_000_000) return [];
    const lines = readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
    return lines
      .slice(-MAX_LEDGER_ENTRIES)
      .map((line) => {
        try {
          const e = JSON.parse(line);
          return `- ${e.at} · ${e.agent} → ${e.result || "unknown"}${e.note ? ` — ${e.note}` : ""}`;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function build(root) {
  const parts = [];
  const dec = decisions(root);
  const logs = recentChangelogs(root);
  const led = ledger(root);

  if (!dec && logs.length === 0 && led.length === 0) return null;

  parts.push("# Session continuity brief");
  parts.push(
    "Committed history for this repository. Align today's work with what follows; " +
      "if you intend to contradict any of it, say so explicitly first."
  );

  if (dec) parts.push(`\n## Standing decisions (docs/decisions/DECISIONS.md)\n\n${dec}`);

  if (logs.length) {
    parts.push(`\n## Recent sessions (docs/changelogs/, newest first)`);
    for (const l of logs) parts.push(`\n### ${l.name}\n\n${l.body}`);
  }

  if (led.length) {
    parts.push(`\n## Recent worker activity\n\n${led.join("\n")}`);
  }

  let text = parts.join("\n");
  if (text.length > MAX_TOTAL_CHARS) {
    text = text.slice(0, MAX_TOTAL_CHARS) + "\n\n… (brief truncated; read the files directly for more)";
  }
  return text;
}

try {
  let payload = {};
  const raw = readStdinSync();
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }

  const brief = build(projectRoot(payload));
  if (brief) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: brief,
        },
      })
    );
  }
  process.exit(0);
} catch {
  // Observability surface: never block a session.
  process.exit(0);
}
