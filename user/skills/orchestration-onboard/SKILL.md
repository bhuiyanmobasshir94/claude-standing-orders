---
name: orchestration-onboard
description: Set up the current repository for the orchestrator-worker workflow - project CLAUDE.md, path-scoped rules, continuity directories, and permission settings - by reading the codebase first and proposing a plan before writing anything.
disable-model-invocation: true
argument-hint: "[path to the standing-orders repo, if not ~/dev/claude-standing-orders]"
---

# Onboard this repository

Set up the repository in the current working directory for the orchestrator–worker
workflow. Template files live in the standing-orders repo — use `$ARGUMENTS` as its path if
given, otherwise try `~/dev/claude-standing-orders`, and ask if neither exists.

**Write nothing until step 4 is approved.** This skill produces a plan first.

## 1. Read the repository

Use the `Explore` subagent so this does not fill the main context. Establish:

- language, framework, and how the source tree is laid out
- the real build, test, lint, and format commands — from the Makefile, `package.json`
  scripts, `pyproject.toml`, `justfile`, or CI config, not from convention
- where migrations, models or schemas, background jobs, and request handlers live
- whether a CLAUDE.md, AGENTS.md, `.cursorrules`, or `.github/copilot-instructions.md`
  already exists, and what it says
- whether `docs/changelogs/`, `docs/decisions/`, `docs/adr/`, or an equivalent exists
- what this system does and what breaks if it is wrong — the risk profile

## 2. Interview me for what the code cannot tell you

The operating-constraints section is the highest-value part of the file and the one you
cannot infer. Ask me — in one batch, not one at a time — only about what you could not
determine from the code:

- traffic shape: peak versus average, what spikes and when
- which paths have a user actively waiting, and which do not
- hard external limits: rate limits, quotas, third-party throttling
- which tables or collections grow without bound
- compliance or audit obligations, if any
- what a new engineer gets wrong in their first week

If I answer "not applicable" to something, drop that item rather than writing a hedge.

## 3. Map the templates onto this repository

From `<orchestrator>/project-template/`:

- **`CLAUDE.md`** — fill every `FILL` marker from steps 1 and 2. Delete the guidance
  comments. Delete any non-negotiable that is not true here; a rule that is present but
  untrue teaches me to ignore the file. Keep it under ~150 lines.
- **`rules/*.md`** — rewrite each `paths:` list to match this repository's actual layout,
  verifying each glob matches real files. Delete rules that do not apply. Add a rule only
  if this project has a standard the templates do not cover.
- **`settings.json`** — merge into any existing `.claude/settings.json` rather than
  replacing it. Add `ask` entries for the destructive commands specific to this project:
  migrations, deploys, data backfills, anything that touches production.

If a rule file would end up with fewer than three applicable rules, fold it into
`CLAUDE.md` instead. Do not ship near-empty files.

## 4. Show me the plan

Present, before writing anything:

- the CLAUDE.md you propose, in full
- for each rule file: its `paths` globs, a count of files each glob matches, and which
  rules you kept, changed, or dropped
- a diff against any existing CLAUDE.md, and what would be lost
- the directories and files you would create
- anything from step 2 you are still unsure about

Then stop and wait for my approval.

## 5. Apply

On approval:

1. Write `CLAUDE.md` and `.claude/rules/*.md`. If the repository already has an
   `AGENTS.md`, do not duplicate it: Claude Code reads `CLAUDE.md` and not `AGENTS.md`, so
   write a `CLAUDE.md` whose first line is `@AGENTS.md` and put only the Claude-specific
   additions below that import. One file stays authoritative and both tools read the same
   instructions. Never maintain the same content in both.
2. Merge `.claude/settings.json`.
3. Create the continuity directories if missing: a changelog directory and a decision log.
   If this repository already uses a non-default convention — `docs/adr/`, a root
   `DECISIONS.md`, a `changelogs/` directory — keep it and write `.claude/continuity.json`
   pointing at it rather than creating a second convention:
   ```json
   { "changelogDir": "docs/changelogs", "decisionFile": "docs/decisions/DECISIONS.md" }
   ```
   Add this project's test and lint commands to the same file as
   `"verifyCommands": ["make test", "make lint"]`, using the real commands from step 1.
   This is what activates the verification reminder; without the key that hook stays
   silent, so a project that skips this simply keeps today's behavior.
4. Seed the decision log with the standing decisions you found in step 1 that already
   constrain future work — the choices that are load-bearing but written down nowhere.
   Three or four lines each: decision, why, what it rules out.
5. Add `.claude/settings.local.json` and `.claude/worker-ledger.jsonl` to `.gitignore`.
   Leave `.claude/agent-memory/` tracked.
6. Write a changelog entry for the onboarding itself.

## 6. Verify and report

Confirm with `/context` that the project CLAUDE.md loaded. Path-scoped rules will not
appear until a matching file is read — read one file per rule to prove each glob fires,
and report any that did not.

Report as a table: files created, files modified, rules dropped and why, and anything I
still need to fill in myself.
