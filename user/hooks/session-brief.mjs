#!/usr/bin/env node
/**
 * SessionStart hook — session continuity brief.
 *
 * Reads whatever continuity files this repository keeps and injects a compact brief into
 * the new session, so a session on a server starts from the same history as a session on
 * a laptop. The brief carries, in order:
 *
 *   - a warning when the running Claude Code is below `version-floor.json`, naming which
 *     features are silently inactive;
 *   - the orchestration snapshot `compact-state.mjs` wrote before the last compaction;
 *   - the repository's standing decisions and recent session changelogs;
 *   - a rollup of the worker ledger as a routing signal.
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
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/** This file installs to <claude home>/hooks/, so the config dir is one level up. */
const HOOK_HOME = dirname(dirname(fileURLToPath(import.meta.url)));

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
const MAX_TOTAL_CHARS = 8000;

/** How many ledger rows the routing rollup considers. Older runs are not evidence today. */
const LEDGER_WINDOW = 40;

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

/** Claude Code versions are plain X.Y.Z; no prerelease handling is needed. */
function cmpVersion(a, b) {
  const pa = String(a).split(".");
  const pb = String(b).split(".");
  for (let i = 0; i < 3; i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Best-effort running version, derived from the environment only.
 *
 * This never spawns a process. `claude --version` was measured at 0.26-1.51s, which is not
 * acceptable on a session-startup path. An unknown version produces no warning: an
 * observability surface reports what it can see and stays silent otherwise, rather than
 * guessing and crying wolf.
 */
function claudeVersion() {
  // Only CLAUDE_CODE_EXECPATH is used. An earlier version also consulted a
  // CLAUDE_CODE_VERSION variable, which is not set by any Claude Code runtime observed
  // here — speculative fallbacks read as verified behavior and are worse than none.
  const exec = process.env.CLAUDE_CODE_EXECPATH;
  if (!exec) return null;

  // Native installer layout: .../claude/versions/2.1.220/...
  const seg = exec.split(/[\\/]/).find((s) => /^\d+\.\d+\.\d+$/.test(s));
  if (seg) return seg;

  // npm layout: .../@anthropic-ai/claude-code/bin/claude.exe — walk up to the package root.
  let dir = dirname(exec);
  for (let i = 0; i < 4; i++) {
    try {
      const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
      if (typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) {
        return version.match(/^\d+\.\d+\.\d+/)[0];
      }
    } catch {
      /* not the package root — keep walking */
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Warn when this install is below the floor the setup depends on. Every feature listed in
 * version-floor.json fails silently below its version — no error, no symptom — so the
 * warning names what is inactive rather than only the number.
 */
function versionWarning() {
  let floor;
  try {
    floor = JSON.parse(readFileSync(join(HOOK_HOME, "version-floor.json"), "utf8"));
  } catch {
    return null;
  }
  const running = claudeVersion();
  if (!running || !floor.minimumVersion) return null;
  if (cmpVersion(running, floor.minimumVersion) >= 0) return null;

  const rows = (floor.features || [])
    .filter((f) => Array.isArray(f) && cmpVersion(running, f[0]) < 0)
    .map((f) => `- \`${f[1]}\` — ${f[2]}`);

  return (
    `## Claude Code ${running} is below this setup's floor (${floor.minimumVersion})\n\n` +
    `Inactive on this install:\n\n${rows.join("\n")}\n\n` +
    "Run `claude update`, then `node bootstrap.mjs doctor` to confirm. Until then, do not " +
    "rely on worker nesting being capped."
  );
}

/**
 * Roll the worker ledger up into a routing signal.
 *
 * This supports exactly one honest inference: a role that keeps returning BLOCKED is being
 * handed the wrong class of task, or handed it without enough packet. It does not know
 * why, and nothing here should be read as if it did.
 */
function ledger(root) {
  const file = join(root, ".claude", "worker-ledger.jsonl");
  if (!existsSync(file)) return [];

  let rows;
  try {
    if (statSync(file).size > 2_000_000) return [];
    rows = readFileSync(file, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-LEDGER_WINDOW)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
  if (!rows.length) return [];

  const byAgent = new Map();
  for (const e of rows) {
    const a = byAgent.get(e.agent) || { n: 0, DONE: 0, PARTIAL: 0, BLOCKED: 0, PASS: 0, FAIL: 0 };
    a.n++;
    if (e.result && a[e.result] !== undefined) a[e.result]++;
    byAgent.set(e.agent, a);
  }

  const out = [];
  for (const [agent, a] of byAgent) {
    const tally = ["DONE", "PARTIAL", "BLOCKED", "PASS", "FAIL"]
      .filter((k) => a[k])
      .map((k) => `${a[k]} ${k}`);
    out.push(`- **${agent}** — ${a.n} run(s)${tally.length ? `: ${tally.join(", ")}` : ""}`);
  }

  for (const b of rows.filter((e) => e.result === "BLOCKED" && e.note).slice(-3)) {
    out.push(`  - blocked: ${b.note}`);
  }

  // Silence here means the report contract or the ledger hook is broken, not that every
  // worker succeeded. Exactly this failure hid behind a wrong payload key for every row
  // the ledger had ever written; the rollup is required to notice it out loud.
  if (rows.length >= 5 && rows.every((e) => !e.result)) {
    out.push(
      "- No worker reported a `## Result` line across the whole window — the report " +
        "contract or the ledger hook is not working. Run `node bootstrap.mjs doctor`."
    );
  }
  return out;
}

/**
 * Find the snapshot `compact-state.mjs` wrote before the last compaction, for this session
 * and this project only.
 *
 * The match is exact on both. An earlier version also accepted any recent snapshot in the
 * project, to cover a compaction handing the session a new id — but that does not happen:
 * three real compacted transcripts each carry a single session id, unchanged either side
 * of the compaction marker. The fallback guarded against nothing and let two concurrent
 * sessions in one project read each other's state, so it is gone.
 */
function handoff(payload, root) {
  const id = typeof payload.session_id === "string" ? payload.session_id : null;
  if (!id) return null;

  // Must match compact-state.mjs `snapshotName` exactly, or nothing is ever found.
  const key = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const exact = join(tmpdir(), `claude-orchestration-${key}-${id}.md`);
  if (!existsSync(exact)) return null;

  // On Linux the temp dir is a shared /tmp. Only read a snapshot this user owns.
  if (typeof process.getuid === "function") {
    try {
      if (statSync(exact).uid !== process.getuid()) return null;
    } catch {
      return null;
    }
  }
  return exact;
}

function build(root, payload) {
  const cfg = config(root);
  const warn = versionWarning();
  const dec = decisions(root, cfg);
  const { label: clLabel, entries } = changelogs(root, cfg);
  const led = ledger(root);

  let carried = null;
  const handoffPath = handoff(payload, root);
  if (handoffPath) {
    try {
      const body = readFileSync(handoffPath, "utf8").trim();
      if (body) carried = head(body, 60);
    } catch {
      /* a handoff that cannot be read is simply absent */
    }
  }

  if (!warn && !dec && entries.length === 0 && led.length === 0 && !carried) return null;

  const parts = [
    "# Session continuity brief",
    "Committed history for this repository. Align today's work with what follows; " +
      "if you intend to contradict any of it, say so explicitly first.",
  ];

  // The version warning goes first: it is the one item that changes whether anything else
  // in this brief can be trusted, and first position survives the truncation cap below.
  if (warn) parts.push(`\n${warn}`);

  if (carried) parts.push(`\n## Orchestration state carried through compaction\n\n${carried}`);

  if (dec) parts.push(`\n## Standing decisions (${dec.label})\n\n${dec.body}`);

  if (entries.length) {
    parts.push(`\n## Recent sessions (${clLabel}, newest first)`);
    for (const e of entries) parts.push(`\n### ${e.name}\n\n${e.body}`);
  }

  if (led.length) {
    parts.push(`\n## Worker routing signal (last ${LEDGER_WINDOW} runs)\n\n${led.join("\n")}`);
  }

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

  const brief = build(projectRoot(payload), payload);
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
