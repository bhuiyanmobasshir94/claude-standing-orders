# Orchestrator–worker setup for Claude Code

One repository that produces an identical orchestrator–worker workflow on every machine —
Mac, Windows, Linux, or a server. Verified against the Claude Code documentation on
27 July 2026.

## Quick start

```bash
git clone <your-repo-url> claude-orchestrator
cd claude-orchestrator
node bootstrap.mjs install
```

Then restart Claude Code and run `/context` to confirm the global `CLAUDE.md` and rules
loaded. `INSTALL_PROMPT.md` has a prompt you can paste into Claude Code to do this and
verify it for you.

Requires Claude Code **v2.1.219+** (Opus 5) and Node 18+.

## Layout

```
user/                          → installs into ~/.claude/
  CLAUDE.md                    the orchestrator–worker policy, loaded every session
  settings.template.json       merged into settings.json; __CLAUDE_HOME__ resolved per machine
  agents/
    implementer.md             Sonnet · xhigh · project memory — substantive coding
    fast-implementer.md        Haiku — bounded mechanical changes
    reviewer.md                Sonnet · xhigh · read-only — findings with file:line
    verifier.md                Haiku · read-only — runs checks, reports evidence
  skills/worker-contract/      preloaded into every worker: Task Packet, report, BLOCKED
  rules/
    session-continuity.md      changelog and decision-log format (always loaded)
    documentation-accuracy.md  verify-against-source rules (loads on docs and markdown)
  hooks/
    session-brief.mjs          SessionStart — injects decisions + recent changelogs
    worker-ledger.mjs          SubagentStop — one line per worker completion

project/                       → copy into a repository's .claude/ and root
  CLAUDE.md                    Email Service backend: scale profile + non-negotiables
  settings.json                deny/ask rules for secrets, force-push, migrations
  rules/                       security · data-and-migrations · async-and-scale

docs/CHANGES-AND-RATIONALE.md  what changed from the previous setup and why
INSTALL_PROMPT.md              prompts to paste into Claude Code
bootstrap.mjs                  cross-platform installer
```

## Why it is built this way

**Node, not shell.** Claude Code requires Node, so it exists on every machine that can run
this workflow. One `bootstrap.mjs` replaces a bash script plus a PowerShell script, and
behaves identically on all three platforms.

**Merge, never replace.** Your `settings.json` holds things this repo does not own — plugins,
marketplaces, a statusline. The installer deep-merges, concatenates hook arrays with
de-duplication, and writes a timestamped backup first.

**Aliases, not version numbers.** Agents pin `opus` / `sonnet` / `haiku`. Aliases track the
current recommended version; version numbers rot. Model versions appear in exactly one file
in this repo — `docs/CHANGES-AND-RATIONALE.md` — and never in config.

**Contracts where they are guaranteed to land.** Subagents receive the `CLAUDE.md`
hierarchy but not your conversation, auto memory, or output style. Anything a worker must
obey lives either in its own definition or in the preloaded `worker-contract` skill, never
in a file that might not reach it.

**Continuity in committed files.** Auto memory is machine-local and does not sync. Anything
another machine needs to know is a file in the repository, surfaced at session start by the
`session-brief` hook.

## Commands

```bash
node bootstrap.mjs install          # install or update
node bootstrap.mjs install --dry-run
node bootstrap.mjs install --force  # overwrite locally modified files
node bootstrap.mjs status           # show drift against this repo
```
