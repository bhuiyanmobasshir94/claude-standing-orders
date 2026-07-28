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
 *
 * Flags:
 *   --dry-run    print what would change, write nothing
 *   --force      overwrite locally modified files instead of skipping them
 *   --home=PATH  target a config dir other than the default (for testing)
 *
 * Settings are merged, never replaced: existing keys are preserved, hook arrays are
 * concatenated with de-duplication, and a timestamped backup is written before any change.
 */

import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync, statSync,
} from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "user");

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

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Deep-merge settings. Incoming values win for scalars, but:
 *  - arrays under `hooks` are concatenated and de-duplicated by JSON identity, so an
 *    existing SessionStart hook (e.g. from a plugin) survives alongside ours;
 *  - other arrays are replaced only when the target does not already define them.
 */
function mergeSettings(existing, incoming, path = []) {
  const out = { ...existing };
  for (const [k, v] of Object.entries(incoming)) {
    const here = [...path, k];
    const cur = out[k];
    if (isPlainObject(v) && isPlainObject(cur)) {
      out[k] = mergeSettings(cur, v, here);
    } else if (Array.isArray(v) && Array.isArray(cur)) {
      if (here[0] === "hooks") {
        const seen = new Set(cur.map((x) => JSON.stringify(x)));
        out[k] = [...cur, ...v.filter((x) => !seen.has(JSON.stringify(x)))];
      } else {
        const seen = new Set(cur.map((x) => JSON.stringify(x)));
        out[k] = [...cur, ...v.filter((x) => !seen.has(JSON.stringify(x)))];
      }
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
  const tpl = readFileSync(tplPath, "utf8").split("__CLAUDE_HOME__").join(home);

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
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) {
    console.log(c.dim("  settings.json already current"));
    return { changed: false };
  }

  const bak = backup(target);
  if (!DRY) writeFileSync(target, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(c.green("  merge  settings.json") + (bak ? c.dim(`  (backup: ${relative(DEST, bak)})`) : ""));
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
      ? c.green("\n  In sync with this repo.\n")
      : c.yellow(`\n  ${drift} file(s) out of sync — run: node bootstrap.mjs install\n`)
  );
}

switch (cmd) {
  case "install":
    doInstall();
    break;
  case "status":
  case "diff":
    doStatus();
    break;
  default:
    console.error(`Unknown command "${cmd}". Use: install | status | diff`);
    process.exit(1);
}
