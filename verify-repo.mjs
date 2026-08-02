#!/usr/bin/env node
/**
 * verify-repo.mjs — structural invariants for the orchestrator repository.
 *
 * Checks properties rather than an exact file list, so it stays valid as the repo grows.
 * Complements `bootstrap.mjs status/doctor`, which checks the INSTALLED state in
 * ~/.claude; this checks the SOURCE state in the repo.
 *
 * Usage:  node verify-repo.mjs            (from the repo root)
 *         node verify-repo.mjs --verbose
 *
 * Exits 0 if every invariant holds, 1 otherwise. No dependencies.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const VERBOSE = process.argv.includes("--verbose");

// Authority for: every frontmatter key Claude Code accepts on an agent definition
// (user/agents/*.md). Source: Claude Code's own agent-definition contract, not a file in
// this repo — section 4 (Agents) fails any key outside this set as unknown.
const AGENT_FIELDS = new Set([
  "name", "description", "tools", "disallowedTools", "model", "permissionMode", "maxTurns",
  "skills", "mcpServers", "hooks", "memory", "background", "effort", "isolation", "color",
  "initialPrompt",
]);
// Authority for: every frontmatter key Claude Code accepts on a SKILL.md. Source: Claude
// Code's own skill-definition contract — section 5 (Skills) fails any key outside this set.
const SKILL_FIELDS = new Set([
  "name", "description", "disable-model-invocation", "user-invocable", "allowed-tools",
  "model", "effort", "context", "agent", "hooks", "paths", "argument-hint", "arguments",
]);
// Authority for: the one frontmatter key a path-scoped rule file may declare. Source:
// Claude Code's rule-loading contract (paths: activates a rule only when a matching file
// is touched) — section 6 (Rules) fails any other key as unknown.
const RULE_FIELDS = new Set(["paths"]);

// Authority for: recognized model aliases across agent/skill frontmatter. Source: the
// alias table this package pins against, also restated in CLAUDE.md's Roles table.
const MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "fable", "inherit", "default", "best"]);
// Authority for: recognized values of an `effort:` field. Source: Claude Code's effort
// levels — section 4 (Agents) rejects any value outside this set.
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
/** Models that support effort levels. Haiku is deliberately absent. */
const EFFORT_CAPABLE = new Set(["sonnet", "opus", "fable", "best"]);

// Authority for: the line budget a CLAUDE.md must stay under. Source: this package's own
// size-discipline convention (see section 7, Size) — chosen so the file stays skimmable.
const CLAUDE_MD_MAX_LINES = 170;
const LEAK_TERMS = /\b(django|celery|IBBL|serializer|SESCredential|drf)\b/i;

let failures = 0;
let checks = 0;

/**
 * Records a satisfied invariant. Only printed under `--verbose`, since a passing repo
 * should be quiet by default and the failures are what need attention.
 *
 * @param {string} msg - Human-readable description of the invariant that held.
 * @returns {void}
 */
function pass(msg) {
  checks++;
  if (VERBOSE) console.log(`  ok    ${msg}`);
}
/**
 * Records and prints a violated invariant. Always printed, regardless of `--verbose`,
 * and counted toward the final failure tally that decides the process exit code.
 *
 * @param {string} msg - Human-readable description of the invariant that failed.
 * @param {string} [detail] - Optional extra context (e.g. an error message or offending
 *   line) printed indented beneath `msg`.
 * @returns {void}
 */
function fail(msg, detail) {
  checks++;
  failures++;
  console.log(`  FAIL  ${msg}${detail ? `\n          ${detail}` : ""}`);
}
/**
 * Prints a section banner to separate one group of related invariants from the next in
 * the console output.
 *
 * @param {string} name - The section's display name (e.g. "Layout", "Agents").
 * @returns {void}
 */
function section(name) {
  console.log(`\n${name}`);
}

/**
 * Minimal YAML frontmatter reader for the subset used here: scalars, lists, block scalars.
 *
 * @param {string} text - The full file contents, frontmatter block plus body.
 * @returns {object|null} The parsed key/value map, or `null` specifically when the file has
 *   no `---`-delimited frontmatter block at all. That distinction is load-bearing: section 6
 *   (Rules) treats `null` as "this rule is always-loaded, by design" and passes, whereas an
 *   empty object `{}` would mean "frontmatter exists but declares nothing" — a different,
 *   and differently-checked, condition.
 */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const out = {};
  let key = null;
  let inBlock = false;

  for (const raw of m[1].split(/\r?\n/)) {
    if (!raw.trim()) continue;

    const indented = /^\s/.test(raw);
    if (inBlock && indented) continue; // block scalar continuation
    if (indented) {
      const item = /^\s*-\s+(.*)$/.exec(raw);
      if (item && key) {
        if (!Array.isArray(out[key])) out[key] = [];
        out[key].push(unquote(item[1].trim()));
      }
      continue;
    }

    inBlock = false;
    if (raw.trim().startsWith("#")) continue;

    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    key = kv[1];
    const val = kv[2].trim();
    if (val === "" ) { out[key] = null; }
    else if (/^[>|][-+]?$/.test(val)) { out[key] = "<block>"; inBlock = true; }
    else { out[key] = unquote(val); }
  }
  return out;
}
const unquote = (s) => s.replace(/^['"]|['"]$/g, "");

/**
 * Recursively collects every file path under `dir`, skipping `.git` and `node_modules`.
 *
 * @param {string} dir - Directory to walk, as an absolute or CWD-relative path.
 * @param {string[]} [acc] - Accumulator carried through the recursion; callers should
 *   normally omit it and rely on the default.
 * @returns {string[]} Every file path found, in traversal order (directories not included).
 */
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}
const rel = (p) => relative(ROOT, p).split("\\").join("/");

// ── 1. Layout ────────────────────────────────────────────────────────────────
// Defends the package's expected file tree: every directory a downstream install depends on
// (agents, skills, rules, hooks, templates) is present, and nothing from a prior major
// version (project/, INSTALL_PROMPT.md) still lingers to be installed by mistake.
section("Layout");
for (const p of ["bootstrap.mjs", "user", "user/agents", "user/skills", "user/rules",
                 "user/hooks", "user/CLAUDE.md", "user/settings.template.json",
                 "project-template", "project-template/rules", "examples", "docs"]) {
  existsSync(join(ROOT, p)) ? pass(`${p} present`) : fail(`${p} missing`);
}
for (const p of ["project", "INSTALL_PROMPT.md"]) {
  existsSync(join(ROOT, p))
    ? fail(`${p} still present — v1 leftover, should have been removed`)
    : pass(`${p} correctly absent`);
}

// ── 2. Scripts parse ─────────────────────────────────────────────────────────
// Defends against a syntax error shipping silently: every .mjs/.js file in the repo must
// parse under `node --check`, so a broken script fails here rather than at install time or,
// worse, inside a hook that fails open and never surfaces the error to anyone.
section("Scripts");
const scripts = walk(ROOT).filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));
if (!scripts.length) fail("no .mjs scripts found");
for (const f of scripts) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    pass(`${rel(f)} parses`);
  } catch (e) {
    fail(`${rel(f)} does not parse`, String(e.stderr || e).split("\n")[0]);
  }
}

// ── 3. JSON parses ───────────────────────────────────────────────────────────
// Defends against malformed JSON reaching `bootstrap.mjs`, which merges these files into a
// user's real ~/.claude/settings.json; a parse failure there corrupts an installed config
// rather than failing a check here. Also confirms settings.template.json still carries the
// __CLAUDE_HOME__ placeholder bootstrap.mjs substitutes per machine.
section("JSON");
for (const f of walk(ROOT).filter((f) => f.endsWith(".json"))) {
  try {
    JSON.parse(readFileSync(f, "utf8"));
    pass(`${rel(f)} parses`);
  } catch (e) {
    fail(`${rel(f)} invalid JSON`, e.message);
  }
}
const tpl = join(ROOT, "user/settings.template.json");
if (existsSync(tpl)) {
  readFileSync(tpl, "utf8").includes("__CLAUDE_HOME__")
    ? pass("settings.template.json keeps the __CLAUDE_HOME__ placeholder")
    : fail("settings.template.json lost __CLAUDE_HOME__ — hook paths will not resolve per machine");
}

// ── 4. Agents ────────────────────────────────────────────────────────────────
// Defends the worker contract at its source: each agent's frontmatter declares only
// recognized fields, a valid model and effort combination (no effort on an effort-incapable
// model), no tool that lets a worker spawn a worker, and skills it preloads resolve to real
// files — the properties CLAUDE.md's Roles table and parallelism rules assume hold.
section("Agents");
const agentDir = join(ROOT, "user/agents");
const agents = existsSync(agentDir)
  ? readdirSync(agentDir).filter((f) => f.endsWith(".md")).map((f) => join(agentDir, f))
  : [];
if (agents.length < 4) fail(`expected at least 4 agents, found ${agents.length}`);

const installedSkills = new Set(
  existsSync(join(ROOT, "user/skills"))
    ? readdirSync(join(ROOT, "user/skills")).filter((d) =>
        existsSync(join(ROOT, "user/skills", d, "SKILL.md")))
    : []
);

for (const f of agents) {
  const name = basename(f);
  const fm = frontmatter(readFileSync(f, "utf8"));
  if (!fm) { fail(`${name} has no YAML frontmatter`); continue; }

  const unknown = Object.keys(fm).filter((k) => !AGENT_FIELDS.has(k));
  unknown.length ? fail(`${name} unknown frontmatter: ${unknown.join(", ")}`)
                 : pass(`${name} frontmatter fields valid`);

  if (!fm.name) fail(`${name} missing required: name`);
  if (!fm.description) fail(`${name} missing required: description`);

  const model = fm.model;
  if (model && !MODEL_ALIASES.has(model) && !String(model).startsWith("claude-")) {
    fail(`${name} unrecognized model: ${model}`);
  }

  if (fm.effort !== undefined) {
    if (!EFFORTS.has(fm.effort)) fail(`${name} invalid effort: ${fm.effort}`);
    else if (!EFFORT_CAPABLE.has(model)) {
      fail(`${name} declares effort:${fm.effort} on model:${model}, which has no effort support — silently ignored`);
    } else pass(`${name} effort:${fm.effort} valid on ${model}`);
  } else pass(`${name} no effort field (model:${model})`);

  const tools = String(fm.tools || "");
  /\bAgent\b|\bTask\b/.test(tools)
    ? fail(`${name} lists a subagent-spawning tool — workers must not fan out`)
    : pass(`${name} cannot spawn subagents`);

  for (const s of fm.skills || []) {
    installedSkills.has(s) ? pass(`${name} preloads ${s} (resolves)`)
                           : fail(`${name} preloads "${s}" but user/skills/${s}/SKILL.md does not exist`);
  }
}

// ── 5. Skills ────────────────────────────────────────────────────────────────
// Defends that every installed skill has valid, complete frontmatter, and that no skill an
// agent preloads sets `disable-model-invocation: true` — a preloaded skill is always in
// context, so a flag meant to keep a skill invocation-only on that skill is a contradiction
// that would silently misrepresent how the skill actually loads.
section("Skills");
for (const d of installedSkills) {
  const f = join(ROOT, "user/skills", d, "SKILL.md");
  const fm = frontmatter(readFileSync(f, "utf8"));
  if (!fm) { fail(`skills/${d}/SKILL.md has no frontmatter`); continue; }
  const unknown = Object.keys(fm).filter((k) => !SKILL_FIELDS.has(k));
  unknown.length ? fail(`skills/${d} unknown frontmatter: ${unknown.join(", ")}`)
                 : pass(`skills/${d} frontmatter valid`);
  if (!fm.name) fail(`skills/${d} missing name`);
  if (!fm.description) fail(`skills/${d} missing description`);
}
// A preloaded skill must not disable model invocation.
for (const f of agents) {
  const fm = frontmatter(readFileSync(f, "utf8")) || {};
  for (const s of fm.skills || []) {
    const sf = join(ROOT, "user/skills", s, "SKILL.md");
    if (!existsSync(sf)) continue;
    const sfm = frontmatter(readFileSync(sf, "utf8")) || {};
    String(sfm["disable-model-invocation"]) === "true"
      ? fail(`skills/${s} sets disable-model-invocation but is preloaded by ${basename(f)} — cannot be preloaded`)
      : pass(`skills/${s} is preloadable by ${basename(f)}`);
  }
}

// ── 6. Rules ─────────────────────────────────────────────────────────────────
// Defends that every rule file's frontmatter is either absent (always-loaded, by design) or
// declares only `paths:` (path-scoped). An unrecognized key here would silently fail to
// scope the rule the way its author intended, so it would load everywhere or nowhere.
section("Rules");
const ruleFiles = [
  ...walk(join(ROOT, "user/rules")),
  ...walk(join(ROOT, "project-template/rules")),
].filter((f) => f.endsWith(".md"));
if (!ruleFiles.length) fail("no rule files found");
for (const f of ruleFiles) {
  const fm = frontmatter(readFileSync(f, "utf8"));
  if (fm === null) { pass(`${rel(f)} always-loaded (no frontmatter)`); continue; }
  const unknown = Object.keys(fm).filter((k) => !RULE_FIELDS.has(k));
  unknown.length ? fail(`${rel(f)} unknown frontmatter: ${unknown.join(", ")}`)
                 : pass(`${rel(f)} path-scoped (${(fm.paths || []).length} globs)`);
}

// ── 7. Size discipline ───────────────────────────────────────────────────────
// Defends the promise that CLAUDE.md stays skimmable: it is loaded into every session's
// context on every turn, so unbounded growth is a recurring context-budget cost, not a
// one-time readability complaint.
section("Size");
for (const p of ["user/CLAUDE.md", "project-template/CLAUDE.md"]) {
  const f = join(ROOT, p);
  if (!existsSync(f)) continue;
  const n = readFileSync(f, "utf8").split(/\r?\n/).length;
  n <= CLAUDE_MD_MAX_LINES ? pass(`${p} ${n} lines (limit ${CLAUDE_MD_MAX_LINES})`)
                           : fail(`${p} ${n} lines exceeds ${CLAUDE_MD_MAX_LINES}`);
}

// ── 8. Stack-agnosticism ─────────────────────────────────────────────────────
// Defends that the shipped package (user/ and project-template/) names no specific
// framework or private project. This package installs into any repo regardless of stack;
// a leaked term (e.g. a framework name or an internal credential-like identifier) would
// both break that generality and risk exposing something that should not ship.
section("Stack-agnosticism");
let leaks = 0;
for (const f of [...walk(join(ROOT, "user")), ...walk(join(ROOT, "project-template"))]) {
  if (!/\.(md|json|mjs|js)$/.test(f)) continue;
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (LEAK_TERMS.test(line)) { fail(`${rel(f)}:${i + 1} framework-specific term`, line.trim().slice(0, 100)); leaks++; }
  });
}
if (!leaks) pass("user/ and project-template/ contain no framework-specific terms");

// ── 9. Hook wiring ───────────────────────────────────────────────────────────
// Every hook file is reachable from the template, every registered command points at a file
// that exists, and no hook is wired to an event that cannot feed it. A hook nobody calls and
// a command naming a deleted file both look fine in isolation.
section("Hook wiring");
const HOOK_DIR = join(ROOT, "user/hooks");
const hookFiles = existsSync(HOOK_DIR)
  ? readdirSync(HOOK_DIR).filter((f) => f.endsWith(".mjs"))
  : [];
let template = null;
try {
  template = JSON.parse(
    readFileSync(tpl, "utf8").split("__CLAUDE_HOME__").join("/HOME").split("__MIN_VERSION__").join("9.9.9")
  );
} catch (e) {
  fail("settings.template.json does not parse after placeholder substitution", e.message);
}

/** [event, matcher, command] for every hook the template registers. */
const registered = [];
if (template) {
  for (const [event, groups] of Object.entries(template.hooks || {})) {
    for (const g of groups || []) {
      for (const h of g.hooks || []) registered.push([event, g.matcher || "*", String(h.command || "")]);
    }
  }
}

for (const f of hookFiles) {
  const wired = registered.filter(([, , cmd]) => cmd.includes(`hooks/${f}`));
  wired.length
    ? pass(`${f} wired to ${wired.map(([e]) => e).join(", ")}`)
    : fail(`${f} exists but settings.template.json never registers it — it will never run`);
}
for (const [event, , cmd] of registered) {
  const m = cmd.match(/hooks\/([\w.-]+\.mjs)/);
  if (!m) continue;
  hookFiles.includes(m[1])
    ? pass(`${event} → ${m[1]} resolves to a file in user/hooks/`)
    : fail(`${event} registers ${m[1]}, which does not exist in user/hooks/`);
}

/**
 * `packet-check.mjs` must not regress to `SubagentStart`.
 *
 * It shipped there for a full release cycle reading `prompt_text`, a field that payload does
 * not carry, so it exited silently on every dispatch and warned no one. The event it is wired
 * to is therefore an invariant, not a preference.
 */
const packetWiring = registered.filter(([, , cmd]) => cmd.includes("packet-check.mjs"));
if (!packetWiring.length) {
  fail("packet-check.mjs is not registered at all");
} else {
  for (const [event, matcher] of packetWiring) {
    if (event === "SubagentStart") {
      fail(
        "packet-check.mjs is wired to SubagentStart, where the payload carries no prompt text",
        "it is inert there; it belongs on PreToolUse with matcher \"Agent\""
      );
    } else if (event === "PreToolUse" && /Agent/.test(matcher)) {
      pass(`packet-check.mjs on PreToolUse matcher "${matcher}" (the packet is readable there)`);
    } else {
      fail(`packet-check.mjs wired to ${event} matcher "${matcher}" — cannot see a Task Packet`);
    }
  }
}

// ── 10. Payload contracts ────────────────────────────────────────────────────
/**
 * Each hook is run against a payload **captured from a real Claude Code run**, and checked for
 * the behaviour that payload should produce.
 *
 * This is the check that would have caught the defect that motivated it. Every static test in
 * this file passed while `packet-check.mjs` read a field the runtime has never sent; only
 * feeding it a genuine payload and demanding output exposes that. Fixtures are verbatim key
 * sets from Claude Code 2.1.220 — when a fixture stops matching reality, this is meant to fail.
 */
section("Payload contracts");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");

const SANDBOX = mkdtempSync(join(tmpdir(), "verify-repo-"));
const PROJ = join(SANDBOX, "proj");
mkdirSync(join(PROJ, ".claude"), { recursive: true });
writeFileSync(join(PROJ, ".claude", "continuity.json"), JSON.stringify({ verifyCommands: ["make test"] }));

const TRANSCRIPT = join(SANDBOX, "transcript.jsonl");
writeFileSync(
  TRANSCRIPT,
  [
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "tu_1", name: "Agent", input: { subagent_type: "implementer", description: "add export" } }] } }),
    JSON.stringify({ type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "tu_1", content: "## Result\nDONE\n\n## Files\n- src/a.py" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "tu_2", name: "Edit", input: { file_path: "/repo/src/a.py" } }] } }),
  ].join("\n") + "\n"
);

/**
 * Run a hook with the given stdin. Returns { code, out }.
 *
 * @param {string} file - Hook filename relative to `HOOK_DIR` (e.g. "packet-check.mjs").
 * @param {string} stdin - Raw payload piped to the hook's stdin, typically a JSON string.
 * @param {object} [env] - Extra environment variables merged over `process.env` for this
 *   invocation.
 * @returns {{code: number, out: string}} The process exit code and its captured stdout;
 *   a thrown (non-zero) exit is caught and its stdout still returned rather than swallowed.
 *
 * The child runs with its cwd in the sandbox, never in the repository. Every hook resolves
 * its project root as CLAUDE_PROJECT_DIR, then `payload.cwd`, then `process.cwd()` — and the
 * hostile payloads below deliberately supply an empty env var and a cwd that does not exist,
 * so they land on that last fallback by design. With the child inheriting the repo as its
 * cwd, that fallback made `worker-ledger.mjs` append a real row to the repository's own
 * `.claude/worker-ledger.jsonl` on every run: agent `implementer`, session `s`, result null.
 * Enough of those and the session brief reported the report contract as broken, which is the
 * exact failure this repo exists to prevent — a check that produces misleading data about
 * the thing it is checking. Sandboxing the cwd closes the whole class, not just the one hook.
 */
function runHook(file, stdin, env = {}) {
  try {
    const out = execFileSync(process.execPath, [join(HOOK_DIR, file)], {
      input: stdin,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: SANDBOX,
      env: { ...process.env, CLAUDE_PROJECT_DIR: "", ...env },
      timeout: 20000,
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: String(e.stdout || "") };
  }
}

/**
 * A packet missing every required field, dispatched to a checked worker role. Payload keys are
 * exactly those observed on a real PreToolUse/Agent event.
 */
const preToolUsePayload = (prompt, subagent_type = "implementer") => JSON.stringify({
  session_id: "s-1", transcript_path: TRANSCRIPT, cwd: PROJ, prompt_id: "p-1",
  permission_mode: "default", hook_event_name: "PreToolUse", tool_name: "Agent",
  tool_input: { description: "d", prompt, subagent_type }, tool_use_id: "toolu_1",
});

{
  const r = runHook("packet-check.mjs", preToolUsePayload("fix the export bug"));
  r.code === 0 && r.out.includes("Task Packet check")
    ? pass("packet-check warns on a real PreToolUse payload with an incomplete packet")
    : fail("packet-check produced no warning for an incomplete packet on a real payload",
           `exit=${r.code} bytes=${r.out.length} — this is the defect that shipped once already`);
}
{
  const full = "## Intent\nx\n## Files\na.py\n## Anchors\nfoo()\n## Constraints\nnone\n## Done means\nmake test passes";
  const r = runHook("packet-check.mjs", preToolUsePayload(full));
  r.code === 0 && r.out.trim() === ""
    ? pass("packet-check stays silent on a complete packet")
    : fail("packet-check warned on a complete packet — false positive", r.out.slice(0, 160));
}
{
  const r = runHook("packet-check.mjs", preToolUsePayload("no fields here", "verifier"));
  r.code === 0 && r.out.trim() === ""
    ? pass("packet-check exempts verifier")
    : fail("packet-check warned on a verifier dispatch — its packet is a command list", r.out.slice(0, 160));
}
{
  // It must never block: PreToolUse would honour a denial, and this hook is not an
  // authorization boundary.
  const r = runHook("packet-check.mjs", preToolUsePayload("nothing"));
  /permissionDecision/.test(r.out)
    ? fail("packet-check emitted a permissionDecision — it must warn, never block", r.out.slice(0, 160))
    : pass("packet-check emits no permissionDecision (warns, never blocks)");
}
{
  // The dead-event regression, asserted behaviourally as well as structurally.
  const dead = JSON.stringify({
    session_id: "s-1", transcript_path: TRANSCRIPT, cwd: PROJ, prompt_id: "p-1",
    agent_id: "a-1", agent_type: "implementer", hook_event_name: "SubagentStart",
  });
  const r = runHook("packet-check.mjs", dead);
  r.code === 0
    ? pass("packet-check survives a SubagentStart payload (no prompt field) without erroring")
    : fail("packet-check crashed on a SubagentStart-shaped payload", `exit=${r.code}`);
}
{
  const stop = JSON.stringify({
    session_id: "s-verify", transcript_path: TRANSCRIPT, cwd: PROJ, prompt_id: "p-1",
    permission_mode: "default", hook_event_name: "Stop", stop_hook_active: false,
    last_assistant_message: "done",
  });
  const r = runHook("verify-reminder.mjs", stop);
  r.code === 0 && r.out.includes("verification")
    ? pass("verify-reminder fires on a real Stop payload after an unverified code edit")
    : fail("verify-reminder produced no reminder on a real Stop payload", `exit=${r.code} bytes=${r.out.length}`);
}
{
  // Infrastructure is code. A session that touched only Terraform must still be reminded.
  const tfTranscript = join(SANDBOX, "tf.jsonl");
  writeFileSync(tfTranscript, JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/infra/main.tf" } }] } }) + "\n");
  const r = runHook("verify-reminder.mjs", JSON.stringify({
    session_id: "s-tf", transcript_path: tfTranscript, cwd: PROJ, hook_event_name: "Stop",
  }));
  r.code === 0 && r.out.includes("verification")
    ? pass("verify-reminder treats an infrastructure edit (.tf) as code")
    : fail("verify-reminder ignored a Terraform edit — infra changes need verification too",
           `exit=${r.code} bytes=${r.out.length}`);
}
{
  // A command merely *mentioned* is not a command that ran. Substring matching silently
  // suppressed the reminder for the rest of the session on any echo or grep containing it.
  const mention = join(SANDBOX, "mention.jsonl");
  writeFileSync(mention, [
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/a.py" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t2", name: "Bash", input: { command: 'echo "remember to run make test"' } }] } }),
  ].join("\n") + "\n");
  const r = runHook("verify-reminder.mjs", JSON.stringify({
    session_id: "s-mention", transcript_path: mention, cwd: PROJ, hook_event_name: "Stop",
  }));
  r.code === 0 && r.out.includes("verification")
    ? pass("verify-reminder does not accept a merely mentioned command as verification")
    : fail("verify-reminder counted `echo \"...make test\"` as having verified", `bytes=${r.out.length}`);
}
{
  // ...and a command that genuinely ran still silences it, including behind an env prefix.
  const ran = join(SANDBOX, "ran.jsonl");
  writeFileSync(ran, [
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/a.py" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "cd /repo && CI=1 make test -j4" } }] } }),
  ].join("\n") + "\n");
  const r = runHook("verify-reminder.mjs", JSON.stringify({
    session_id: "s-ran", transcript_path: ran, cwd: PROJ, hook_event_name: "Stop",
  }));
  r.code === 0 && r.out.trim() === ""
    ? pass("verify-reminder stays silent when the declared command actually ran")
    : fail("verify-reminder nagged a session that did verify — false positive", r.out.slice(0, 160));
}
{
  const ledgerProj = join(SANDBOX, "ledger");
  mkdirSync(ledgerProj, { recursive: true });
  const stop = JSON.stringify({
    session_id: "s-2", transcript_path: TRANSCRIPT, cwd: ledgerProj, agent_id: "a-1",
    agent_type: "implementer", hook_event_name: "SubagentStop", stop_hook_active: false,
    last_assistant_message: "## Result\nDONE\n\n## Files\n- a.py",
  });
  const r = runHook("worker-ledger.mjs", stop);
  let row = null;
  try { row = JSON.parse(readFileSync(join(ledgerProj, ".claude", "worker-ledger.jsonl"), "utf8").trim()); } catch {}
  r.code === 0 && row && row.result === "DONE" && row.agent === "implementer"
    ? pass("worker-ledger records result DONE from last_assistant_message")
    : fail("worker-ledger did not record a parseable row from a real SubagentStop payload",
           `exit=${r.code} row=${JSON.stringify(row)}`);
}
{
  // Fields confirmed present on a real PreCompact firing: the snapshot on disk named its
  // trigger, read the transcript, and was keyed by project and session.
  const pre = JSON.stringify({
    session_id: "s-3", transcript_path: TRANSCRIPT, cwd: PROJ, hook_event_name: "PreCompact",
    trigger: "manual", custom_instructions: "",
  });
  const r = runHook("compact-state.mjs", pre);
  const { createHash } = await import("node:crypto");
  const key = createHash("sha256").update(PROJ).digest("hex").slice(0, 12);
  const snap = join(tmpdir(), `claude-orchestration-${key}-s-3.md`);
  const body = existsSync(snap) ? readFileSync(snap, "utf8") : "";
  r.code === 0 && body.includes("implementer") && body.includes("/repo/src/a.py")
    ? pass("compact-state snapshots dispatched workers and written files from a real transcript")
    : fail("compact-state wrote no usable snapshot", `exit=${r.code} bytes=${body.length}`);
  try { rmSync(snap, { force: true }); } catch {}
}
{
  // Fields confirmed present on a real PreToolUse/Read firing. The guard reads only
  // `tool_input.file_path`, `offset`, and `limit` — it never opens the file, because reading
  // it to warn about the cost of reading it would spend exactly what it exists to save.
  const readPayload = (tool_input) => JSON.stringify({
    session_id: "s-br", transcript_path: TRANSCRIPT, cwd: PROJ, permission_mode: "default",
    hook_event_name: "PreToolUse", tool_name: "Read", tool_input, tool_use_id: "toolu_1",
  });

  const bigText = join(SANDBOX, "big.txt");
  writeFileSync(bigText, "x".repeat(60000));
  const r = runHook("big-read-guard.mjs", readPayload({ file_path: bigText }));
  r.code === 0 && r.out.includes("15,000") && !/permissionDecision|updatedInput/.test(r.out)
    ? pass("big-read-guard warns on a large unbounded Read, quoting a token estimate, and never blocks")
    : fail("big-read-guard did not warn usably on a large unbounded Read",
           `exit=${r.code} out=${r.out.slice(0, 200)}`);

  const bounded = runHook("big-read-guard.mjs", readPayload({ file_path: bigText, offset: 10, limit: 50 }));
  bounded.code === 0 && bounded.out.trim() === ""
    ? pass("big-read-guard stays silent on a bounded Read")
    : fail("big-read-guard warned on a bounded Read — false positive", bounded.out.slice(0, 200));

  // An image is tokenized by pixel dimensions, so a bytes/4 figure would be a fabricated
  // number. The guard must warn without quoting one.
  const img = join(SANDBOX, "big.png");
  writeFileSync(img, "x".repeat(60000));
  const ri = runHook("big-read-guard.mjs", readPayload({ file_path: img }));
  ri.code === 0 && /pixel dimensions/.test(ri.out) && !ri.out.includes("15,000")
    ? pass("big-read-guard warns on a large image without quoting a byte-derived token estimate")
    : fail("big-read-guard quoted a bytes/4 estimate for an image, or failed to warn it at all",
           ri.out.slice(0, 200));
}
{
  // Fields confirmed present on a real Stop firing. Context size for a turn is
  // input_tokens + cache_creation_input_tokens + cache_read_input_tokens.
  const usageLine = (cacheRead) => JSON.stringify({
    type: "assistant", timestamp: "2026-01-01T00:00:00.000Z",
    message: { usage: {
      input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: cacheRead,
    } },
  });
  const stopPayload = (session_id, transcript_path) => JSON.stringify({
    session_id, transcript_path, cwd: PROJ, hook_event_name: "Stop",
    stop_hook_active: false, last_assistant_message: "done",
  });
  const { createHash: hash } = await import("node:crypto");
  const ctxKey = hash("sha256").update(PROJ).digest("hex").slice(0, 12);
  const marker = (id) => join(tmpdir(), `claude-context-cost-${ctxKey}-${id}.json`);

  const over = join(SANDBOX, "ctx-over.jsonl");
  writeFileSync(over, usageLine(250000) + "\n");
  const r = runHook("context-cost.mjs", stopPayload("s-ctx-1", over));
  r.code === 0 && r.out.includes("251,010") && !/"decision"/.test(r.out)
    ? pass("context-cost warns on a real Stop payload once context crosses the threshold, and never blocks")
    : fail("context-cost did not warn on an over-threshold transcript",
           `exit=${r.code} out=${r.out.slice(0, 200)}`);

  const under = join(SANDBOX, "ctx-under.jsonl");
  writeFileSync(under, usageLine(4000) + "\n");
  const ru = runHook("context-cost.mjs", stopPayload("s-ctx-2", under));
  ru.code === 0 && ru.out.trim() === ""
    ? pass("context-cost stays silent below the threshold")
    : fail("context-cost warned below the threshold — false positive", ru.out.slice(0, 200));

  // Regression pin: the hook must read the CURRENT context, not the session's high-water
  // mark. Tracking the peak meant a session that crossed a threshold and then compacted kept
  // being warned about a cost it had already paid down, and the message called a stale peak
  // "now" — a false positive that teaches the reader to ignore the hook.
  const compacted = join(SANDBOX, "ctx-compacted.jsonl");
  writeFileSync(compacted, usageLine(250000) + "\n" + usageLine(3000) + "\n");
  const rc = runHook("context-cost.mjs", stopPayload("s-ctx-3", compacted));
  rc.code === 0 && rc.out.trim() === ""
    ? pass("context-cost reports current context, not peak — a compacted session is not warned")
    : fail("context-cost warned a session that had already compacted below the threshold",
           rc.out.slice(0, 200));

  for (const id of ["s-ctx-1", "s-ctx-2", "s-ctx-3"]) {
    try { rmSync(marker(id), { force: true }); } catch {}
  }
}

// ── 11. Fail-open behaviour ──────────────────────────────────────────────────
/**
 * Every hook here sits on an observability surface, so a crash costs the user a broken
 * session for no benefit. Each is run four ways and must exit 0 every time.
 */
section("Fail-open behaviour");
const HOSTILE = [
  ["realistic", JSON.stringify({ session_id: "s", transcript_path: TRANSCRIPT, cwd: PROJ, trigger: "manual",
    tool_name: "Agent", tool_input: { prompt: "x", subagent_type: "implementer" },
    agent_type: "implementer", last_assistant_message: "## Result\nDONE" })],
  ["malformed JSON", '{"session_id": "abc'],
  ["empty stdin", ""],
  ["missing files", JSON.stringify({ session_id: "s", transcript_path: join(SANDBOX, "nope.jsonl"),
    cwd: join(SANDBOX, "does-not-exist"), tool_name: "Agent", tool_input: {}, agent_type: "implementer" })],
];
for (const f of hookFiles) {
  const bad = HOSTILE.filter(([, stdin]) => runHook(f, stdin).code !== 0).map(([label]) => label);
  bad.length
    ? fail(`${f} exits non-zero on: ${bad.join(", ")}`, "an observability hook must never break a session")
    : pass(`${f} exits 0 on all four input shapes`);
}
try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} invariants hold` +
  (failures ? `, ${failures} failure(s)\n` : "\n")
);
process.exit(failures === 0 ? 0 : 1);
