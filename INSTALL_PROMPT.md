# Install prompt

Paste the block below into Claude Code on any machine — Mac, Windows, Linux, or a server —
from the directory containing this repository. It is written to be run verbatim.

---

```
Install the orchestrator–worker setup in this directory onto this machine.

1. Confirm the environment first, and stop and tell me if either check fails:
   - `claude --version` reports 2.1.219 or later (Opus 5 requires it). If it is older,
     tell me to run `claude update` before continuing.
   - `node --version` reports 18 or later.

2. Run `node bootstrap.mjs install`. Do not edit my existing settings by hand — the
   script merges non-destructively and writes a timestamped backup. If it reports files
   skipped as locally modified, show me the diff for each and ask before using --force.

3. Verify the install and report the results as a short table:
   - `node bootstrap.mjs status` shows everything in sync
   - `~/.claude/agents/` contains implementer, fast-implementer, reviewer, verifier
   - `~/.claude/skills/worker-contract/SKILL.md` exists
   - `~/.claude/settings.json` parses as valid JSON, and still contains every key it had
     before the install
   - the two hook commands in settings.json point at paths that exist on THIS machine

4. Report any hook entry in settings.json whose command path does not exist here —
   specifically anything pointing at a macOS home directory on a non-macOS machine.
   List them; do not delete anything without asking.

5. Tell me to restart Claude Code, and give me the exact checks to run afterwards to
   confirm it loaded: `/context` should list the global CLAUDE.md and both rules files,
   and `/status` should show the settings source and the model.

Do not modify anything under ./user, ./project, or ./docs — that is the source of truth
and it is version-controlled.
```

---

## Per-project setup

Run this once in each repository you want under the workflow:

```
Set up this repository for the orchestrator–worker workflow.

1. Create these if they do not exist, and tell me which you created:
   - .claude/rules/          (project rules)
   - docs/changelogs/        (one file per session)
   - docs/decisions/DECISIONS.md   (standing decisions; seed with a header if new)

2. If this is the Email Service backend, copy project/CLAUDE.md, project/settings.json,
   and project/rules/*.md from the orchestrator repo into place, and show me a diff
   against the existing CLAUDE.md before overwriting it.

   For any other repository, read the existing CLAUDE.md and propose a version that
   follows the same shape: non-negotiables and judgment context in CLAUDE.md, detailed
   standards split into path-scoped .claude/rules/ files. Show me the plan first; write
   nothing until I approve it.

3. Add to .gitignore:  .claude/settings.local.json
   Then tell me whether I want .claude/agent-memory/ committed. Recommend committing it:
   it is how reviewer and implementer knowledge follows the repo between machines.

4. Confirm with /context that the project CLAUDE.md and rules loaded.
```

## Daily use

Nothing to invoke — the policy is loaded at every session start, and Claude routes
automatically. Three phrasings that steer it explicitly when you want to:

- *"Plan this yourself, then delegate the implementation in parallel slices."*
- *"Have reviewer look at the diff before you integrate."* — always worth it on auth,
  credentials, migrations, and money paths.
- *"Have verifier run the suite and report."* — keeps a slow, noisy test run out of the
  main conversation.

At the end of a working session: *"Write the session changelog."*

## Updating every machine

The repository is the single source of truth. On each machine:

```bash
git pull
node bootstrap.mjs install
```

`node bootstrap.mjs status` shows drift at any time. Files you edited locally are skipped
rather than clobbered, so a machine-specific tweak survives until you resolve it deliberately
with `--force`.
