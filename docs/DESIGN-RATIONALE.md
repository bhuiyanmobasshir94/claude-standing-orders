# Design rationale

This document explains why the package is built the way it is: the bugs the current design
fixes, the choices layered on top of those fixes, and the constraints that shape both. Every
claim below was checked against the current Claude Code documentation
(`code.claude.com/docs`) on 27 July 2026, not against recalled behavior. Version floors are
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

- All three `.mjs` files pass `node --check`.
- `bootstrap.mjs` was run against a temp home seeded with a representative `settings.json`;
  the merge preserved `enabledPlugins`, `extraKnownMarketplaces`, `statusLine`, and existing
  hook entries while adding the new keys and hook entries. Output re-parsed as valid JSON.
- Idempotency confirmed (second run: 0 written, 10 unchanged); local-modification
  protection and `--force` override both confirmed.
- Every agent and skill frontmatter parsed as YAML and checked field-by-field against the
  documented schema: no unknown fields, valid model aliases, valid effort values, `effort`
  present only on effort-capable models, no worker holding the `Agent` tool, and every
  preloaded skill resolving to a real file.
- Both hooks were exercised against a realistic repo layout, and against malformed JSON,
  empty stdin, and a bare directory with no continuity files — all exit 0 without output.
- Continuity discovery was tested against four repository shapes: a `docs/adr/` directory,
  a root `DECISIONS.md` with undated changelog filenames, an explicit
  `.claude/continuity.json` pointing at non-standard paths, and a repository with no
  continuity files at all.

## 7. Version floors

Opus 5 requires Claude Code **v2.1.219+**. The subagent spawn-depth and concurrency limits
require v2.1.217+, subagent output scanning v2.1.210+, and background-by-default subagents
v2.1.198+. Run `claude update` on every machine before installing, then `claude --version`
to confirm. On Amazon Bedrock or Vertex the `opus` and `sonnet` aliases resolve to older
versions than on the Anthropic API — pin `ANTHROPIC_DEFAULT_OPUS_MODEL` and
`ANTHROPIC_DEFAULT_SONNET_MODEL` in that machine's settings `env` when deploying there.
