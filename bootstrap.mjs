#!/usr/bin/env node
/**
 * Orchestrator–worker setup installer.
 *
 * Installs the contents of ./user into the Claude Code config directory on any machine —
 * macOS, Windows, Linux, or a server — using only Node's standard library. Node is a
 * prerequisite of Claude Code itself, so it is available wherever Claude Code runs; that
 * is the only portability assumption made here.
 *
 *   node bootstrap.mjs install     copy files, merge settings (default)
 *   node bootstrap.mjs status      show what is installed and whether it matches this repo
 *   node bootstrap.mjs diff        list files that differ from this repo
 *   node bootstrap.mjs doctor      check that the install actually works; exit 1 on failure
 *
 * `status` compares file hashes and nothing else. `doctor` answers the different and more
 * useful question of whether this machine can run the setup: Claude Code version against
 * the floor, hook paths that resolve here, settings that still parse after the merge, and
 * agent definitions that do not assert capabilities the model does not have.
 *
 * Flags:
 *   --dry-run    print what would change, write nothing
 *   --force      overwrite locally modified files instead of skipping them
 *   --home=PATH  target a config dir other than the default (for testing)
 *
 * Settings are merged, not replaced: existing keys are preserved, arrays are concatenated
 * with de-duplication, and a timestamped backup is written before any change.
 *
 * The one exception is `DEPRECATED_KEYS` below — keys this package has deliberately
 * retired, which are removed on every install with no opt-out. That is the point: a
 * retired setting has to actually leave every machine, or the machines diverge. Recovery
 * is the timestamped backup written immediately before the change. To keep such a key,
 * remove it from that list rather than re-adding it to settings.json, which would only be
 * deleted again on the next install.
 */

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync, statSync,
} from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "user");

/**
 * The version floor lives in exactly one file. Everything else — the `minimumVersion` key
 * substituted into settings, the session-brief warning, and the doctor check below —
 * reads it from there rather than restating the number.
 */
const FLOOR = (() => {
  try {
    return JSON.parse(readFileSync(join(SRC, "version-floor.json"), "utf8"));
  } catch {
    return { minimumVersion: null, features: [] };
  }
})();

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("--")) || "install";
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
const homeFlag = argv.find((a) => a.startsWith("--home="));

/** Claude Code honors CLAUDE_CONFIG_DIR; otherwise the config dir is <home>/.claude. */
function configDir() {
  if (homeFlag) return resolve(homeFlag.slice("--home=".length));
  if (process.env.CLAUDE_CONFIG_DIR) return resolve(process.env.CLAUDE_CONFIG_DIR);
  return join(homedir(), ".claude");
}

const DEST = configDir();
const MANIFEST = join(DEST, ".orchestrator-manifest.json");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);

/** Every file under ./user except the settings template, which is handled separately. */
function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, acc);
    else acc.push(relative(base, full).split("\\").join("/"));
  }
  return acc;
}

function loadManifest() {
  if (!existsSync(MANIFEST)) return { files: {}, version: null };
  try {
    return JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch {
    return { files: {}, version: null };
  }
}

/**
 * Keys this package once installed and has since deliberately retired.
 *
 * The settings merge is additive: it adds and overrides, but never deletes. So dropping a
 * key from `settings.template.json` removes it for a fresh install and leaves it in place
 * on every machine that already has it — which is exactly the silent divergence this
 * package exists to prevent. A retired key has to be named here to actually go away.
 *
 * Removal is reported on stdout and the previous settings.json is backed up first. Only add
 * a key here when its removal is a deliberate decision, never to tidy someone's settings.
 */
const DEPRECATED_KEYS = [
  [
    "fallbackModel",
    "silently downgraded the orchestrator to a worker tier when Opus was overloaded; " +
      "a visible failure is better than an invisible demotion",
  ],
];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Deep-merge settings. Incoming values win for scalars. **Every** array is concatenated and
 * de-duplicated by JSON identity, wherever it appears — not only under `hooks`.
 *
 * That is deliberate for the arrays this package actually writes: an existing SessionStart
 * hook from a plugin survives alongside ours, and a user's own `permissions.ask` entry
 * survives alongside the destructive-command baseline. Claude Code merges permission rules
 * across scopes anyway, so concatenating matches how they are consumed.
 *
 * This comment previously claimed non-`hooks` arrays were "replaced only when the target
 * does not already define them", which the code never did: the two branches were
 * byte-identical. Concatenation is the real and intended behavior.
 */
function mergeSettings(existing, incoming) {
  const out = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    const cur = out[k];
    if (isPlainObject(v) && isPlainObject(cur)) {
      out[k] = mergeSettings(cur, v);
    } else if (Array.isArray(v) && Array.isArray(cur)) {
      const seen = new Set(cur.map((x) => JSON.stringify(x)));
      out[k] = [...cur, ...v.filter((x) => !seen.has(JSON.stringify(x)))];
    } else {
      out[k] = v;
    }
  }
  return out;
}

function backup(file) {
  if (!existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dst = `${file}.backup-${stamp}`;
  if (!DRY) copyFileSync(file, dst);
  return dst;
}

function installFiles() {
  if (!existsSync(SRC)) {
    console.error(c.red(`No ./user directory next to bootstrap.mjs (looked in ${SRC})`));
    process.exit(1);
  }

  const manifest = loadManifest();
  const files = walk(SRC).filter((f) => f !== "settings.template.json");
  const next = {};
  let written = 0, skipped = 0, unchanged = 0;

  for (const rel of files) {
    const from = join(SRC, ...rel.split("/"));
    const to = join(DEST, ...rel.split("/"));
    const incoming = readFileSync(from);
    const incomingHash = sha(incoming);
    next[rel] = incomingHash;

    if (existsSync(to)) {
      const currentHash = sha(readFileSync(to));
      if (currentHash === incomingHash) {
        unchanged++;
        continue;
      }
      const knownHash = manifest.files?.[rel];
      const locallyModified = knownHash && knownHash !== currentHash;
      if (locallyModified && !FORCE) {
        console.log(c.yellow(`  skip   ${rel}  (modified locally — rerun with --force to overwrite)`));
        skipped++;
        continue;
      }
      if (!DRY) backup(to);
    }

    if (!DRY) {
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, incoming);
    }
    console.log(c.green(`  write  ${rel}`));
    written++;
  }

  return { next, written, skipped, unchanged };
}

function installSettings() {
  const tplPath = join(SRC, "settings.template.json");
  if (!existsSync(tplPath)) return { changed: false };

  // The hook paths are genuinely machine-specific, so they are resolved at install time
  // rather than carried as a literal in the repo. JSON-encoding handles Windows separators.
  const home = DEST.split("\\").join("/");
  const tpl = readFileSync(tplPath, "utf8")
    .split("__CLAUDE_HOME__")
    .join(home)
    .split("__MIN_VERSION__")
    .join(FLOOR.minimumVersion || "0.0.0");

  let incoming;
  try {
    incoming = JSON.parse(tpl);
  } catch (e) {
    console.error(c.red(`settings.template.json is not valid JSON after substitution: ${e.message}`));
    process.exit(1);
  }

  const target = join(DEST, "settings.json");
  let existing = {};
  if (existsSync(target)) {
    try {
      existing = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      console.error(
        c.red(`  ${target} is not valid JSON. Claude Code rejects an invalid user settings ` +
              `file as a whole, so fix it before installing. Nothing was written.`)
      );
      process.exit(1);
    }
  }

  const merged = mergeSettings(existing, incoming);

  const retired = [];
  for (const [key, why] of DEPRECATED_KEYS) {
    if (key in merged) {
      delete merged[key];
      retired.push([key, why]);
    }
  }

  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) {
    console.log(c.dim("  settings.json already current"));
    return { changed: false };
  }

  const bak = backup(target);
  if (!DRY) writeFileSync(target, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(c.green("  merge  settings.json") + (bak ? c.dim(`  (backup: ${relative(DEST, bak)})`) : ""));
  for (const [key, why] of retired) {
    console.log(c.yellow(`  remove settings.${key}`) + c.dim(`  — ${why}`));
  }
  return { changed: true };
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(major) && major < 18) {
    console.log(c.yellow(`  warning: Node ${process.versions.node} detected; the hooks target Node 18+.`));
  }
}

function doInstall() {
  console.log(c.bold(`\nInstalling orchestrator–worker setup`));
  console.log(c.dim(`  source: ${SRC}`));
  console.log(c.dim(`  target: ${DEST}${DRY ? "   (dry run — nothing will be written)" : ""}\n`));

  checkNode();
  if (!DRY) mkdirSync(DEST, { recursive: true });

  const { next, written, skipped, unchanged } = installFiles();
  installSettings();

  if (!DRY) {
    writeFileSync(
      MANIFEST,
      JSON.stringify({ installedAt: new Date().toISOString(), files: next }, null, 2) + "\n",
      "utf8"
    );
  }

  console.log(
    `\n${c.bold("Done.")} ${written} written, ${unchanged} unchanged` +
      (skipped ? `, ${c.yellow(`${skipped} skipped`)}` : "") + "\n"
  );
  console.log("Next: restart Claude Code, then run " + c.bold("/context") + " to confirm");
  console.log("CLAUDE.md and the rules loaded, and " + c.bold("/status") + " to confirm the settings source.\n");
}

function doStatus() {
  const manifest = loadManifest();
  console.log(c.bold(`\nOrchestrator setup status`));
  console.log(c.dim(`  config dir: ${DEST}`));
  console.log(c.dim(`  installed:  ${manifest.installedAt || "never"}\n`));

  const files = walk(SRC).filter((f) => f !== "settings.template.json");
  let drift = 0;
  for (const rel of files) {
    const to = join(DEST, ...rel.split("/"));
    if (!existsSync(to)) {
      console.log(c.red(`  missing   ${rel}`));
      drift++;
      continue;
    }
    const same = sha(readFileSync(to)) === sha(readFileSync(join(SRC, ...rel.split("/"))));
    if (!same) {
      console.log(c.yellow(`  differs   ${rel}`));
      drift++;
    } else {
      console.log(c.dim(`  ok        ${rel}`));
    }
  }
  console.log(
    drift === 0
      ? c.green("\n  In sync with this repo.")
      : c.yellow(`\n  ${drift} file(s) out of sync — run: node bootstrap.mjs install`)
  );
  console.log(
    c.dim("  Files only — this says nothing about whether the install works.\n" +
          "  Run `node bootstrap.mjs doctor` for that.\n")
  );
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
 * Authoritative but slow — measured at 0.26-1.51s. Acceptable in a command the user ran on
 * purpose; deliberately not used by the session-start hook, which derives the version from
 * the environment instead.
 */
function claudeVersion() {
  try {
    const out = execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 20000 });
    return (out.match(/(\d+\.\d+\.\d+)/) || [])[1] || null;
  } catch {
    return null;
  }
}

/**
 * Read the first `---` fenced block of an agent definition. Enough for model, effort, and
 * skills; deliberately not a YAML parser, because adding a dependency to this installer
 * would cost more than the cases it would cover.
 */
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;

  // Trailing `# comment` and surrounding quotes are the two YAML niceties that show up in
  // hand-written agent files. Stripping them here keeps a legal file from being reported as
  // a broken one — a false FAIL teaches the reader to ignore `doctor`.
  const scrub = (s) =>
    s
      .replace(/(?:^|\s)#.*$/, "") // trailing comment, or a value that is only a comment
      .trim()
      .replace(/^["']|["']$/g, "");

  const out = { skills: [] };
  let inSkills = false;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.+)$/);
    if (inSkills && item) {
      const s = scrub(item[1]);
      if (s) out.skills.push(s);
      continue;
    }
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    inSkills = false;
    const value = scrub(kv[2]);
    if (kv[1] !== "skills") {
      out[kv[1]] = value;
      continue;
    }
    if (value.startsWith("[")) {
      // Inline flow sequence: `skills: [worker-contract, api-design]`
      for (const part of value.replace(/^\[/, "").replace(/\]$/, "").split(",")) {
        const s = scrub(part);
        if (s) out.skills.push(s);
      }
    } else {
      inSkills = true; // block list follows on subsequent lines
      if (value) out.skills.push(value);
    }
  }
  return out;
}

/**
 * Models that accept an `effort` field, per code.claude.com/docs/en/model-config: Fable 5,
 * Opus 5, Sonnet 5, Opus 4.8, Opus 4.7, Opus 4.6, and Sonnet 4.6. Haiku is absent from that
 * table, so `effort` on a haiku agent asserts a guarantee the runtime never provides.
 * Anything not matched here is treated as effort-incapable.
 */
const EFFORT_CAPABLE = /^(opus|sonnet|fable)$|opus-5|sonnet-5|fable-5|opus-4-8|opus-4-7|opus-4-6|sonnet-4-6/i;

/**
 * Bedrock and Vertex resolve the bare `opus` / `sonnet` aliases to older generations than
 * the Anthropic API does, and some of those do not support `effort`. When one of these is
 * in play, a bare alias is not decidable from an agent file alone.
 */
const ALT_PROVIDER =
  (process.env.CLAUDE_CODE_USE_BEDROCK === "1" && "Bedrock") ||
  (process.env.CLAUDE_CODE_USE_VERTEX === "1" && "Vertex") ||
  null;

function doDoctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // 1. File drift. A file that differs because the repo moved ahead is stale and fails. A
  // file the user deliberately edited is a choice, not a defect: `install` already refuses
  // to clobber it, so reporting it as a failure would only teach the reader to ignore this
  // command. The manifest distinguishes the two — it records what was last written here,
  // so an installed file that no longer matches it was edited locally.
  const manifest = loadManifest();
  const files = walk(SRC).filter((f) => f !== "settings.template.json");
  const stale = [];
  const localEdits = [];
  for (const rel of files) {
    const to = join(DEST, ...rel.split("/"));
    if (!existsSync(to)) {
      stale.push(rel);
      continue;
    }
    const installedHash = sha(readFileSync(to));
    if (installedHash === sha(readFileSync(join(SRC, ...rel.split("/"))))) continue;
    const knownHash = manifest.files && manifest.files[rel];
    if (knownHash && knownHash !== installedHash) localEdits.push(rel);
    else stale.push(rel);
  }
  const detail = [
    stale.length ? `${stale.length} stale: ${stale.slice(0, 5).join(", ")}` : null,
    localEdits.length
      ? `${localEdits.length} locally modified and kept: ${localEdits.slice(0, 5).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("; ");
  add(
    "installed files match this repo",
    stale.length === 0,
    detail || `${files.length} files`
  );

  // 2. Claude Code version against the floor.
  const running = claudeVersion();
  const floorName = `Claude Code >= ${FLOOR.minimumVersion || "(floor unreadable)"}`;
  if (!FLOOR.minimumVersion) {
    add(floorName, false, "user/version-floor.json is missing or unreadable");
  } else if (!running) {
    add(floorName, false, "`claude --version` did not run — is claude on PATH?");
  } else {
    const ok = cmpVersion(running, FLOOR.minimumVersion) >= 0;
    const inactive = (FLOOR.features || [])
      .filter((f) => Array.isArray(f) && cmpVersion(running, f[0]) < 0)
      .map((f) => f[1]);
    add(floorName, ok, ok ? running : `${running} — inactive: ${inactive.join(", ")}`);
  }

  // 3. settings.json parses, and our keys survived the merge.
  const settingsPath = join(DEST, "settings.json");
  let settings = null;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    add("settings.json is valid JSON", true, settingsPath);
    const missing = ["model", "effortLevel", "env", "hooks"].filter((k) => !(k in settings));
    add(
      "orchestrator keys present after merge",
      missing.length === 0,
      missing.length ? `missing: ${missing.join(", ")}` : "model, effortLevel, env, hooks"
    );
  } catch (e) {
    add("settings.json is valid JSON", false, `${settingsPath}: ${e.message}`);
    add("orchestrator keys present after merge", false, "settings.json could not be read");
  }

  // 4. Every hook command path resolves on this machine. A check with nothing to inspect
  // is not a pass: unreadable settings means unknown, and unknown fails.
  if (!settings) {
    add("hook and statusLine paths resolve", false, "settings.json could not be read");
  } else {
    // Script paths in settings are absolute and machine-specific, whoever wrote them. A
    // path installed on a laptop is the most common way a config breaks on a server, so
    // statusLine is checked alongside hooks rather than left as someone else's problem.
    const scripts = [];
    for (const groups of Object.values(settings.hooks || {})) {
      for (const g of groups || []) {
        for (const h of g.hooks || []) scripts.push(h.command);
      }
    }
    if (settings.statusLine && settings.statusLine.command) {
      scripts.push(settings.statusLine.command);
    }

    const badHooks = [];
    const resolved = [];
    let hookCount = 0;
    for (const cmd of scripts) {
      const match = String(cmd || "").match(/"([^"]+\.(?:mjs|js|sh|py))"|(\S+\.(?:mjs|js|sh|py))/);
      const p = match && (match[1] || match[2]);
      if (!p) continue; // e.g. `rtk hook claude` — a PATH lookup, not a file we can check
      hookCount++;
      if (existsSync(p)) resolved.push(p);
      else badHooks.push(p);
    }
    add(
      "hook and statusLine paths resolve",
      badHooks.length === 0,
      badHooks.length ? `missing: ${badHooks.join(", ")}` : `${hookCount} script path(s)`
    );

    // A path that exists is not a hook that runs. A truncated or half-written file passes
    // `existsSync` and then fails at the first session — and the drift check above cannot
    // catch it, because a corrupted file and a deliberate local edit are indistinguishable
    // by hash. `node --check` is what tells them apart, and it is the same check this
    // repo's CLAUDE.md already prescribes for a human changing these files.
    const unparseable = [];
    for (const p of resolved) {
      if (!/\.m?js$/.test(p)) continue; // only JS is ours to parse
      try {
        execFileSync(process.execPath, ["--check", p], { stdio: "ignore", timeout: 20000 });
      } catch {
        unparseable.push(p);
      }
    }
    add(
      "installed hook scripts parse",
      unparseable.length === 0,
      unparseable.length
        ? `not valid JavaScript: ${unparseable.join(", ")}`
        : `${resolved.filter((p) => /\.m?js$/.test(p)).length} script(s) pass node --check`
    );
  }

  // 5 and 6. Agent skills resolve; no effort declared on an effort-incapable model.
  const badSkills = [];
  const badEffort = [];
  const unknownEffort = [];
  const agentDir = join(DEST, "agents");
  const agents = existsSync(agentDir)
    ? readdirSync(agentDir).filter((n) => n.endsWith(".md"))
    : [];
  for (const name of agents) {
    let fm;
    try {
      fm = frontmatter(readFileSync(join(agentDir, name), "utf8"));
    } catch {
      continue;
    }
    if (!fm) continue;
    for (const s of fm.skills) {
      // Plugin-scoped skills belong to a plugin's install, not to this package.
      if (s.includes(":")) continue;
      if (!existsSync(join(DEST, "skills", s, "SKILL.md"))) badSkills.push(`${name} -> ${s}`);
    }
    // `inherit` (and an absent `model`, which means the same thing) resolves to the main
    // conversation's model, so whether it supports effort is not knowable from this file.
    // Flagging it would be a false positive, not a finding.
    if (!fm.effort || !fm.model || fm.model === "inherit") continue;
    if (!EFFORT_CAPABLE.test(fm.model)) {
      badEffort.push(`${name}: effort: ${fm.effort} on model: ${fm.model}`);
    } else if (ALT_PROVIDER && /^(opus|sonnet|fable)$/i.test(fm.model)) {
      // On Bedrock and Vertex a bare alias resolves to an older generation than on the
      // Anthropic API (see docs/DESIGN-RATIONALE.md §7), and some of those do not support
      // effort at all. This check cannot see which model the alias resolves to here, so it
      // reports unknown rather than claiming a pass it has not established.
      unknownEffort.push(`${name}: model: ${fm.model} resolves per-provider on ${ALT_PROVIDER}`);
    }
  }
  add(
    "agent `skills:` entries resolve",
    badSkills.length === 0,
    badSkills.length ? badSkills.join("; ") : `${agents.length} agent(s)`
  );
  add(
    "no `effort` on an effort-incapable model",
    badEffort.length === 0,
    badEffort.length
      ? badEffort.join("; ")
      : unknownEffort.length
        ? `${agents.length} agent(s); not decidable here: ${unknownEffort.join("; ")}`
        : `${agents.length} agent(s)`
  );

  console.log(c.bold(`\nOrchestrator doctor`));
  console.log(c.dim(`  config dir: ${DEST}\n`));
  for (const ch of checks) {
    console.log(`  ${ch.ok ? c.green("PASS") : c.red("FAIL")}  ${ch.name}`);
    if (ch.detail) console.log(c.dim(`        ${ch.detail}`));
  }
  const failed = checks.filter((ch) => !ch.ok).length;
  console.log(
    failed === 0
      ? c.green(`\n  ${checks.length} checks passed.\n`)
      : c.red(`\n  ${failed} of ${checks.length} checks failed.\n`)
  );
  process.exit(failed === 0 ? 0 : 1);
}

switch (cmd) {
  case "install":
    doInstall();
    break;
  case "status":
  case "diff":
    doStatus();
    break;
  case "doctor":
    doDoctor();
    break;
  default:
    console.error(`Unknown command "${cmd}". Use: install | status | diff | doctor`);
    process.exit(1);
}
