# Instructions

Three prompts. Run **A** once per repo update, **B** once per machine, **C** once per project.
Each is written to be pasted verbatim into Claude Code.

---

## A — Update the orchestrator repo

Run this from inside your `claude-orchestrator` clone, with the new package extracted
somewhere Claude Code can read it.

```
Update this orchestrator repo from the package at <PATH-TO-EXTRACTED-PACKAGE>.

Context: the project layer was previously written for one specific Django/Celery/SES
codebase. This update generalizes it so any repository can use it, and preserves the
old project-specific version as a worked example.

Do this:

1. Show me `git status`. If the tree is dirty, stop and tell me.
2. Create a branch: chore/generalize-project-layer
3. Apply these changes, showing me the diff for each before writing:
   - DELETE the ./project directory
   - ADD ./project-template/  (stack-agnostic CLAUDE.md, settings.json, rules/)
   - ADD ./examples/django-celery-ses-banking/  (the old ./project content, unchanged)
   - REPLACE ./user/hooks/session-brief.mjs  (now discovers changelog and decision
     locations instead of assuming docs/changelogs and docs/decisions)
   - ADD ./user/skills/orchestration-onboard/SKILL.md
   - REPLACE ./user/CLAUDE.md, ./user/rules/session-continuity.md,
     ./user/rules/documentation-accuracy.md  (wording made framework-neutral)
   - REPLACE ./README.md, ./INSTALL.md, ./docs/CHANGES-AND-RATIONALE.md
   - Leave ./bootstrap.mjs, ./user/settings.template.json, ./user/agents/*,
     ./user/skills/worker-contract/* unchanged unless the package differs
4. Verify before committing:
   - `node --check` passes on bootstrap.mjs and both files in user/hooks/
   - every .json in the repo parses
   - every .md with YAML frontmatter parses, and no agent file sets `effort` on a
     `model: haiku` agent
   - `grep -riE "django|celery|IBBL|banking" user/ project-template/` returns nothing
5. Commit with a message describing the generalization, and show me the final tree.

Do not push. I will review and push myself.
```

---

## B — Install or update a machine

Run from inside the repo on each machine — Mac, Windows, Linux, or a server.

```
Install the orchestrator-worker setup in this directory onto this machine.

1. Confirm the environment, and stop and tell me if either check fails:
   - `claude --version` reports 2.1.219 or later (Opus 5 requires it). If older, tell me
     to run `claude update` first.
   - `node --version` reports 18 or later.

2. Back up my current config: copy ~/.claude to ~/claude-backup-<today's date>.

3. Run `node bootstrap.mjs install --dry-run` and show me what it would change.
   Then run `node bootstrap.mjs install`.
   Do not edit my settings by hand — the script merges non-destructively and writes a
   timestamped backup. If it reports files skipped as locally modified, show me each
   diff and ask before using --force.

4. Verify and report as a table:
   - `node bootstrap.mjs status` shows everything in sync
   - ~/.claude/agents/ contains implementer, fast-implementer, reviewer, verifier
   - ~/.claude/skills/ contains worker-contract and orchestration-onboard
   - ~/.claude/settings.json parses as valid JSON and still contains every key it had
     before the install
   - both hook commands in settings.json point at paths that exist on THIS machine

5. List any hook or statusLine entry in settings.json whose command path does not exist
   here — in particular anything pointing at a macOS home directory on a non-macOS
   machine. List them; delete nothing without asking.

6. Tell me to restart Claude Code, then give me the checks to run afterwards: `/context`
   should list the global CLAUDE.md and rules/session-continuity.md, and `/status` should
   show the model and effort level.

Do not modify anything under ./user, ./project-template, ./examples, or ./docs — that is
the version-controlled source of truth.
```

Expect `rules/documentation-accuracy.md` to be absent from `/context` until Claude reads a
markdown or docs file. It is path-scoped; that is correct, not a failed install.

---

## C — Onboard a project

Once B is done, this is a single command inside any repository:

```
/orchestration-onboard
```

Pass the path if your clone is not at `~/dev/claude-orchestrator`:

```
/orchestration-onboard ~/code/claude-orchestrator
```

It explores the codebase, asks you only for what the code cannot reveal, shows you the
proposed `CLAUDE.md` and rule globs, and writes nothing until you approve. For an existing
CLAUDE.md it shows a diff and tells you what would be lost.

For a repository that already uses `docs/adr/`, a root `DECISIONS.md`, or a `changelogs/`
directory, it keeps that convention and records it in `.claude/continuity.json` rather than
creating a competing one.

---

## Daily use

Nothing to invoke — the policy loads at every session start and Claude routes automatically.
Phrasings that steer it explicitly:

- *"Plan this yourself, then delegate the implementation in parallel slices."*
- *"Have reviewer look at the diff before you integrate."*
- *"Have verifier run the suite and report."*
- At the end of a working session: *"Write the session changelog."*

## Keeping machines in sync

```bash
git pull && node bootstrap.mjs install
```

`node bootstrap.mjs status` shows drift at any time. Locally edited files are skipped
rather than clobbered, so a machine-specific tweak survives until you resolve it with
`--force`.
