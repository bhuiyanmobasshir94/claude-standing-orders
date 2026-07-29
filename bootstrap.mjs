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
 *   node bootstrap.mjs uninstall   remove what this package installed, and only that
 *
 * `status` compares file hashes and nothing else. `doctor` answers the different and more
 * useful question of whether this machine can run the setup: Claude Code version against
 * the floor, hook paths that resolve here, settings that still parse after the merge, and
 * agent definitions that do not assert capabilities the model does not have.
 *
 * Flags:
 *   --dry-run    print what would change, write nothing
 *   --force      overwrite locally modified files instead of skipping them
 *   --yes        actually perform an uninstall (without it, uninstall only prints its plan)
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
  unlinkSync, rmdirSync,
} from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";
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

// `install` is the default command, which makes an unrecognized argument dangerous: a
// stranger typing `--help`, or fat-fingering `--dry-run`, would otherwise silently perform
// a real install. Both are caught before anything is written.
const KNOWN_FLAGS = ["--dry-run", "--force", "--yes", "--help", "-h"];
const HELP = argv.some((a) => a === "--help" || a === "-h" || a === "help");
const unknownFlags = argv.filter(
  (a) => a.startsWith("-") && !KNOWN_FLAGS.includes(a) && !a.startsWith("--home=")
);

const cmd = argv.find((a) => !a.startsWith("-")) || "install";
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
const YES = argv.includes("--yes");
const homeFlag = argv.find((a) => a.startsWith("--home="));

function usage() {
  console.log(`
Orchestrator-worker setup installer

  node bootstrap.mjs <command> [flags]

Commands
  install     copy files into the Claude Code config dir and merge settings (default)
  status      show which installed files differ from this repo (file hashes only)
  doctor      check that the install actually works on this machine; exits 1 on failure
  uninstall   remove what this package installed, and only that; needs --yes to write
  help        show this message

Flags
  --dry-run     print what would change, write nothing
  --force       overwrite locally modified files instead of skipping them
  --yes         perform the uninstall; without it, uninstall only prints its plan
  --home=PATH   target a config dir other than the default (for testing)
  -h, --help    show this message

Settings are merged, never replaced, and a timestamped backup is written first.
After installing, run \`node bootstrap.mjs doctor\`, then restart Claude Code.
`);
}

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

/**
 * Hook entries this package once installed and has since moved or retired.
 *
 * `DEPRECATED_KEYS` only reaches top-level keys, and the merge concatenates arrays — so a hook
 * this package moves to a different event would otherwise stay wired at the old event on every
 * machine that already installed it, forever. Matching is by event plus a substring of the
 * command, which is specific enough to hit only our own entry: no other package writes a
 * command containing this repo's hook filename.
 *
 * Each row is [event, command substring, why].
 */
const DEPRECATED_HOOKS = [
  [
    "SubagentStart",
    "hooks/packet-check.mjs",
    "the SubagentStart payload carries no prompt text, so the check was inert there; " +
      "it now runs on PreToolUse where the packet actually exists",
  ],
];

/**
 * Strip retired hook entries out of a merged settings object.
 *
 * Removes only the individual hook whose command matches, then drops the group and the event
 * if that left them empty — an empty `{"hooks":[]}` group is noise that survives forever
 * otherwise. Any co-located entry belonging to a plugin or to the user is untouched.
 */
function removeDeprecatedHooks(settings) {
  const removed = [];
  const events = settings && settings.hooks;
  if (!isPlainObject(events)) return removed;

  for (const [event, substr, why] of DEPRECATED_HOOKS) {
    const groups = events[event];
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const keep = group.hooks.filter((h) => !(h && typeof h.command === "string" && h.command.includes(substr)));
      if (keep.length !== group.hooks.length) removed.push([`hooks.${event} (${substr})`, why]);
      group.hooks = keep;
    }

    events[event] = groups.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0);
    if (events[event].length === 0) delete events[event];
  }
  return removed;
}

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
    // The manifest records what this package last *wrote*, not what the repo currently holds.
    // Overwriting it on a skip would erase the only evidence that the installed copy has fallen
    // behind, and `doctor` would report a permanently stale file as healthy.
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
        next[rel] = knownHash;
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

/**
 * The settings this package contributes to this machine, with the machine-specific
 * placeholders resolved. Install merges this in; uninstall subtracts it back out. Both need
 * the identical object, so it is rendered in one place — a second copy of the substitution
 * would eventually drift and leave uninstall unable to recognize its own entries.
 *
 * Returns null when there is no template, `exit(1)` when the template is unparseable.
 */
function renderTemplate() {
  const tplPath = join(SRC, "settings.template.json");
  if (!existsSync(tplPath)) return null;

  // The hook paths are genuinely machine-specific, so they are resolved at install time
  // rather than carried as a literal in the repo. JSON-encoding handles Windows separators.
  const home = DEST.split("\\").join("/");
  const tpl = readFileSync(tplPath, "utf8")
    .split("__CLAUDE_HOME__")
    .join(home)
    .split("__MIN_VERSION__")
    .join(FLOOR.minimumVersion || "0.0.0");

  try {
    return JSON.parse(tpl);
  } catch (e) {
    console.error(c.red(`settings.template.json is not valid JSON after substitution: ${e.message}`));
    process.exit(1);
  }
}

function installSettings() {
  const incoming = renderTemplate();
  if (!incoming) return { changed: false };

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
  retired.push(...removeDeprecatedHooks(merged));

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
  console.log("Next:");
  console.log("  1. " + c.bold("node bootstrap.mjs doctor") + "   confirm this machine can actually run it");
  console.log("  2. restart Claude Code           settings and CLAUDE.md load at session start");
  console.log("  3. " + c.bold("/context") + " and " + c.bold("/status") + "        confirm the policy loaded and the model is right\n");
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
  const localEdits = []; // locally modified, still carrying the newest content we wrote
  const behind = []; // locally modified, and the repo has moved on since we wrote it
  for (const rel of files) {
    const to = join(DEST, ...rel.split("/"));
    if (!existsSync(to)) {
      stale.push(rel);
      continue;
    }
    const installedHash = sha(readFileSync(to));
    const repoHash = sha(readFileSync(join(SRC, ...rel.split("/"))));
    if (installedHash === repoHash) continue;
    const knownHash = manifest.files && manifest.files[rel];
    if (!knownHash || knownHash === installedHash) {
      stale.push(rel);
      continue;
    }
    // `install` skips a locally modified file, so the only thing separating "edited, and
    // otherwise current" from "edited, and years out of date" is whether the content we last
    // wrote is still what the repo holds.
    if (knownHash === repoHash) localEdits.push(rel);
    else behind.push(rel);
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

  // A locally edited file is a choice; a locally edited file the package can no longer update
  // is silent divergence, which is the failure this whole setup exists to prevent. `install`
  // will skip it on every future run and say so only in passing, so `doctor` has to fail.
  add(
    "no locally modified file is behind this repo",
    behind.length === 0,
    behind.length
      ? `${behind.join(", ")} — edited here, and this repo has changed since. ` +
        `\`install\` skips these, so package updates no longer reach this machine. ` +
        `Move your additions into ~/.claude/rules/<name>.md, which is loaded automatically ` +
        `and is not owned by this package, then rerun install (or install --force to discard).`
      : `${localEdits.length} locally modified file(s), all current`
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

/**
 * Subtract this package's contribution from a merged settings object.
 *
 * A value is removed only when it still **exactly equals** what the template installed.
 * That is the settings analogue of the manifest hash rule used for files: if it is still
 * byte-identical to what we wrote, we wrote it and nothing has claimed it since; if it
 * differs, someone changed it deliberately and it is now theirs to keep.
 *
 * Arrays are subtracted element-wise by JSON identity, the same identity the merge used to
 * de-duplicate them. So a plugin's SessionStart hook sitting in the same array as ours
 * survives, and only our own entries leave. A container emptied by that subtraction is
 * dropped rather than left behind as `{}` or `[]`.
 *
 * Deliberately not handled: a key the template sets that the user's settings had *before*
 * the first install with a different value. The merge overwrote it and kept no record, so
 * the original is unrecoverable here. The timestamped backups are the recovery path, and
 * uninstall writes a fresh one before touching anything.
 */
function subtractSettings(target, template, path = "", removed = [], kept = []) {
  const out = { ...target };
  for (const [k, tv] of Object.entries(template)) {
    if (!(k in out)) continue;
    const cur = out[k];
    const where = path ? `${path}.${k}` : k;

    if (isPlainObject(tv) && isPlainObject(cur)) {
      const [sub] = subtractSettings(cur, tv, where, removed, kept);
      if (Object.keys(sub).length === 0) delete out[k];
      else out[k] = sub;
    } else if (Array.isArray(tv) && Array.isArray(cur)) {
      const ours = new Set(tv.map((x) => JSON.stringify(x)));
      const rest = cur.filter((x) => !ours.has(JSON.stringify(x)));
      const n = cur.length - rest.length;
      if (n) removed.push(`${where}  (${n} of ${cur.length} entries)`);
      if (rest.length === 0) delete out[k];
      else out[k] = rest;
    } else if (JSON.stringify(cur) === JSON.stringify(tv)) {
      delete out[k];
      removed.push(where);
    } else {
      kept.push(`${where}  (changed since install)`);
    }
  }
  return [out, removed, kept];
}

/**
 * Remove what this package installed, and nothing else.
 *
 * Ownership comes from the manifest, not from the current contents of ./user: a file this
 * package installed in an earlier version and has since dropped from the repo is still ours
 * to remove, and a file we never wrote is never ours to touch no matter where it sits.
 *
 * Because it deletes, this command is inert without `--yes`. A mistyped `uninstall` printing
 * a plan costs nothing; one that runs costs a config directory. The plan is the same text
 * either way, so what you approve is what happens.
 */
function doUninstall() {
  const APPLY = YES && !DRY;
  console.log(c.bold(`\nUninstall orchestrator–worker setup`));
  console.log(c.dim(`  config dir: ${DEST}`));
  console.log(c.dim(`  ${APPLY ? "removing files now" : "plan only — nothing will be written"}\n`));

  // The manifest is the only record of what this package owns, so it is read strictly here
  // rather than through `loadManifest`, which tolerates a corrupt file by returning an empty
  // one. That tolerance is right for install — it just reinstalls — and wrong here: an empty
  // manifest would report "removed 0 files" and then delete the manifest itself, destroying
  // the only thing that could have made a later uninstall correct.
  let manifest = null;
  let manifestError = null;
  if (existsSync(MANIFEST)) {
    try {
      const parsed = JSON.parse(readFileSync(MANIFEST, "utf8"));
      if (parsed && isPlainObject(parsed.files)) manifest = parsed;
      else manifestError = "it has no `files` object";
    } catch (e) {
      manifestError = e.message;
    }
  }
  if (!manifest) {
    console.log(
      c.yellow(
        manifestError
          ? `  Manifest at ${MANIFEST} is unreadable: ${manifestError}`
          : `  No manifest at ${MANIFEST}.`
      )
    );
    console.log(
      c.dim("  Without it there is no record of which files this package wrote, and guessing\n" +
            "  from ./user could delete a file someone else owns. Nothing was removed.\n")
    );
    return;
  }
  const owned = Object.entries(manifest.files);

  // 1. Files. Ours and untouched -> remove. Ours but edited -> keep and say so.
  const remove = [];
  const keptFiles = [];
  const gone = [];
  for (const [rel, knownHash] of owned) {
    const to = join(DEST, ...rel.split("/"));
    if (!existsSync(to)) {
      gone.push(rel);
      continue;
    }
    if (sha(readFileSync(to)) === knownHash) remove.push(rel);
    else keptFiles.push(rel);
  }

  for (const rel of remove) {
    console.log(c.green(`  remove  ${rel}`));
    if (APPLY) unlinkSync(join(DEST, ...rel.split("/")));
  }
  for (const rel of keptFiles) {
    console.log(c.yellow(`  keep    ${rel}  (modified locally — delete it yourself if you want it gone)`));
  }
  if (gone.length) console.log(c.dim(`  ${gone.length} file(s) already absent`));

  // 2. Directories this package created, but only once they are empty. An empty `agents/`
  // is ours to clean up; one still holding an agent someone else wrote is not.
  if (APPLY) {
    const dirs = [...new Set(remove.map((rel) => dirname(join(DEST, ...rel.split("/")))))]
      .sort((a, b) => b.length - a.length); // deepest first, so nesting collapses in one pass
    // `DEST + sep`, not `DEST`: a bare prefix test would also accept a sibling directory
    // whose name merely starts with the config dir's, e.g. `~/.claude-backup`.
    const inside = (p) => p.startsWith(DEST + sep) && p !== DEST;
    for (const d of dirs) {
      let cur = d;
      while (inside(cur)) {
        try {
          if (readdirSync(cur).length) break;
          rmdirSync(cur);
          console.log(c.dim(`  rmdir   ${relative(DEST, cur)}`));
        } catch {
          break;
        }
        cur = dirname(cur);
      }
    }
  }

  // 3. Settings. Subtract only values still identical to what we installed.
  const template = renderTemplate();
  const settingsPath = join(DEST, "settings.json");
  let settingsChanged = false;
  if (template && existsSync(settingsPath)) {
    let existing;
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (e) {
      console.log(c.red(`\n  settings.json is not valid JSON (${e.message}) — left untouched.`));
      existing = null;
    }
    if (existing) {
      const [pruned, removedKeys, keptKeys] = subtractSettings(existing, template);
      if (removedKeys.length === 0) {
        console.log(c.dim("\n  settings.json: nothing of ours left to remove"));
      } else {
        settingsChanged = true;
        const bak = APPLY ? backup(settingsPath) : null;
        // Nothing left means the file held only our keys. An empty settings.json is
        // semantically identical to no settings.json, and the backup written a line above
        // is the recovery path, so leave a clean directory rather than a `{}`.
        const emptied = Object.keys(pruned).length === 0;
        if (APPLY) {
          if (emptied) unlinkSync(settingsPath);
          else writeFileSync(settingsPath, JSON.stringify(pruned, null, 2) + "\n", "utf8");
        }
        console.log(
          `\n  ${c.green("settings.json")}` + (bak ? c.dim(`  (backup: ${relative(DEST, bak)})`) : "")
        );
        for (const k of removedKeys) console.log(c.green(`    remove  ${k}`));
        if (emptied) console.log(c.dim("    file removed — nothing but our keys was in it"));
      }
      for (const k of keptKeys) console.log(c.yellow(`    keep    ${k}`));
    }
  }

  // 4. The manifest goes only when it has nothing left to describe. While a locally
  // modified file survives, the manifest is the only record that it came from here.
  if (APPLY) {
    if (keptFiles.length === 0) {
      unlinkSync(MANIFEST);
      console.log(c.dim(`\n  remove  ${relative(DEST, MANIFEST)}`));
    } else {
      const rest = {};
      for (const rel of keptFiles) rest[rel] = manifest.files[rel];
      writeFileSync(
        MANIFEST,
        JSON.stringify({ installedAt: manifest.installedAt || null, files: rest }, null, 2) + "\n",
        "utf8"
      );
      console.log(c.dim(`\n  manifest kept — it still describes ${keptFiles.length} local file(s)`));
    }
  }

  if (!APPLY) {
    console.log(
      c.bold(`\nPlan only. ${remove.length} file(s) would be removed.`) +
        "\nRe-run with " + c.bold("--yes") + " to apply.\n"
    );
    return;
  }
  console.log(
    c.bold(`\nRemoved ${remove.length} file(s).`) +
      (keptFiles.length ? c.yellow(` Kept ${keptFiles.length} locally modified.`) : "")
  );
  // Only worth saying when something actually changed — a second uninstall that found
  // nothing left should not send anyone off to restart their editor for no reason.
  if (remove.length || settingsChanged) {
    console.log("Restart Claude Code so the change takes effect.");
  }
  console.log("");
}

if (HELP) {
  usage();
  process.exit(0);
}
if (unknownFlags.length) {
  console.error(c.red(`Unknown flag: ${unknownFlags.join(", ")}`));
  console.error(c.dim("Nothing was written. Recognized flags are listed below.\n"));
  usage();
  process.exit(1);
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
  case "uninstall":
    doUninstall();
    break;
  default:
    console.error(`Unknown command "${cmd}". Use: install | status | diff | doctor | uninstall`);
    process.exit(1);
}
