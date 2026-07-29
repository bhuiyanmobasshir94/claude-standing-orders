# Orchestrator–worker setup for Claude Code

One repository that produces an identical orchestrator–worker workflow on every machine —
Mac, Windows, Linux, or a server. Verified against the Claude Code documentation on
29 July 2026.

## Quick start

```bash
git clone <your-repo-url> claude-orchestrator
cd claude-orchestrator
node bootstrap.mjs install
node bootstrap.mjs doctor      # confirm this machine can actually run it
```

Then restart Claude Code and run `/context` to confirm the global `CLAUDE.md` and rules
loaded. `INSTALL.md` has prompts you can paste into Claude Code to do this and verify it for you.

`install` copies files and merges settings. `doctor` is the one that tells you whether the
result works here — version floor, hook paths, settings validity, agent definitions — and
exits non-zero so you can put it in a script. `status` compares file hashes and nothing more.

Requires Node 18+ and a Claude Code version at or above the floor in
`user/version-floor.json`. Below that floor several features this setup depends on fail
**silently**: worker nesting stops being capped, the concurrency cap is ignored, and `opus`
resolves to a model generation behind. The session brief warns and `doctor` checks.

## Layout

```
user/                          → installs into ~/.claude/
  CLAUDE.md                    the orchestrator–worker policy, loaded every session
  settings.template.json       merged into settings.json; __CLAUDE_HOME__ and
                               __MIN_VERSION__ resolved per machine
  version-floor.json           the Claude Code version floor — the only place it is stated
  agents/
    implementer.md             Sonnet · xhigh · project memory — substantive coding
    fast-implementer.md        Haiku — bounded mechanical changes
    reviewer.md                Sonnet · xhigh · read-only — findings with file:line
    verifier.md                Haiku · read-only — runs checks, reports evidence
  skills/
    worker-contract/           preloaded into every worker: Task Packet, report, BLOCKED
    orchestration-onboard/     /orchestration-onboard — sets up any repo for the workflow
  rules/
    session-continuity.md      changelog and decision-log format (always loaded)
    documentation-accuracy.md  verify-against-source rules (loads on docs and markdown)
  hooks/                       five hooks; all fail open, all exit 0 on every path
    session-brief.mjs          SessionStart — version warning, decisions, changelogs, routing
    packet-check.mjs           PreToolUse — warns you at dispatch when a Task Packet is thin
    worker-ledger.mjs          SubagentStop — one line per worker completion
    compact-state.mjs          PreCompact — snapshots workers and files before compaction
    verify-reminder.mjs        Stop — reminds when code changed but nothing was verified

project-template/              → stack-agnostic starting point for any repository
  CLAUDE.md                    fill-in template; judgment context, not a file tree
  settings.json                deny secrets and force-push, ask before push
  rules/                       security · data-and-migrations · reliability-and-performance

examples/
  django-celery-ses-banking/   a filled-in project layer, as a worked reference

CLAUDE.md                      project instructions for working on this repo itself
docs/DESIGN-RATIONALE.md       why the package is built the way it is
.gitignore                     project settings, ledger, worktrees, agent memory stay local
INSTALL.md                     prompts to paste into Claude Code
bootstrap.mjs                  cross-platform installer
verify-repo.mjs                structural invariants for this repo; exits 1 on failure
LICENSE                        MIT
```

## Why it is built this way

**Node, not shell.** Claude Code requires Node, so it exists on every machine that can run
this workflow. One `bootstrap.mjs` replaces a bash script plus a PowerShell script, and
behaves identically on all three platforms.

**Merge, never replace.** Your `settings.json` holds things this repo does not own — plugins,
marketplaces, a statusline. The installer deep-merges, concatenates hook arrays with
de-duplication, and writes a timestamped backup first.

**Aliases, not version numbers.** Agents pin `opus` / `sonnet` / `haiku`. Aliases track the
current recommended version; version numbers rot. The one number that is a real runtime
dependency rather than a model preference — the Claude Code version floor — lives in
`user/version-floor.json` and nowhere else. The installer substitutes it into settings, the
session brief warns against it, and `doctor` checks it. Nothing restates it in prose.

**Nothing fails silently if it can be made to fail loudly.** This package exists because
the expensive failures in an agent setup are the quiet ones: a config key that is ignored, a
hook that logs nothing, a check that passes because it had no data. `doctor` fails when it
cannot determine an answer rather than passing, and the session brief reports when the
worker ledger has recorded nothing at all.

**Contracts where they are guaranteed to land.** Subagents receive the `CLAUDE.md`
hierarchy but not your conversation, auto memory, or output style. Anything a worker must
obey lives either in its own definition or in the preloaded `worker-contract` skill, never
in a file that might not reach it.

**Continuity in committed files.** Auto memory is machine-local and does not sync. Anything
another machine needs to know is a file in the repository, surfaced at session start by the
`session-brief` hook.

**Conventions discovered, not imposed.** The hook finds a repository's changelog and
decision log across the common layouts — `docs/changelogs/`, `docs/adr/`, a root
`DECISIONS.md` — or reads `.claude/continuity.json` when a project declares its own. No
repository has to adopt a directory name to benefit.

## Commands

```bash
node bootstrap.mjs help             # usage; writes nothing
node bootstrap.mjs install          # install or update
node bootstrap.mjs install --dry-run
node bootstrap.mjs install --force  # overwrite locally modified files
node bootstrap.mjs status           # file drift against this repo (hashes only)
node bootstrap.mjs doctor           # does the install work here? exits 1 on failure
node bootstrap.mjs uninstall        # show what would be removed; writes nothing
node bootstrap.mjs uninstall --yes  # actually remove it
```

`install` is the default command, so an unrecognized flag aborts rather than quietly
installing. A file you edited locally is skipped, never clobbered, and `doctor` reports it
as kept rather than as a failure.

## Removing it again

`uninstall` removes what this package installed and nothing else. Ownership comes from the
install manifest, not from a guess: a file is removed only if it is still byte-identical to
what was written here, and a settings value only if it still exactly equals what the
template installed. Anything you edited is yours — it stays, and is reported.

That means your own agents survive, a plugin's hook sitting in the same `SessionStart` array
survives, and your own `permissions.ask` rules survive while ours leave. Directories go only
once they are empty. A timestamped backup of `settings.json` is written first.

Without `--yes` it prints the plan and writes nothing, so you approve the exact text that
will then be executed. With no manifest it refuses outright rather than deleting by name.

One thing it cannot undo: if you had `model` or another template key set to your own value
*before* the first install, the merge overwrote it and kept no record. Uninstall removes the
key rather than restoring your value. The backups are the recovery path.

## Turning on the verification reminder

The `Stop` hook is inert until a project opts in. Add its real commands to that project's
`.claude/continuity.json`:

```json
{ "verifyCommands": ["make test", "make lint"] }
```

Without the key the hook does nothing, in every project. That is deliberate: a reminder
that guesses which command counts as verification would fire on projects that verified
correctly, and a nag you learn to ignore is worse than no nag. `/orchestration-onboard`
fills this in for you.

## License

MIT — see [LICENSE](LICENSE).
