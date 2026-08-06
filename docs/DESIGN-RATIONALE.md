# Design rationale

This document explains why the package is built the way it is: the bugs the current design
fixes, the choices layered on top of those fixes, and the constraints that shape both. Every
claim below was checked against the current Claude Code documentation
(`code.claude.com/docs`) on 29 July 2026, not against recalled behavior. Version floors are
noted where a feature is recent enough to matter.

---

## 1. Three configuration traps this package avoids

Each of these looks deliberate in a config file and is not. They are called out first
because every one of them fails silently.

### 1.1 `effort` on a Haiku-tier worker is a silent no-op

Pairing `model: haiku` with `effort: xhigh` reads as a considered choice. Effort levels are
supported only on the models below; **models not listed do not support effort at all**:

| Model | Levels |
| --- | --- |
| Fable 5 | low, medium, high, xhigh, max |
| Opus 5, Sonnet 5, Opus 4.8, Opus 4.7 | low, medium, high, xhigh, max |
| Opus 4.6, Sonnet 4.6 | low, medium, high, max |

Haiku appears nowhere on that list. Such a setting is silently ignored, which is worse than
omitting it: the config asserts a guarantee the runtime never provides, and any doc that
describes "xhigh on all tiers" is then describing something that does not happen.

**Fix:** `fast-implementer` and `verifier` carry no `effort` field, with a comment in each
file explaining why. Work that genuinely needs deeper reasoning routes to `implementer`
(Sonnet, which does support `xhigh`).

### 1.2 Hardcoded absolute paths break portability

A `settings.json` that points hooks and the statusline at `/Users/<name>/.claude/hooks/...`
works on exactly one machine. On Linux, Windows, or a server that path does not exist and
the hooks fail. This is the single biggest obstacle to "the same workflow everywhere."

**Fix:** the repo ships `settings.template.json` with a `__CLAUDE_HOME__` placeholder that
`bootstrap.mjs` resolves at install time on each machine. Hook paths are machine-specific by
nature, so they are generated rather than committed.

### 1.3 Prose that names a model version goes stale

Documentation that calls the orchestrator "Opus 4.8" is wrong as of Claude Code v2.1.219,
where the `opus` alias resolves to **Opus 5** on the Anthropic API; it resolved to Opus 4.8
from v2.1.154. A config using `"model": "opus"` stays correct throughout — only the prose
rots, which is exactly the drift that eventually causes someone to "fix" the working config
to match a stale doc.

**Fix:** roles are described by alias only. Version numbers appear in exactly one place —
this document — and never in a config file. The alias is the capability tier, and there is
exactly one resolution point for it.

---

## 2. What is new, beyond fixing bugs

### A contract that actually reaches the workers

Subagents receive the full `CLAUDE.md` hierarchy, so project standards do reach them. They
do **not** receive the parent session's conversation, its auto memory, or its output style.
The report format and escalation shape therefore live in a **skill preloaded via each
agent's `skills` field**, which injects the full skill content into the subagent at startup.
That is a guarantee, unlike hoping a rules file propagates.

(A skill can only be preloaded if it does not set `disable-model-invocation: true`, so
`worker-contract` uses `user-invocable: false` instead.)

### Reports name files, not diffs

A worker report names the files it touched and describes each change in one line; it does
not paste diffs. The reason to use a subagent at all is that its verbose output stays in its
own context — pasting diffs back into the report spends exactly the context that delegating
was meant to buy. The orchestrator runs `git diff` itself when it wants detail.

### Subagents are registered as files, not as a settings array

There is no `agents` key in `settings.json`. Subagents are registered by their presence as
markdown files in `~/.claude/agents/` or `.claude/agents/` — an `agents: [...]` block in
settings is not part of the schema. This matters beyond being a schema nitpick: user,
project, and local settings files are validated strictly, and **a file that fails
validation is rejected as a whole**. A settings file carrying an invalid `agents` array
would not add agent registration; it would silently disable the model choice, effort level,
plugins, and statusline it shares the file with. (There is an `agent` key, singular — it
runs the main thread as a named subagent, which is a different feature entirely.)

### `reviewer` and `verifier` are genuinely different roles

The **reviewer** measures a diff against cited standards and produces findings with
`file:line` evidence; the **verifier** executes binary predicates and reports pass/fail with
no interpretation. The reviewer's findings template includes a mandatory **Verified clean**
section, because a review's silence otherwise carries no information about what was actually
checked.

### One writer per file, ever

Concurrent writers to a single file lose edits — there is no merge step that reconciles two
workers editing the same file. The rule is not a concurrency cap (say, "at most three
workers on one file"); it is that a file has exactly one writer at a time. Fan out only
across disjoint file sets, or give a worker `isolation: worktree` so it gets its own
checkout.

### Workers cannot fan out

By default a subagent can spawn subagents up to three layers deep (v2.1.219+). Uncontrolled,
that turns a delegation into a tree that cannot be audited. Two independent controls prevent
it: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` in settings, and no worker lists the `Agent`
tool. Concurrency is capped at 6 (the default is 20).

### Fail-closed, applied correctly

The governing principle is that ambiguity at a decision boundary surfaces to the safe
branch. Applied precisely, that means **authorization** boundaries fail closed — permission,
validation, and security paths take the rejecting branch under ambiguity.
**Observability** boundaries are the opposite: a hook that logs must never break a session.
Both hooks therefore exit 0 on every failure path, and say so in their header comments. Same
principle, opposite defaults, and the distinction is deliberate.

---

## 3. Session memory, in three layers

Project-level memory exists so a new session picks up aligned with past changes. One
constraint shapes the whole design: **auto memory is machine-local and does not sync.** It
lives in `~/.claude/projects/<project>/memory/` and never travels to another machine. So
anything a different machine must know has to be a committed file.

| Layer | Where | Travels between machines | Written by |
| --- | --- | --- | --- |
| **Standing decisions** | a root `DECISIONS.md` (or `docs/adr/`) | Yes — committed | The team and Claude, deliberately |
| **Session history** | `docs/changelogs/YYYY-MM-DD-*.md` | Yes — committed | Required at session end |
| **Agent knowledge** | `.claude/agent-memory/<agent>/` | Yes — commit this directory | `implementer` and `reviewer`, via `memory: project` |
| **Worker ledger** | `.claude/worker-ledger.jsonl` | No — gitignored | `SubagentStop` hook |
| **Auto memory** | `~/.claude/projects/<project>/memory/` | **No** | Claude, automatically |

This repository is itself the distributable package, not a codebase a team works in, so it
gitignores its own `.claude/agent-memory/` as a documented exception to the row above —
onboarded projects keep the directory tracked, per `orchestration-onboard/SKILL.md` step 5.
The worker-ledger row needs no such exception: it is machine-local, gitignored history for
every repository, including this one, so this package's own behavior already matches the
table without deviation.

The `session-brief` hook closes the loop: at every `SessionStart` it reads the decision log,
the three most recent changelogs, and the tail of the worker ledger, and injects them as
context. A session on a server opens with the same history as a session on a laptop.
`MEMORY.md`-style truncation applies to nothing here, but the brief self-caps at 8,000
characters so it cannot crowd out the session.

---

## 4. Generalizing the project layer

The first version of this package shipped a project layer written directly for one
Django/Celery/SES codebase. That made it a template only for that stack. The layer is now
split in three:

- **`project-template/`** — stack-agnostic. `CLAUDE.md` is a fill-in template whose comments
  say what belongs in each section and what does not. The three rules use path globs that
  cover the common source layouts across ecosystems, each headed by a note to adjust them.
- **`examples/django-celery-ses-banking/`** — the previous, fully filled-in version, kept as
  a worked reference. Filling a template is much easier next to a completed one.
- **`/orchestration-onboard`** — a user-level skill that reads a repository, asks only for
  what the code cannot reveal, proposes a plan, and writes nothing until approved.

The hooks were also assuming a convention. `session-brief.mjs` originally hardcoded
`docs/changelogs/` and a fixed root-level `DECISIONS.md` path. It now resolves, in order: an
explicit `.claude/continuity.json`, then a list of common layouts including `docs/adr/`, a
root `DECISIONS.md`, and `changelogs/`. An ADR directory is summarized as a list of record
titles rather than inlined. Files without a leading date sort by modification time. A
repository with none of these produces no brief and no error.

One rule was deliberately softened rather than generalized. "Never hard-delete" was a
correct policy for the banking codebase but is not universal, so the template says: check
how this project deletes before adding a delete path, and match it. A rule that is present
but untrue in a given repository teaches Claude to discount the whole file.

---

## 5. Restructuring the project CLAUDE.md

The original was 176 dense lines. Two changes:

**Path-scoped rules.** Security, migration, and async standards moved into
`.claude/rules/*.md` with `paths:` frontmatter, so they load only when Claude touches
matching files. Every session previously paid the full context cost of the migration rules
even when editing a serializer.

**Trimmed derivable content.** The docs are explicit that `/doctor`'s trim check removes
what Claude can derive from the codebase — directory layouts, dependency lists, architecture
overviews — and keeps pitfalls, rationale, and conventions that differ from tool defaults.
The app-by-app breakdown was largely derivable; the scale profile is not, and is exactly the
judgment context Claude cannot reconstruct from the code. So the scale profile stayed nearly
intact and the structural tour was compressed to a paragraph.

Result: 113 lines, with the standards intact and loading when they are relevant.

---

## 6. Verification performed on this package

This section records the verification performed when the package was first assembled. The
hardening round in §8 was verified separately; see §8.6.

- All `.mjs` files pass `node --check`, invoked once per file. `node --check` takes a single
  file and silently ignores every argument after the first, so a single invocation listing
  several files reports success even when the later ones are broken.
- `bootstrap.mjs` was run against a temp home seeded with a representative `settings.json`;
  the merge preserved `enabledPlugins`, `extraKnownMarketplaces`, `statusLine`, and existing
  hook entries while adding the new keys and hook entries. Output re-parsed as valid JSON.
- Idempotency confirmed (second run: 0 written, 10 unchanged); local-modification
  protection and `--force` override both confirmed.
- Every agent and skill frontmatter parsed as YAML and checked field-by-field against the
  documented schema: no unknown fields, valid model aliases, valid effort values, `effort`
  present only on effort-capable models, no worker holding the `Agent` tool, and every
  preloaded skill resolving to a real file.
- The hooks were exercised against a realistic repo layout, and against malformed JSON,
  empty stdin, and a bare directory with no continuity files — all exit 0 without output.
- Continuity discovery was tested against four repository shapes: a `docs/adr/` directory,
  a root `DECISIONS.md` with undated changelog filenames, an explicit
  `.claude/continuity.json` pointing at non-standard paths, and a repository with no
  continuity files at all.

## 7. Version floors

The floor is **not stated here**. It lives in `user/version-floor.json`, and this section
describes only why that file exists. A number repeated in prose is a number that goes stale
in prose; §1.3 makes that argument for model versions, and it applies with more force to a
floor that three separate mechanisms have to agree on.

Everything that needs the floor reads it from that one file: `bootstrap.mjs` substitutes it
into `settings.template.json` as `minimumVersion` (via `__MIN_VERSION__`, the same mechanism
as `__CLAUDE_HOME__`), `session-brief.mjs` warns against it at session start, and
`bootstrap.mjs doctor` checks the running version against it.

On Amazon Bedrock or Vertex the `opus` and `sonnet` aliases resolve to older versions than
on the Anthropic API — pin `ANTHROPIC_DEFAULT_OPUS_MODEL` and `ANTHROPIC_DEFAULT_SONNET_MODEL`
in that machine's settings `env` when deploying there.

## 8. Hardening round: the floor was unenforced, and the ledger was empty

Two things this package shipped were defects rather than missing features. Both had the same
shape: a mechanism that appeared to work, produced no error, and delivered nothing.

### 8.1 The version floor was documented but never enforced (defect)

§7 previously stated the floors in prose and told the operator to run `claude --version`
before installing. Nothing checked. On an install below the floor, three things failed
silently and simultaneously:

- `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` is ignored before v2.1.217, so workers could spawn
  workers up to **five layers deep** — while `user/CLAUDE.md` stated as fact that they
  could not.
- `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` is ignored before v2.1.217, so the cap of 6 was
  really 20.
- `model: opus` resolved to Opus 4.8 before v2.1.219, so the orchestrator ran a generation
  behind the design that assumes it out-reasons its workers.

No error, no symptom, no way to notice. The claim that this setup behaves identically on
every machine was false wherever the floor was not met.

A detail found while verifying this, which inverts the usual argument for the spawn-depth
pin: the **default changed**. On v2.1.172–2.1.216 nesting was allowed up to five layers and
could not be configured; v2.1.217–2.1.218 defaulted to 1; **v2.1.219 raised the default to
3**. So `=1` is not belt-and-braces over a safe default — on any current install it is the
only thing preventing three layers of nesting.

**What was added.** `minimumVersion` in user settings, which is real but narrower than it
sounds: per the Claude Code documentation it makes auto-updates and `claude update` refuse
to install *below* the floor. It does not stop an already-old install from running, so it
alone does not close the gap. The actual guard is a check in the existing `SessionStart`
hook, which names which features are inactive rather than only printing a number. It warns
and never blocks: this is an observability surface, and a session that cannot start because
its diagnostics failed is a worse outcome than a session that runs with a visible warning.

`requiredMinimumVersion` — the managed setting that *does* refuse to start — is documented
in `INSTALL.md` and deliberately not installed. It requires root, applies to every user on
the machine, and is a policy decision rather than an install step.

**Cost.** The hook derives the version from `CLAUDE_CODE_EXECPATH` and never spawns a
process. `claude --version` was measured at 0.26–1.51s, which is not acceptable on a
session-start path; `doctor` pays that cost instead, because the operator ran it on purpose.
When the version cannot be determined the hook stays silent rather than guessing.

### 8.2 The worker ledger recorded nothing (defect)

`worker-ledger.mjs` read `payload.last_message`. The documented `SubagentStop` field is
`last_assistant_message`. That key never existed, so `extractResult` returned `null` on
every worker that ever completed, and every row the ledger had ever written carried
`"result": null`. The file grew, the session brief echoed it back, and it contained no
information at all.

This is the failure mode the package is otherwise built to prevent: a mechanism that reports
success while delivering nothing. It survived because nothing read the ledger for meaning —
the raw tail looked plausible with `unknown` in place of a result.

The fix is the correct key. The safeguard is that the rollup replacing the raw tail now
reports its own silence: if every row in the window carries no result, the brief says so and
points at `doctor`, rather than rendering an empty tally as if it were a clean run.

The rollup supports exactly one inference — *this role keeps returning BLOCKED* — and the
code says so. It does not know why, and the ledger is too sparse to support more.

### 8.3 `status` claimed more than it verified

`status` compared file hashes and printed "In sync with this repo," which reads as "this
machine works." It verified nothing about whether the install functions. `status` is
unchanged but now says what it does not cover; `doctor` answers the real question across
seven checks and exits non-zero so it can be used in a script.

The check that hook paths resolve deliberately **fails** when `settings.json` cannot be
read, rather than passing with nothing to inspect. A check with no data is unknown, and
unknown is not a pass. It covers `statusLine` alongside `hooks`, because an absolute script
path written on a laptop is the most common way a config breaks on a server, and whether
this package wrote that path is irrelevant to whether it resolves.

The drift check separates two things `status` conflated. A file that differs because the
repo moved ahead is **stale** and fails. A file the operator deliberately edited is a
**choice** — `install` already refuses to clobber it — and is reported as kept rather than
failed. The manifest tells them apart: it records what was last written, so an installed
file that no longer matches the manifest was edited locally. Reporting a deliberate local
edit as a failure would only teach the reader to ignore the command, which costs more than
the check is worth.

### 8.3.1 The merge is additive, which makes removing a setting a separate problem

Dropping `fallbackModel` from `settings.template.json` removes it for a fresh install and
leaves it in place on every machine that already has it. The merge adds and overrides; it
never deletes. So a decision to retire a setting does not reach any existing machine —
precisely the silent divergence between machines this package exists to prevent, reappearing
in the installer itself.

Retired keys are now named in a `DEPRECATED_KEYS` list in `bootstrap.mjs`, with the reason
attached. Removal is printed on install and the previous `settings.json` is backed up first.
A key belongs on that list only when its removal is a deliberate decision — never to tidy
someone's settings.

**Known limitation.** A file the operator has locally extended can never receive package
updates: `install` skips it, and `--force` would discard the local content. There is no
merge path for "keep my addition, take the new upstream text." Extending an installed
`CLAUDE.md` with an `@import` line is enough to trigger this. The workaround is to make the
edit in a file the package does not own and import it, rather than editing the installed
file in place.

### 8.4 Settings judged, including one kept against the proposal

- **`fallbackModel` removed.** When Opus was overloaded it silently moved the orchestrator
  to a worker tier. The whole design rests on the orchestrator out-reasoning its workers, so
  an invisible demotion is worse than a visible failure. The chain also covers compaction,
  which means a downgraded summarizer too.
- **`autoUpdatesChannel: "stable"` added.** A setup whose value is behaving identically
  everywhere should not take every release including regressions. `minimumVersion` is what
  stops the switch from downgrading a machine already ahead of stable.
- **`alwaysThinkingEnabled` kept**, against the proposal to remove it as redundant beside
  `effortLevel: xhigh`. The documentation is explicit that on adaptive-reasoning models the
  effort level controls *how much* thinking happens while this setting controls *whether* it
  is on. Different controls; not redundant.
- **`includeGitInstructions` left at its default.** Disabling it removes the git status
  snapshot as well as the commit/PR instructions, and the orchestrator's integration
  checklist opens with "read the actual diff." Removing the input to your own gate to save a
  few hundred tokens is a bad trade.
- **A user-level `ask` baseline for destructive commands added**, kept to four rules.
  Permission rules merge across every scope and project, so this list stays short. It is a
  net over broad project-level `allow` rules — an `ask` rule prompts even when a more
  specific `allow` matches — not a security boundary. Its coverage is literal: `rm -rf` and
  `rm -fr` are matched, `rm -r -f` is not.

### 8.5 Two mechanisms whose limits are the point

**Task Packet check (`packet-check.mjs`).** The packet's fields are mechanically checkable at
dispatch. It is scoped to `implementer`, `fast-implementer`, and `reviewer`; `verifier` is
exempt because its packet is a command list. It says in its own text that it is a warning, not
a gate, so a legitimately trivial delegation is not punished for brevity.

> **Superseded — see §10.1.** This section originally claimed the check ran on `SubagentStart`
> and read `prompt_text` from that event. No Claude Code release has ever sent that field, so
> the hook was inert from the day it shipped: it warned on nothing, ever. It now runs on
> `PreToolUse`. The paragraph is kept rather than rewritten because the reasoning it records —
> that a warning aimed at the subagent converts "invent a design" into "return BLOCKED" — was
> sound, and losing it would hide why the replacement is a genuine trade rather than an upgrade.

**Compaction snapshot (`compact-state.mjs`).** `PreCompact` receives `transcript_path`, so a
hook can capture real state rather than a stub. It records what is deterministic: every
worker dispatched with the outcome it reported, and every file written. It explicitly cannot
capture what was reconciled, accepted, rejected, or decided — that is orchestrator reasoning
and no hook recovers it from a transcript. The snapshot says this in its own text so a
post-compaction session does not mistake it for a full handoff.

It writes to the OS temp directory rather than the repository: nothing to `.gitignore`, no
cleanup discipline, and no session residue committed by accident.

### 8.6 Verification performed on this round

- `node --check` passes on `bootstrap.mjs` and all four hooks, invoked once per file.
- Every tracked `.json` parses, including `settings.template.json` after both
  `__CLAUDE_HOME__` and `__MIN_VERSION__` substitution.
- All 13 markdown files with frontmatter were checked field-by-field against the documented
  schemas: no unknown fields, and no `effort` on an effort-incapable model. The first run of
  this check reported nine failures that were false — `paths`, `argument-hint`, and
  `user-invocable` are all documented fields the checker's allowlist was missing. The
  checker was corrected against the documentation rather than the files.
- `grep -riE "django|celery|IBBL|banking" user/ project-template/` returns nothing.
- Each hook was exercised against real input, malformed JSON, empty stdin, and a repository
  missing the files it looks for. Every path exits 0. `compact-state.mjs` was run against a
  **real session transcript** — not a synthetic one — and produced a snapshot naming three
  dispatched workers with their reported outcomes and three files written. The
  `PreCompact` → `SessionStart` handoff was exercised end to end, and a snapshot older than
  the cutoff was confirmed to be ignored.
- The transcript shapes the parser depends on (`Agent` tool_use carrying
  `input.subagent_type` and `input.description`; `tool_result` carrying `tool_use_id` and a
  string `content`; `Edit`/`Write` carrying `input.file_path`) were read out of a real
  transcript rather than assumed.
- The ledger fix was confirmed by payload: a `SubagentStop` payload carrying
  `last_assistant_message` now records `"result":"DONE"` and `"result":"BLOCKED"` with the
  blocker note, where the previous key produced `null` every time.
- `bootstrap.mjs install --home=/tmp/probe` then `status` then `doctor`: 14 files written,
  all in sync, 7 of 7 checks pass, exit 0.
- `doctor` was then run against a **deliberately broken** copy: a deleted file, a tampered
  file, a hook path that does not resolve, `effort: xhigh` added to a `model: haiku` agent,
  and an agent naming a skill that is not installed. It detected all five and exited 1. With
  an unparsable `settings.json` it reports 6 of 7 failed and exits 1.
- Startup cost was **measured**, not estimated: the old and new `session-brief.mjs` were run
  against the same payload in the same repository, interleaved, twelve iterations each,
  median of medians. The version check and handoff lookup add **+1.2 ms** on top of a hook
  whose total is ~27 ms, nearly all of which is the Node process spawn that was already
  being paid. The other two hooks do not run at session start: `packet-check.mjs` fires per
  dispatch and `compact-state.mjs` only when compaction runs.
- `doctor`'s drift classification was exercised in all three directions: a file the repo
  moved ahead of fails, a missing file fails, and a locally edited file passes and is
  reported as kept.
- Deprecated-key removal was exercised against a seeded `settings.json`: `fallbackModel` was
  removed while `statusLine`, `enabledPlugins`, and an unrelated `PreToolUse` hook entry
  were all preserved, and a second run reported the settings already current.
- The compaction snapshot's project isolation was exercised with two project roots sharing
  one temp directory: the writing project read its own snapshot back, the other read
  nothing. The file is written mode `0600`.
- The `ask` permission rules were **exercised against a live Claude Code process**, not
  inferred from documentation. A control run (allow rule, user scope excluded) deleted its
  target, proving the harness worked; the identical run with user scope included was
  blocked with "Permission needed to run rm command", proving the installed
  `Bash(rm -rf *)` rule both matches and overrides an explicit `allow` for the same
  pattern. A third isolated run confirmed `rm -r -f` is **not** matched, so the documented
  coverage limit is real. Three earlier attempts at this test produced confident-looking
  results that were all invalid — `claude` absent from `PATH`, `timeout` absent on macOS,
  and a target outside the session's working directory being blocked by the directory
  boundary rather than by any permission rule. The control is the only reason those were
  caught rather than reported.
- Whether a session keeps its id across compaction was settled from **three real compacted
  transcripts**: each carries a single session id, unchanged either side of the compaction
  marker. This retired the handoff's mtime fallback rather than justifying it (§8.7).

### 8.7 Independent review, and what it caught

The first `reviewer` dispatch on this diff terminated on a session limit without returning
findings. A second pass completed and is the source of everything below. It is worth
recording that the review found a defect the author's own re-reading had missed, and that
the defect was introduced *by* an earlier fix in this same round.

**Critical — `doctor` reported a corrupted install as healthy.** §8.3 describes splitting
drift into "stale" and "locally modified", so a deliberate edit would stop being reported as
a failure. That split created a hole: a truncated or half-written file also has a hash that
matches neither the repo nor the manifest, so it landed in "locally modified and kept" and
passed. Reproduced by truncating the installed `session-brief.mjs` to 400 bytes — `node
--check` rejects it, and `doctor` still reported 7 of 7 passing and exited 0. A SessionStart
hook that cannot be parsed was being called healthy by the command whose stated purpose is
to check that the install works.

The hole is that a hash distinguishes *different* from *expected*, and nothing more. Telling
a deliberate edit from corruption needs a check that knows what the file is *for*. `doctor`
now runs `node --check` on every installed hook script — the same check this repo's own
`CLAUDE.md` already prescribes for a human touching those files. That is check eight.

The lesson generalizes past this bug: **a fix that makes a check quieter should be suspected
of making it blinder.** The "locally modified and kept" classification was correct and worth
keeping; it just needed a second check to cover what it deliberately stopped reporting.

**Also fixed from that review:**

- `compact-state.mjs` matched `DONE|PARTIAL|BLOCKED|PASS|FAIL` unanchored, taking the first
  such word anywhere in a worker's report. A report reading "the tests PASS locally, but
  then I hit an ambiguity" above a `## Result` of `BLOCKED` recorded `PASS` — the wrong
  outcome, in the artifact whose whole job is to survive a session that ended badly. It now
  uses the anchored `## Result` pattern `worker-ledger.mjs` already used.
- `readTranscript()` read the entire file before slicing to the 4 MB tail, so the cap
  bounded nothing. It now reads only the tail bytes through a file descriptor.
- `frontmatter()` mis-parsed two legal YAML shapes — an inline flow sequence
  (`skills: [a, b]`) and a comment-only value (`skills:   # note`) — each producing a false
  FAIL for an agent whose skills are installed correctly. Both now parse. The reviewer also
  confirmed that `description: >` block scalars do *not* break `skills:` termination, which
  had been the author's main worry and was unfounded.
- `mergeSettings` had two byte-identical array branches, and its docstring claimed
  non-`hooks` arrays were "replaced only when the target does not already define them",
  which the code never did. Every array is concatenated and de-duplicated. The dead branch
  is gone and the docstring now describes the real behavior, which is also the right
  behavior: a user's own `permissions.ask` entry survives alongside this package's
  baseline.
- The installer's top-of-file comment still said "existing keys are preserved" after
  `DEPRECATED_KEYS` began removing retired keys unconditionally. It now states the
  exception and how to opt out of it (remove the key from that list, not from
  `settings.json`, which would only be deleted again next install).
- The snapshot's `0600` mode was only applied on creation, so a second `PreCompact` in one
  session could inherit a looser mode. It is now chmod'd after every write.
- `EFFORT_CAPABLE` treated a bare `opus` / `sonnet` alias as effort-capable unconditionally,
  though §7 documents that those resolve to older generations on Bedrock and Vertex — some
  of which do not support `effort` at all. When one of those providers is configured, the
  check now reports the alias as not decidable here rather than claiming a pass.

**One finding fixed by deletion rather than by patching.** The reviewer showed that two
concurrent sessions in one project could read each other's pre-compaction snapshot through
the 15-minute "recent handoff" fallback. That fallback existed only to cover a compaction
handing the session a new id — and the transcript evidence in §8.6 shows that does not
happen. The fallback guarded against nothing and leaked across sessions, so it was removed
rather than fenced. The lookup is now an exact match on project *and* session.

Removing it also removed the reason for the speculative `CLAUDE_CODE_VERSION` branch in
`claudeVersion()`: that variable is set by no Claude Code runtime observed here, and a
fallback that never fires reads as verified behavior to the next maintainer.

**Reviewer output is input, not verdict.** Every finding above was reproduced against the
working tree before being accepted. The review also wrote agent-memory files into
`.claude/agent-memory/reviewer/`, which this repository's `CLAUDE.md` explicitly forbids —
those were removed. A worker's report is not exempt from the project's own rules.

## 9. Task shape, test quality, and a reminder that is not a gate

This round evaluated six proposals about how agent-written code actually gets run. Three
were adopted as proposed, three modified, and three rejected. The rejections matter as much
as the adoptions: two of them were rejected specifically because a mechanism for the same
job already exists, and a second mechanism for one job makes a system worse.

### 9.1 Non-goals: `Constraints` was never doing this work

`Constraints` is defined in both the packet and the contract as *invariants* — "what must
not change; which project rules bind this slice." Scope is a different question, and it was
handled only by negative prose inside the worker ("do not expand scope", "stay inside your
read-write set"). That leaves a real gap: the read-write set cannot stop creep *within* a
file it grants. A worker told to fix a bug in `export.py` can refactor the function next to
it without ever leaving its scope.

`Non-goals` is therefore a packet field, not another worker instruction — the orchestrator
is the one who saw the adjacent work and decided not to do it, so it is the one who has to
say so.

**It is the only optional field, and it is deliberately absent from `packet-check.mjs`.** A
sixth required field would make that hook warn on nearly every legitimate dispatch, and a
warning that always fires is one you stop reading. §8.5 made this argument for gates; it
applies to warnings with equal force. The contract states explicitly that a missing
`Non-goals` is never grounds for `BLOCKED`.

`Done means` gained "what their output must show" for a related reason: a command is not a
criterion. "Run `make test`" is satisfied by running it; "run `make test`, and the three new
cases in `test_export.py` pass" is not.

### 9.2 Verification: the signal problem, solved by not guessing

"Verify before claiming" is the assumption everything else rests on, and it was pure prose.
The obvious mechanisation — a `Stop` hook that checks whether verification ran — founders on
one question: *which command counts as verification here?* Every heuristic answer (match
`test`, match `lint`, match a shell fragment) produces false negatives on the projects that
verify in unusual ways, and a gate that blocks a session which **did** verify gets switched
off within a week. Switching it off also removes the reminder, so a false-positive-prone
gate is strictly worse than no gate at all.

So the hook does not guess. Projects declare their commands in `.claude/continuity.json`,
the file `session-brief.mjs` already reads:

```json
{ "verifyCommands": ["make test", "make lint"] }
```

**Without that key the hook exits silently and is completely inert.** That makes the
false-positive rate zero by construction rather than by tuning, and makes the mechanism
opt-in per project — a repository that never adds the key keeps exactly today's behavior.

It reminds; it never blocks. `decision: block` appears nowhere in it. It fires at most once
per session, stays silent when a declared command ran, when a `verifier` was dispatched, and
when nothing but docs changed.

**`Stop` fires on every assistant turn, not once at the end** — a fact worth stating because
it is easy to assume otherwise and expensive to get wrong. The hook therefore scans the
transcript incrementally from a saved byte offset, and skips rewriting its marker on a turn
that changed nothing. Measured: **+9.1 ms per turn** in an opted-in project against a 35 ms
bare-Node-spawn floor, and indistinguishable from that floor in a project without the key.
Before the write-skip it was +28 ms.

### 9.3 Tests: the question coverage cannot ask

Agent-written tests fail in a particular way — they pass whether or not the implementation
is right. Mocking the unit under test, asserting only that nothing raised, snapshotting
current behavior as intended behavior. Coverage reports all of these as covered.

The reviewer now asks the one question that discriminates: *if the implementation were
subtly wrong, would this test fail?* It costs nothing at runtime and applies only when the
diff touches tests.

**The mutation-testing gate was rejected.** Tool names are per-ecosystem, so it cannot live
in `project-template/` without breaking the stack-agnostic rule — it belongs in `examples/`
if anywhere. And a gate slow enough that its own advocates scope it to changed files is a
gate that gets skipped under deadline. The reviewer instruction captures most of the value
at none of the cost.

### 9.4 What was rejected, and why the rejections are the point

**Per-task state files (`.claude/tasks/<id>.md`) — rejected.** The changelog already covers
finished work and is read back at the next session start; `compact-state.mjs` already covers
in-flight state across a compaction; git covers the files themselves. What remains is a hard
crash mid-task with uncommitted work — rare, largely recoverable, and not worth a convention
that must be current on every turn to be trustworthy. It also cannot be scoped down: "only
for non-trivial tasks" makes it optional, and an optional file that must be current to be
trusted is one that is silently stale. This package argues for fewer continuity artifacts
that are always true, not more that are sometimes true.

**A separate orchestration failure log — rejected.** The worker ledger and its session-brief
rollup already *are* that mechanism. Its real weakness is that it is gitignored, so the
signal never leaves the machine that produced it. Two lines extending the decision log fix
that for free: the ledger shows the pattern, the decision log is where the conclusion
survives. A second log would have been a duplicate mechanism for a job already assigned.

### 9.5 AGENTS.md: import, never duplicate

Claude Code reads `CLAUDE.md` and not `AGENTS.md`. A repository that already has an
`AGENTS.md` therefore gets a `CLAUDE.md` whose first line is `@AGENTS.md`, with only
Claude-specific additions below it. One file stays authoritative. Maintaining the same
content in both is the failure this avoids, and it is a more likely failure than the one it
solves.

### 9.6 Verification performed on this round

- `node --check` passes on `bootstrap.mjs` and all five hooks, one invocation per file.
- Every tracked `.json` parses, including `settings.template.json` after both substitutions;
  the template now declares five hook events.
- All 13 markdown files with frontmatter parse with no unknown fields and no `effort` on an
  effort-incapable model.
- `grep -riE "django|celery|IBBL|banking" user/ project-template/` returns nothing.
- `verify-reminder.mjs` exercised against: a project with no `verifyCommands` (inert), code
  edited with nothing verified (reminder, 391 bytes), the same session twice (once only), a
  declared command having run (silent), a `verifier` dispatch (silent), a docs-only change
  (silent), malformed JSON, empty stdin, a missing transcript, a missing `transcript_path`
  field, a repository with none of the expected files, and a transcript of junk lines.
  **Every path exits 0.**
- Incremental scanning verified directly: a transcript whose edit appears only in a later
  turn produces no reminder on the first turn (offset advanced to 92 bytes), the reminder on
  the turn the edit lands, and silence thereafter.
- `bootstrap.mjs install --home=/tmp/probe`, then `status`, then `doctor`: 15 files written,
  in sync, 8 of 8 checks pass, exit 0.

One test-harness failure is worth recording, because it nearly produced a false pass: the
first run of the hook suite built its fixtures with `node -e` and read `process.argv[3]`,
which is undefined — with `-e` there is no script path in `argv`, so positionals start at
`argv[1]`. No transcripts were created and every case tested a missing file, so all twelve
reported a clean exit 0. The tell was the one case that should have produced a reminder
returning zero bytes. An all-pass result whose passes all have the same cause deserves the
same suspicion as an all-fail one.

### 9.7 Defects that only exist because this is a package

The previous rounds hardened what the setup *does*. This one looked at what a stranger
meets when they run it on a machine that has never seen it. Three defects were visible only
from that angle.

**`node bootstrap.mjs --help` installed 17 files.** The command dispatcher took the first
non-`--` argument and defaulted to `install`, so any invocation with no bare command word
installed — including the single most common thing a person types when they want to know
what a program does. The same hole made `--dry-run` dangerous to mistype: `--dry` performed
a real install, silently, because an unrecognized flag was simply ignored.

Both are now caught before anything is written: `help` / `--help` / `-h` print usage and
exit 0, and an unrecognized flag prints what it was, states that nothing was written, shows
usage, and exits 1. For a package whose whole promise is that it behaves the same on every
machine, "the default command mutates your config" is a poor default.

**The install output never mentioned `doctor`.** §8.3 added the command that answers whether
an install actually works, and then the install itself told the user to restart Claude Code
and run `/context`. A diagnostic nobody is pointed at is a diagnostic nobody runs. The
next-steps block now leads with it.

**The README described an older system.** It listed two hooks when five ship, never
mentioned `doctor`, the version floor, or `verifyCommands`, and asserted that model versions
appear "in exactly one file in this repo — `docs/DESIGN-RATIONALE.md`" — which §7 had
already made false by moving the floor into `user/version-floor.json` and deliberately
refusing to restate it in prose. The front door of a distributable package contradicting its
own design document is the documentation-accuracy defect this repo's rules describe: worse
than no doc, because it is trusted.

`INSTALL.md` gained a table of the five hooks — event, purpose, and when each stays silent —
because a fresh install adds five entries to a stranger's `settings.json` and they deserve
to know what appeared and why none of it can break their session.

Verified by simulating a fresh workstation end to end: `--help` on an empty target creates
zero files; `install` writes 15 and prints `doctor` as step one; `doctor` passes 8 of 8 and
exits 0; a second `install` reports 0 written, 15 unchanged. Every hook, agent, skill, and
rule count was checked against what the docs claim ships, and the template's five wired
hooks were checked against the five files that exist.

### 9.8 Uninstall: ownership has to be recorded, not inferred

A package that installs into a directory it does not own needs a way out. Until now the only
one was deleting files by hand, and the obvious shortcut — `rm -rf ~/.claude` — takes the
user's plugins, projects, and history with it. That is a real gap for a package meant to be
deployed across many machines, several of which may be someone else's.

The design question is not how to delete files. It is **how the installer knows which files
are its own**. Deleting by name — everything `./user` currently contains — is wrong in both
directions: it misses a file installed by an earlier version of this package and since
dropped from the repo, and it happily deletes a `reviewer.md` the user rewrote from scratch.

The manifest already written at install time answers it. It records the hash of every file
this package wrote, so the rule becomes: **remove a file only if it is still byte-identical
to what was written here.** Identical means nobody has claimed it since. Different means
someone edited it deliberately and it is now theirs — it is kept, and reported. Ownership is
read from the manifest rather than from `./user`, so a file this package installed two
versions ago is still removable and a file it never wrote is never touched.

Settings needed the same rule in a different shape. The install merges; the uninstall
subtracts, and a value is removed **only when it still exactly equals what the template
installed** — the settings analogue of the hash comparison. Arrays are subtracted
element-wise by the same JSON identity the merge used to de-duplicate them, so a plugin's
`SessionStart` hook sitting in the same array as ours survives while ours leaves, and a
user's own `permissions.ask` rule survives alongside the destructive-command baseline. A
container emptied by that subtraction is dropped rather than left as `{}`; a `settings.json`
that turns out to have held nothing but our keys is removed, since an empty settings file
and no settings file are the same thing to Claude Code.

The template is rendered by one function shared with `install`. Two copies of the
placeholder substitution would eventually drift, and the first symptom would be an uninstall
that no longer recognizes its own hook entries — it would silently leave them behind.

Three deliberate refusals:

- **`--yes` is required.** Every other command is safe to mistype now; this one deletes. It
  prints its plan and writes nothing without the flag, and the plan is the identical text
  either way, so what is approved is what runs. Consistency with `--dry-run` mattered less
  than a mistyped `uninstall` costing a config directory.
- **No manifest means refuse, not guess.** Without the record there is no basis for claiming
  a file is ours, and the fallback — matching names against `./user` — is exactly the wrong
  answer described above. It reports why and removes nothing.
- **The manifest survives a partial uninstall.** While a locally modified file is still on
  disk, the manifest is the only record that it came from this package, so it is rewritten
  with just those entries rather than deleted.

One thing it cannot do: restore a value the install overwrote. If `model` was set to
something else before the first install, the merge replaced it and kept no record, so
uninstall removes the key rather than restoring the original. The timestamped backup written
immediately before the change is the recovery path, and this is stated in the README rather
than left for someone to discover.

Verified against a probe config directory seeded with a foreign `statusLine`, a foreign
`SessionStart` hook, a user `permissions.ask` rule, and a hand-written agent, plus one of our
own files edited after install. The plan run wrote nothing (19 files before and after). The
applied run removed 14 files, kept the edited `reviewer.md`, kept every foreign key and
array element, emptied and removed `hooks/`, `rules/`, and `skills/` while leaving `agents/`
in place because the user's own agent was still in it, and left `settings.json` holding
exactly the three foreign entries it started with. A second uninstall removed nothing and
reported nothing to restart. A clean install → uninstall → install round trip returned
`status` to "In sync with this repo".

## 10. Audit round: three mechanisms that looked right and did nothing

This round began as an independent verification of the previous two, not as new work. Every
static check in the repository passed, `bootstrap.mjs doctor` reported 8 of 8, and the
rationale above described a working system. The audit still found one mechanism that had never
run once, one diagnostic structurally unable to report the failure it was written for, and two
detectors whose conditions could not fire in practice.

The common thread is worth naming, because it is the thing this package now defends against: a
check and a defect can be in perfect agreement and both be wrong. Presence was verified;
behaviour was not.

### 10.1 The Task Packet check never ran (defect)

`packet-check.mjs` read `payload.prompt_text` on `SubagentStart`. Measured against Claude Code
2.1.220, the entire `SubagentStart` payload is:

```
session_id, transcript_path, cwd, prompt_id, agent_id, agent_type, hook_event_name
```

There is no `prompt_text`. The hook took its "nothing to check" exit on every dispatch since it
shipped, and warned no one. Nothing in the repository could see this: `node --check` passed,
the JSON parsed, the hook was correctly registered, and it dutifully exited 0. Feeding it a
hand-written payload containing `prompt_text` — which is how it was originally tested —
produced a perfect warning, which is precisely how the defect survived.

Recovering the packet from disk at that moment was investigated and does not work. Both
candidate sources were checked against a live dispatch and neither exists yet when
`SubagentStart` fires: the per-subagent transcript
(`<project>/<session>/subagents/agent-<agent_id>.jsonl`) has not been created, and the parent
transcript has not been flushed with the `Agent` tool_use block. The data is genuinely absent,
not merely awkward to reach.

`PreToolUse` on the `Agent` tool carries `tool_input.prompt` and `tool_input.subagent_type`
directly, before the worker starts. That is the only point in the lifecycle where the packet is
mechanically available, so that is where the check now lives.

**The cost is real and is not hidden.** The warning now reaches the **orchestrator** instead of
the subagent. The original design's advantage — a worker told its packet is thin returns
`BLOCKED` instead of inventing a design — is lost. What replaces it is weaker in kind but
present in fact: the author of the packet is told before the worker spawns, and the author is
the party who can actually fix it. A warning delivered to the second-best reader beats one
delivered to nobody.

Two constraints follow from the move, both now enforced by `verify-repo.mjs`:

- **It must never block.** `SubagentStart` could not block; `PreToolUse` can. The field matching
  is deliberately loose because a packet is prose, and a blocking gate on loose matching produces
  false denials, which get the hook switched off, which removes the warning too. `permissionDecision`
  appears nowhere in the hook, and a check asserts it never will.
- **The event is an invariant.** A regression to `SubagentStart` is a silent return to doing
  nothing, so it fails the build rather than merely looking odd in a diff.

Existing installs are migrated. The settings merge is additive, so the dead `SubagentStart`
entry would otherwise sit in every `settings.json` forever. `DEPRECATED_HOOKS` removes it by
event plus command substring, leaving co-located foreign entries — a plugin's own
`SubagentStart` hook in the same array — untouched.

### 10.2 `doctor` could not detect a permanently stale file

§8.3.1 records that a locally extended file can never receive package updates: `install` skips
it and `--force` would discard the local content. What was missed is that `doctor` reports that
state as **PASS**, forever.

The classification compared the manifest hash against the *installed* hash. Both differ from
each other whether the installed copy is one release behind or fifty, so a machine running a
year-old policy file was indistinguishable from one edited five minutes ago. Worse, `install`
rewrote the manifest entry to the current repo hash even when it had skipped the file, erasing
the only evidence of what had actually been written.

Two changes make the state visible:

- The manifest now records what this package last **wrote**. On a skip it preserves the previous
  value instead of overwriting it with content that never reached disk.
- `doctor` splits "locally modified" into *current* and *behind* by asking whether the content we
  last wrote is still what the repo holds. Behind **fails**, because a machine silently running
  superseded policy is the exact divergence this package exists to prevent.

The failure names a remedy that works: move personal additions into `~/.claude/rules/<name>.md`,
which is loaded automatically and is not owned by this package, then reinstall. Verified across
the full lifecycle — fresh install, local edit, upstream change, remedy — with `doctor` exiting
0, 0, 1, 0 and only that check changing.

### 10.3 Two detectors that could not fire

**The ledger's all-null alarm.** `session-brief.mjs` warned when the report contract broke, but
only if `rows.every(e => !e.result)`. On the live ledger, 5 of 7 rows carried no result and the
alarm stayed silent, because two rows did. Unanimity is the wrong test: the rows that parse are
by definition the ones that followed the contract, so a partial breakage — the likely shape — is
exactly what unanimity misses. It is now a majority test and reports the ratio.

**Verification counted a mention as a run.** `verify-reminder.mjs` matched declared commands with
`cmd.includes(c)`, so `echo "remember to run make test"` or `grep "make test" Makefile` marked
the session verified and suppressed the reminder for the rest of it. Matching is now anchored to
the start of a shell segment, with leading environment assignments stripped so `CI=1 make test`
still counts. This deliberately trades a silent false pass for a possible noisy false reminder;
the reminder's own text tells the reader to say so and finish.

**Infrastructure is code.** The same hook's extension list covered 20 languages but not `.sh`,
`.yml`, `.tf`, or `Dockerfile`, so a session that rewrote only a deploy pipeline was treated as a
documentation change. Those now count.

### 10.4 The version floor could read the wrong number

`session-brief.mjs` derived the running version from the first path segment matching `x.y.z`.
On a runtime installed under a bare version directory — `/opt/asdf/installs/nodejs/22.23.1/…` —
that is the **Node** version. Being far above any plausible floor, it would silence the warning
on exactly the outdated installs the check exists to catch. The segment is now anchored to a
literal `versions` parent, and the npm `package.json` walk remains the fallback that resolves
this machine correctly.

### 10.5 `verify-repo.mjs` now runs the hooks

The script asserted structure and never executed anything, which is why it certified an inert
hook for two rounds. It now also:

- runs every hook against a payload **captured from a live Claude Code run**, and demands the
  behaviour that payload should produce — a warning where there should be one, silence where
  there should not;
- runs every hook four ways (realistic, malformed JSON, empty stdin, missing files) and requires
  exit 0 from all of them, since these sit on observability surfaces;
- checks that every hook file is registered, that every registered command names a file that
  exists, and that `packet-check.mjs` is wired to an event that can actually feed it.

It is also now committed. It was untracked through both previous rounds, so no clone could run
the checks the rationale cited as evidence.

### 10.6 Verification performed on this round

- `node verify-repo.mjs --verbose`: **85 of 85**, exit 0.
- The new checks were **mutation-tested** rather than trusted. Seven deliberate defects were
  introduced into a scratch copy, one at a time, and each had to be caught: `packet-check` rewired
  to `SubagentStart`; `packet-check` reverted to reading `prompt_text`; a hook made to exit 1 on
  malformed input; a registered hook file deleted; `packet-check` made to emit
  `permissionDecision: "deny"`; the infrastructure extensions removed; and command matching
  reverted to `includes`. All seven failed the suite. The first pass caught only five, which is
  why the two `verify-reminder` behaviour checks exist.
- `SubagentStart`, `Stop`, `PreCompact`, `SubagentStop`, and `PreToolUse` were each confirmed to
  fire by canary hooks injected through `--settings` against a real headless session, with a
  `SubagentStop` control in the same run. `PreToolUse` `additionalContext` was confirmed to reach
  the model, not merely to be emitted.
- The `Stop` reminder was exercised end to end in a live session: a real code edit with no
  verification produced `{"offset":29905,"edited":true,"verified":false,"reminded":true}`.
- Deprecated-hook migration was exercised against a seeded `settings.json` carrying the old
  `SubagentStart` entry, a foreign plugin hook in the same array, a foreign `PreToolUse` entry,
  `statusLine`, and `enabledPlugins`. Only our own entry was removed; everything else survived.
- `doctor`'s behind-detection was exercised across the full lifecycle described in §10.2.
- Two measurement errors are worth recording, because each briefly produced a confident wrong
  answer. macOS resolves `/tmp` to `/private/tmp`, so a marker keyed by project hash appeared
  absent when it existed under the resolved path; and `timeout` does not exist on macOS, which
  silently voided a probe. Both were caught only because a control run was included — the same
  lesson §8.6 records, learned again.

## 11. `doctor` had never passed on Windows

### 11.1 The defect

`claudeVersion()` ran `execFileSync("claude", ["--version"])`. On Windows, `claude` is an npm
shim — `claude.cmd` — and Node's `execFile` resolves neither `PATHEXT` nor the shim itself, so
the call raised `ENOENT` regardless of whether Claude Code was installed. `claudeVersion()`
returned `null`, and `doctor` reported:

```
FAIL  Claude Code >= 2.1.219
      `claude --version` did not run — is claude on PATH?
```

about a `claude` that was on `PATH` and answered correctly when invoked through a shell. The
check could not pass on Windows under any configuration, so `doctor` exited 1 on every Windows
install this package has had, and `README.md` and `INSTALL.md` both instruct the reader to treat
a non-zero `doctor` as a broken install.

The fix passes `shell: true` on `win32` only. The argument list is a compile-time literal, so
routing through `cmd.exe` adds no injection surface; POSIX keeps the direct exec rather than
paying for a shell it does not need.

This is the §1 trap in a new costume — a check that reports a problem it is not actually
measuring. It differs from §10's three defects in one way worth naming: those were silent, and
this one was loud. It failed in the user's face on every run, and still survived, because
nothing in the repository had ever executed `bootstrap.mjs` on the platform in question.

### 11.2 Why no existing check could catch it

`verify-repo.mjs` ran `bootstrap.mjs` through `node --check` and nothing further. A file that
parses can still be wrong on an entire operating system, and this one was. Section 12
(*Installer behaviour*) now runs the installer for real against a throwaway `--home=` dir.

The version probe is exercised with a **stub `claude` placed on `PATH`** — `claude.cmd` on
Windows, a `0755` shell script elsewhere — reporting a version above any plausible floor. That
keeps the check honest without requiring Claude Code to be installed on the machine running it,
which is what makes it viable in CI. A negative case runs the same probe with an empty directory
as `PATH` and requires the `is claude on PATH?` message to survive, so the assertion cannot be
satisfied by a probe that reports success without looking.

### 11.3 Verification performed on this round

- `node verify-repo.mjs`: **102 of 102**, exit 0 (was 99 before this round).
- The new check was confirmed to catch the defect rather than trusted: reverting `shell:` to
  `false` and re-running turned `doctor resolves \`claude\` on PATH and reports its version`
  red, and restoring it turned it green. This is the mutation discipline §10.6 established.
- `node bootstrap.mjs doctor` on Windows 11 / Node 22 / Claude Code 2.1.221 now reports
  `PASS  Claude Code >= 2.1.219 — 2.1.221`, where it previously reported the `ENOENT` failure
  above. This is the **first verification of this package recorded on Windows**; every prior
  round in this document was performed on macOS, while `README.md` claimed all three platforms.
- `node --check` passes on `bootstrap.mjs`, `verify-repo.mjs`, and all seven hooks, one
  invocation per file.
- **Not verified by hand: the POSIX branch of the new section.** The fix itself is a no-op
  there — `shell: false` is already Node's default, so that path is byte-identical to before —
  but the `0755` shell stub was written on Windows and never executed on macOS or Linux. The
  `.github/workflows/verify.yml` matrix covers it; this entry records that the coverage is the
  workflow's, not the author's.
- One measurement error, in the §10.6 tradition: the negative case initially left the stub's own
  directory on `PATH`, so `claude` was still resolvable and the check failed for the opposite of
  the reason it appeared to. A negative control that cannot actually reach the negative state
  tests nothing — the same class of error as the `/private/tmp` reading above.
