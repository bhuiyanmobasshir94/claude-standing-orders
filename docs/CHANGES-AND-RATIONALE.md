# What changed, and why

Every claim below was checked against the current Claude Code documentation
(`code.claude.com/docs`) on 27 July 2026, not against recalled behavior. Version floors are
noted where a feature is recent enough to matter.

---

## 1. Bugs in the previous setup

### 1.1 `effort: xhigh` on the Haiku worker was a no-op

`fast-implementer.md` set `model: haiku` with `effort: xhigh`. Effort levels are supported
only on the models below; **models not listed do not support effort at all**:

| Model | Levels |
| --- | --- |
| Fable 5 | low, medium, high, xhigh, max |
| Opus 5, Sonnet 5, Opus 4.8, Opus 4.7 | low, medium, high, xhigh, max |
| Opus 4.6, Sonnet 4.6 | low, medium, high, max |

Haiku appears nowhere on that list. The setting was silently ignored, which is worse than
absent: the config asserted a guarantee the runtime never provided, and the roles doc
described "xhigh on all tiers" as a deliberate choice.

**Fix:** `fast-implementer` and `verifier` carry no `effort` field, with a comment in each
file explaining why. Work that genuinely needs deeper reasoning routes to `implementer`
(Sonnet, which does support `xhigh`).

### 1.2 Hardcoded absolute paths broke portability

`settings.json` pointed hooks and the statusline at
`/Users/mobasshirbhuia/.claude/hooks/...`. On Linux, Windows, or a server that path does not
exist and the hooks fail. This is the single biggest obstacle to "the same workflow
everywhere."

**Fix:** the repo ships `settings.template.json` with a `__CLAUDE_HOME__` placeholder that
`bootstrap.mjs` resolves at install time on each machine. Hook paths are machine-specific
by nature, so they are generated rather than committed.

**Still to handle:** the three `caveman-*` hook entries in your existing settings keep their
macOS paths — the merge preserves them deliberately, since they are yours. On a Linux server
they will fail. Either reinstall the caveman plugin per machine with `/plugin` and drop the
manual hook entries, or delete those three entries from the server's settings.

### 1.3 Model description had drifted

The old file described the orchestrator as "Opus 4.8." As of Claude Code v2.1.219 the `opus`
alias resolves to **Opus 5** on the Anthropic API; it resolved to Opus 4.8 from v2.1.154.
The config was right (it used `"model": "opus"`); only the prose was stale — which is
exactly the kind of drift that eventually causes someone to "fix" the config to match the
docs.

**Fix:** roles are described by alias only. Version numbers appear in exactly one place —
this document — and never in a config file. This is the same tier-indirection principle you
already use in Saturn Skills OS: the alias is the capability tier, and there is one
resolution point.

---

## 2. What Kimi got right, and what it got wrong

### Wrong — and worth knowing why

**"Model names are fictional; use Claude 3 Opus / 3.5 Sonnet."** Opus 4.8, Sonnet 5, and
Haiku 4.5 are all real. Claude Code's own changelog announced Opus 4.8 at v2.1.154 on
28 May 2026. Kimi's suggested replacements are roughly two years out of date. Acting on this
would have downgraded the entire setup.

**"settings.json must register agents via an `agents` array."** There is no such key.
Subagents are registered by their presence as markdown files in `~/.claude/agents/` or
`.claude/agents/`. The suggested JSON (`{"agents":[{"name":..., "promptFile":...}]}`) is not
in the schema — and this matters more than it looks: **user, project, and local settings
files are validated strictly, and a file that fails validation is rejected as a whole.**
Pasting that block would not have added agent registration; it would have silently disabled
your model choice, effort level, plugins, and statusline at once.

There *is* an `agent` key (singular), but it does something different: it runs the main
thread as a named subagent.

**"Max 3 workers touching the same file concurrently."** Concurrent writers to one file lose
edits. The correct rule is **one writer per file, ever** — fan out across disjoint file
sets, or give a worker `isolation: worktree` so it gets its own checkout. This is now in the
policy as a hard rule.

**"Mandate diffs in the worker report."** This defeats the purpose of delegation. The reason
to use a subagent is that its verbose output stays in *its* context; pasting diffs back
spends exactly the context you were buying. The report names files and describes changes in
one line each, and the orchestrator runs `git diff` when it wants detail.

### Right, and adopted

| Kimi's point | How it is implemented |
| --- | --- |
| No context-passing protocol | **Task Packet**: intent, files, anchors, constraints, done-means — required on every delegation |
| No review worker | **`reviewer`** — Sonnet, read-only via `disallowedTools`, cites `file:line`, never reviews its own work |
| No escalation format | **`BLOCKED` report** with blocker, evidence, what-I-need, and on-disk state |
| No structured output | **Report contract** with fixed sections, preloaded into every worker |
| No session state | Three-layer memory — see §4 |
| No test/validation separation | **`verifier`** — runs commands, reports evidence, zero judgment |
| Caveman is a black box | Documented in the policy as UI-only, plus the verified fact that output styles never reach subagents |
| Parallelism guardrails | Replaced the file-level rule with one-writer-per-file, batch caps, and the real env limits |

### Kimi's architectural question, answered

It asked whether the orchestrator should *synthesize* or *delegate integration*. The
question contains a false premise: workers already hold `Write` and `Edit` and write
directly into the working tree, so there are no patches to apply. "Integration" here means
reviewing and reconciling what is already on disk. The orchestrator owns that judgment and
never re-implements. When true separation is needed — parallel approaches, risky refactors —
`isolation: worktree` gives a worker its own checkout, and merging becomes an explicit git
operation rather than an agent responsibility.

---

## 3. What is new, beyond fixing bugs

### A contract that actually reaches the workers

Subagents receive the full `CLAUDE.md` hierarchy, so project standards do reach them. They
do **not** receive your conversation, your auto memory, or your output style. The report
format and escalation shape therefore live in a **skill preloaded via each agent's `skills`
field**, which injects the full skill content into the subagent at startup. That is a
guarantee, unlike hoping a rules file propagates.

(A skill can only be preloaded if it does not set `disable-model-invocation: true`, so
`worker-contract` uses `user-invocable: false` instead.)

### `reviewer` and `verifier` are genuinely different roles

Following the distinction you already drew in Saturn Skills OS: the **reviewer** measures a
diff against cited standards and produces findings with `file:line` evidence; the
**verifier** executes binary predicates and reports pass/fail with no interpretation. The
reviewer's findings template includes a mandatory **Verified clean** section, because a
review's silence otherwise carries no information about what was actually checked.

### Workers cannot fan out

By default a subagent can spawn subagents up to three layers deep (v2.1.219+). Uncontrolled,
that turns a delegation into a tree you cannot audit. Two independent controls now prevent
it: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` in settings, and no worker lists the `Agent`
tool. Concurrency is capped at 6 (the default is 20).

### Fail-closed, applied correctly

Your named principle is that ambiguity surfaces default to the safe branch. Applied
precisely, that means **authorization** boundaries fail closed — the policy states it for
permission, validation, and security paths. **Observability** boundaries are the opposite: a
hook that logs must never break a session. Both hooks therefore exit 0 on every failure
path, and say so in their header comments. Same principle, opposite defaults, and the
distinction is deliberate.

---

## 4. Session memory, in three layers

You asked for project-level memory so a new session picks up aligned with past changes. One
constraint shapes the whole design: **auto memory is machine-local and does not sync.** It
lives in `~/.claude/projects/<project>/memory/` and never travels to your server. So
anything another machine must know has to be a committed file.

| Layer | Where | Travels between machines | Written by |
| --- | --- | --- | --- |
| **Standing decisions** | `docs/decisions/DECISIONS.md` | Yes — committed | You and Claude, deliberately |
| **Session history** | `docs/changelogs/YYYY-MM-DD-*.md` | Yes — committed | Required at session end |
| **Agent knowledge** | `.claude/agent-memory/<agent>/` | Yes — commit this directory | `implementer` and `reviewer`, via `memory: project` |
| **Worker ledger** | `.claude/worker-ledger.jsonl` | No — gitignored | `SubagentStop` hook |
| **Auto memory** | `~/.claude/projects/<project>/memory/` | **No** | Claude, automatically |

The `session-brief` hook closes the loop: at every `SessionStart` it reads the decision log,
the three most recent changelogs, and the tail of the worker ledger, and injects them as
context. A session on your server opens with the same history as a session on your Mac.
`MEMORY.md`-style truncation applies to nothing here, but the brief self-caps at 8,000
characters so it cannot crowd out the session.

---

## 5. Generalizing the project layer

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
`docs/changelogs/` and `docs/decisions/DECISIONS.md`. It now resolves, in order: an explicit
`.claude/continuity.json`, then a list of common layouts including `docs/adr/`, a root
`DECISIONS.md`, and `changelogs/`. An ADR directory is summarized as a list of record titles
rather than inlined. Files without a leading date sort by modification time. A repository
with none of these produces no brief and no error.

One rule was deliberately softened rather than generalized. "Never hard-delete" was a
correct policy for the banking codebase but is not universal, so the template says: check
how this project deletes before adding a delete path, and match it. A rule that is present
but untrue in a given repository teaches Claude to discount the whole file.

---

## 6. Restructuring the project CLAUDE.md

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

## 7. Verification performed on this package

- All three `.mjs` files pass `node --check`.
- `bootstrap.mjs` was run against a temp home **seeded with your actual `settings.json`**;
  the merge preserved `enabledPlugins`, `extraKnownMarketplaces`, `statusLine`, and all
  three caveman hooks while adding the new keys and hook entries. Output re-parsed as valid
  JSON.
- Idempotency confirmed (second run: 0 written, 10 unchanged); local-modification
  protection and `--force` override both confirmed.
- Every agent and skill frontmatter parsed as YAML and checked field-by-field against the
  documented schema: no unknown fields, valid model aliases, valid effort values, `effort`
  present only on effort-capable models, no worker holding the `Agent` tool, and every
  preloaded skill resolving to a real file.
- Both hooks were exercised against a realistic repo layout, and against malformed JSON,
  empty stdin, and a bare directory with no continuity files — all exit 0 without output.
- Continuity discovery was tested against four repository shapes: an `docs/adr/` directory,
  a root `DECISIONS.md` with undated changelog filenames, an explicit `.claude/continuity.json`
  pointing at non-standard paths, and a repository with no continuity files at all.

## 8. Version floors

Opus 5 requires Claude Code **v2.1.219+**. The subagent spawn-depth and concurrency limits
require v2.1.217+, subagent output scanning v2.1.210+, and background-by-default subagents
v2.1.198+. Run `claude update` on every machine before installing, then `claude --version`
to confirm. On Amazon Bedrock or Vertex the `opus` and `sonnet` aliases resolve to older
versions than on the Anthropic API — pin `ANTHROPIC_DEFAULT_OPUS_MODEL` and
`ANTHROPIC_DEFAULT_SONNET_MODEL` in that machine's settings `env` if you deploy there.

---

## 9. This repository was not practicing its own policy

A repository that tells other repositories how to run an orchestrator–worker workflow has
to be internally consistent about it. It was not. Five contradictions existed between what
this repo instructs and what it does, all found and fixed in the same session
(2026-07-28) — see `docs/changelogs/2026-07-28-continuity-and-ledger-fixes.md` for the full
verification trail.

### 9.1 The worker ledger was committed, contradicting the onboarding skill

`orchestration-onboard/SKILL.md` step 5 instructs: *"Add `.claude/settings.local.json` and
`.claude/worker-ledger.jsonl` to `.gitignore`. Leave `.claude/agent-memory/` tracked."* Yet
`.claude/worker-ledger.jsonl` was tracked in this repo (added in commit `92b735e`), and the
repo shipped **no `.gitignore` at all**. `.claude/settings.local.json` was spared only by
the developer's machine-local `~/.gitignore_global`, which does not exist on a fresh clone
or a Linux server — exactly the portability failure this package exists to prevent.

**Fix:** a root `.gitignore` now covers `.claude/settings.local.json`,
`.claude/worker-ledger.jsonl`, and `.claude/worktrees/`; `.claude/worker-ledger.jsonl` was
removed from the index with `git rm --cached` (the file itself is untouched on disk).
`.claude/agent-memory/` is deliberately not listed, matching the skill.

### 9.2 The rationale doc contradicted the skill it was documenting

The §4 table above described the ledger's portability as "Optional — gitignore it or not."
The skill says always ignore it. A reader who trusted the table over the skill would commit
the ledger; a reader who trusted the skill over the table would think the doc was wrong.
Either way, one of the two had to be authoritative.

**Fix:** the table now reads "No — gitignored," matching the skill exactly.

### 9.3 The ledger's result extractor didn't recognize the verifier's own vocabulary

`user/hooks/worker-ledger.mjs`'s `extractResult` matched only
`/^##\s*Result\s*\r?\n+\s*(DONE|PARTIAL|BLOCKED)\b/im` — the `worker-contract` vocabulary.
But `verifier.md` declares its Result vocabulary as `PASS | FAIL | BLOCKED`, not
`DONE | PARTIAL | BLOCKED`, because it executes binary predicates rather than performing
work (§2, "`reviewer` and `verifier` are genuinely different roles"). This was not a
theoretical gap: a real `verifier` subagent run in this session returned a report beginning
`## Result` / `PASS`, and the ledger recorded `{"result": null, ...}` for it. Every verifier
completion, ever, would log as `result: null`, which `session-brief.mjs` renders as
`→ unknown` — silently discarding the one worker role whose entire job is to report a
verdict.

**Fix:** the regex now accepts `DONE|PARTIAL|BLOCKED|PASS|FAIL`, with a comment explaining
why both vocabularies exist. Confirmed by piping a synthetic `verifier`-shaped payload
through the hook and reading the appended row back — see the changelog's Verification
section for the exact input and output.

### 9.4 The ledger logged a row for stop events with no worker identity

The same hook fell back to the literal string `"subagent"` when a `SubagentStop` payload
carried neither `agent_type` nor `agentType`:
`payload.agent_type || payload.agentType || "subagent"`. The §9.3 verifier run proves a
genuine subagent completion *does* supply `agent_type`; a stop event that lacks it is
therefore not a worker completion; it carries no agent identity, no result, and no note —
a row of pure noise that pollutes `session-brief.mjs`'s "Recent worker activity" section
with `→ unknown` lines.

**Fix:** a payload with neither field now exits the hook with no row appended, inside the
same fail-open `try` block that already governs every other path. This is a deliberate
tradeoff: a genuine worker completion that somehow arrives without an identity field would
now go unrecorded rather than logged under a placeholder. Nothing observed today omits the
field; if that ever changes, ledger gaps are the first place to look.

### 9.5 The repository did not follow its own session-continuity rule

`session-continuity.md` requires a changelog entry for any session that changes code,
config, or docs, and a decision log for choices that constrain future work. This repository
had neither `docs/changelogs/` nor `docs/decisions/DECISIONS.md` — all three prior commits
changed code and left no changelog entry, and `session-brief.mjs` consequently produced no
brief when a session opened in this very repo, the one place it should never happen.

**Fix:** `docs/decisions/DECISIONS.md` now records the decisions that were already
load-bearing but undocumented — alias pinning, the no-effort-on-Haiku rule, one-writer-per-
file, the no-diffs-in-reports rule, the preloaded-skill contract mechanism, committed-file
continuity, the merge-only installer, generated (not committed) hook paths, fail-open
observability, and this session's C1/C2 resolution. `docs/changelogs/` now holds this
session's own entry, written in the shape `session-continuity.md` prescribes.
`.claude/continuity.json` was deliberately **not** added, since its defaults already match
what `session-brief.mjs` discovers by convention.
