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

4. Run `node bootstrap.mjs doctor` and show me every check with its result. It covers file
   drift, the Claude Code version floor, settings.json validity, hook path resolution,
   agent skill resolution, and effort declared on a model that does not support it. A
   non-zero exit means something is wrong — do not report success over it. Then confirm
   separately that ~/.claude/agents/ contains implementer, fast-implementer, reviewer, and
   verifier, and that ~/.claude/settings.json still contains every key it had before.

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

## What the install adds to your settings.json

Five hooks. Every one is an observability surface: it exits 0 on every path, including
malformed input, and none of them can block a session. If any of them breaks, the session
still runs.

| Hook | Event | What it does | Silent when |
| --- | --- | --- | --- |
| `session-brief.mjs` | SessionStart | Warns if Claude Code is below the version floor; injects standing decisions, recent changelogs, and a worker routing signal | the repo has no continuity files and the version is fine |
| `packet-check.mjs` | SubagentStart | Tells a worker which Task Packet fields its dispatch omitted | the packet is complete, or the worker is `verifier` |
| `worker-ledger.mjs` | SubagentStop | Appends one metadata line per worker completion | the subagent is a built-in read-only one |
| `compact-state.mjs` | PreCompact | Snapshots dispatched workers and files written, so compaction does not erase the integration picture | no workers ran and nothing was written |
| `verify-reminder.mjs` | Stop | Reminds you when code changed but no declared verification command ran | **always, unless a project sets `verifyCommands`** |

The last one is opt-in per project. Add the real commands to that project's
`.claude/continuity.json` and nothing else:

```json
{ "verifyCommands": ["make test", "make lint"] }
```

Without that key the hook does nothing at all. It never guesses which command counts as
verification, because a reminder that fires on projects that *did* verify is one you switch
off — and switching it off removes the reminder for the projects that need it.

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
`--force`. `status` compares file hashes and nothing more — run `node bootstrap.mjs doctor`
to check that the install actually works on this machine.

## Removing it from a machine

```bash
node bootstrap.mjs uninstall         # prints the plan, writes nothing
node bootstrap.mjs uninstall --yes   # applies exactly that plan
```

It removes only what it installed. The manifest written at install time records the hash of
every file this package wrote; a file is removed only if it still matches, and a settings
value only if it still equals what the template installed. Everything else — your own
agents, another plugin's hooks in the same array, your own permission rules, a hook script
you edited — is kept and listed.

`settings.json` is backed up first. Deleting `~/.claude` by hand does the same job far less
carefully: it takes your plugins, projects, and history with it.

## Hard version enforcement (optional, requires root — not installed)

This setup depends on Claude Code features with version floors, recorded in
`user/version-floor.json`. Below the floor they fail silently: worker nesting is
uncapped, the concurrency cap is ignored, and `opus` resolves to a model generation behind.

`minimumVersion` in user settings — which `bootstrap.mjs` installs — stops an *update* from
going below the floor. It does not stop an already-old install from running. To make Claude
Code refuse to start below the floor, an administrator adds `requiredMinimumVersion` to
managed settings:

| Platform  | Managed settings file |
| --------- | --------------------- |
| macOS     | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux/WSL | `/etc/claude-code/managed-settings.json` |
| Windows   | `C:\Program Files\ClaudeCode\managed-settings.json` |

```json
{ "requiredMinimumVersion": "2.1.219" }
```

Managed settings override every other scope and cannot be relaxed per project. The setting
fails open on a malformed value — an invalid entry is stripped rather than enforced, so a
bad policy push cannot stop Claude Code from starting — and `claude update`, `claude
install`, and `claude doctor` keep working below the floor so a machine can recover.

`bootstrap.mjs` does not write this file. It needs root, it affects every user on the
machine, and it is a policy decision rather than an install step.
