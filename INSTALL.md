# Instructions

Two prompts. Run **A** once per machine, **B** once per project.
Each is written to be pasted verbatim into Claude Code.

---

## A — Install or update a machine

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

## B — Onboard a project

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
