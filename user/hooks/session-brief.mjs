#!/usr/bin/env node
/**
 * SessionStart hook — session continuity brief.
 *
 * Reads whatever continuity files this repository keeps and injects a compact brief into
 * the new session, so a session on a server starts from the same history as a session on
 * a laptop.
 *
 * Locations are discovered, not assumed. In order of precedence:
 *
 *   1. `.claude/continuity.json` in the project, if present:
 *        {
 *          "changelogDir": "docs/changelogs",
 *          "decisionFile": "docs/decisions/DECISIONS.md",
 *          "decisionDir":  "docs/adr"
 *        }
 *      Any key may be omitted. Paths are relative to the project root.
 *
 *   2. Common conventions, first match wins (CHANGELOG_DIRS / DECISION_PATHS below).
 *
 *   3. Nothing — the hook emits no output and the session starts normally.
 *
 * Fail-open by design. This is an observability surface, not an authorization boundary:
 * a brief that cannot be produced must never block a session. Every failure path exits 0.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const CHANGELOG_DIRS = [
  "docs/changelogs",
  "docs/changelog",
  "docs/sessions",
  "changelogs",
  ".changelog",
  ".claude/changelogs",
];

const DECISION_PATHS = [
  "docs/decisions/DECISIONS.md",
  "docs/DECISIONS.md",
  "DECISIONS.md",
  ".claude/DECISIONS.md",
  "docs/adr",
  "docs/decisions",
  "doc/adr",
];

const MAX_CHANGELOGS = 3;
const MAX_LINES_PER_ENTRY = 24;
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

function config(root) {
  const f = join(root, ".claude", "continuity.json");
  if (!existsSync(f)) return {};
  try {
    const c = JSON.parse(readFileSync(f, "utf8"));
    return c && typeof c === "object" ? c : {};
  } catch {
    return {};
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function head(text, maxLines) {
  const lines = text.split(/\r?\n/);
  const kept = lines.slice(0, maxLines);
  if (lines.length > maxLines) kept.push(`  … (${lines.length - maxLines} more lines)`);
  return kept.join("\n");
}

/** Markdown files in a directory, newest first — by leading date if present, else mtime. */
function newestMarkdown(dir, limit) {
  let names;
  try {
    names = readdirSync(dir).filter(
      (n) => n.toLowerCase().endsWith(".md") && n.toLowerCase() !== "readme.md"
    );
  } catch {
    return [];
  }
  const dated = /^\d{4}-\d{2}-\d{2}/;
  const scored = names.map((n) => {
    let key;
    if (dated.test(n)) key = n;
    else {
      try {
        key = String(statSync(join(dir, n)).mtimeMs).padStart(20, "0");
      } catch {
        key = "0";
      }
    }
    return { n, key };
  });
  scored.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return scored.slice(0, limit).map((s) => s.n);
}

function findChangelogDir(root, cfg) {
  if (cfg.changelogDir) {
    const p = join(root, cfg.changelogDir);
    return isDir(p) ? p : null;
  }
  for (const rel of CHANGELOG_DIRS) {
    const p = join(root, rel);
    if (isDir(p)) return p;
  }
  return null;
}

function changelogs(root, cfg) {
  const dir = findChangelogDir(root, cfg);
  if (!dir) return { label: null, entries: [] };
  const out = [];
  for (const name of newestMarkdown(dir, MAX_CHANGELOGS)) {
    try {
      const body = readFileSync(join(dir, name), "utf8").trim();
      if (body) out.push({ name, body: head(body, MAX_LINES_PER_ENTRY) });
    } catch {
      /* skip unreadable entry */
    }
  }
  return { label: dir.slice(root.length + 1).split("\\").join("/"), entries: out };
}

function decisions(root, cfg) {
  const candidates = [];
  if (cfg.decisionFile) candidates.push(join(root, cfg.decisionFile));
  if (cfg.decisionDir) candidates.push(join(root, cfg.decisionDir));
  if (!cfg.decisionFile && !cfg.decisionDir) {
    for (const rel of DECISION_PATHS) candidates.push(join(root, rel));
  }

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const label = p.slice(root.length + 1).split("\\").join("/");

    if (isDir(p)) {
      // An ADR directory: list the most recent records rather than inlining them.
      const names = newestMarkdown(p, 8);
      if (!names.length) continue;
      return { label, body: names.map((n) => `- ${n}`).join("\n") };
    }

    try {
      const body = readFileSync(p, "utf8").trim();
      if (body) return { label, body: head(body, MAX_DECISION_LINES) };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function ledger(root) {
  const file = join(root, ".claude", "worker-ledger.jsonl");
  if (!existsSync(file)) return [];
  try {
    if (statSync(file).size > 2_000_000) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
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
  const cfg = config(root);
  const dec = decisions(root, cfg);
  const { label: clLabel, entries } = changelogs(root, cfg);
  const led = ledger(root);

  if (!dec && entries.length === 0 && led.length === 0) return null;

  const parts = [
    "# Session continuity brief",
    "Committed history for this repository. Align today's work with what follows; " +
      "if you intend to contradict any of it, say so explicitly first.",
  ];

  if (dec) parts.push(`\n## Standing decisions (${dec.label})\n\n${dec.body}`);

  if (entries.length) {
    parts.push(`\n## Recent sessions (${clLabel}, newest first)`);
    for (const e of entries) parts.push(`\n### ${e.name}\n\n${e.body}`);
  }

  if (led.length) parts.push(`\n## Recent worker activity\n\n${led.join("\n")}`);

  let text = parts.join("\n");
  if (text.length > MAX_TOTAL_CHARS) {
    text =
      text.slice(0, MAX_TOTAL_CHARS) +
      "\n\n… (brief truncated; read the files directly for more)";
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
