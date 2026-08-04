# Standing orders for Claude Code

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-18%2B-brightgreen.svg)](https://nodejs.org)

A standing instruction set that applies to every project and every session on a machine.
Claude Code keeps investigation and design on the main thread, hands implementation to
cheaper workers under a written contract, and treats *it passes* as a claim that has to
arrive with the command and its output attached.

One repository, one Node installer, the same behaviour on macOS, Windows, Linux, and a
server you SSH into. Verified against the Claude Code documentation on 29 July 2026.

**This is policy you install, not a framework you run.** No runtime, no daemon, no SDK,
nothing to import, and no wrapper around the CLI. `bootstrap.mjs` writes a `CLAUDE.md`,
four agent definitions, two skills, two rules, and seven hooks into `~/.claude/`, merges
what it needs into your existing `settings.json` rather than replacing it, and then gets
out of the way — after which Claude Code behaves this way everywhere, including in
repositories that have never heard of this one.

## Who it is for

Codebases where being wrong is expensive and someone eventually asks how a change was
made: money, migrations, PII, auth, anything that gets audited. The habits that follow
from working on them — read the real diff rather than the summary of it, run the real
command, write down the decision so the next session does not re-litigate it — are the
ones this package makes structural instead of aspirational.
`examples/django-celery-ses-banking/` is a worked project layer for that kind of
repository, and `project-template/rules/` carries the security, migration, and
reliability rules it builds on.

None of it is domain-specific, so it works on an ordinary application repo too. On a
weekend project it will feel like overhead, and it is.

## Requirements

- Node 18+. `bootstrap.mjs` warns if the running Node is older, but installs anyway.
- A Claude Code version at or above the floor in `user/version-floor.json`. Below that
  floor several features this setup depends on fail **silently**: worker nesting stops
  being capped, the concurrency cap is ignored, and `opus` resolves to a model generation
  behind. The session brief warns and `doctor` checks.

## Quick start

```bash
git clone https://github.com/bhuiyanmobasshir94/claude-standing-orders
cd claude-standing-orders
node bootstrap.mjs install
node bootstrap.mjs doctor      # confirm this machine can actually run it
```

Then restart Claude Code and run `/context` to confirm the global `CLAUDE.md` and rules
loaded. `INSTALL.md` has prompts you can paste into Claude Code to do this and verify it for you.

`install` copies files and merges settings. `doctor` is the one that tells you whether the
result works here — version floor, hook paths, settings validity, agent definitions — and
exits non-zero so you can put it in a script. `status` compares file hashes and nothing more.

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
  hooks/                       seven hooks; all fail open, all exit 0 on every path
    session-brief.mjs          SessionStart — version warning, decisions, changelogs, routing, context
    packet-check.mjs           PreToolUse (Agent) — warns you at dispatch when a Task Packet is thin
    big-read-guard.mjs         PreToolUse (Read) — warns before an unbounded read of a large file
    worker-ledger.mjs          SubagentStop — one line per worker completion
    compact-state.mjs          PreCompact — snapshots workers and files before compaction
    verify-reminder.mjs        Stop — reminds when code changed but nothing was verified
    context-cost.mjs           Stop — warns when the session's context crosses 200K, then 400K, tokens

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

**Context is the dominant cost, and a session cannot see that from the inside.** On one real
install measured over three days, cache read and cache write — context sent and re-sent,
not new work — were 88.4% of token spend:

| Bucket | Share of cost |
| --- | ---: |
| cache read (context re-send) | 60.3% |
| cache write (new context) | 28.1% |
| output (all assistant tokens) | 11.5% |
| uncached input | 0.1% |

One session in that window ran 861 turns, grew from 33K to 719K context tokens, compacted
essentially once, and was 64% of the three-day total by itself — not because any single turn
was expensive, but because the whole accumulated context re-bills on every turn after it
lands. `big-read-guard.mjs` warns before an unbounded read of a file at or above 50,000
bytes (`CLAUDE_BIG_READ_BYTES`) adds to that; `context-cost.mjs` warns when the running
total crosses 200,000 tokens (`CLAUDE_CONTEXT_WARN_TOKENS`), then again at 400,000
(`CLAUDE_CONTEXT_ALERT_TOKENS`). Both warn and never block, for the same reason
`verify-reminder.mjs` does not: a gate that blocks legitimately large, necessary work gets
switched off within a week, and switching it off removes the warning too.

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

## Contributing

Verify a change before opening a pull request:

```bash
node verify-repo.mjs                # structural invariants for the source in this repo
node bootstrap.mjs doctor           # confirms an installed copy actually works
for f in bootstrap.mjs user/hooks/*.mjs; do
  node --check "$f" || echo "FAILED: $f"
done
```

`node --check` reads only its first argument and silently ignores the rest, so a single
invocation listing every file reports success even when a later one is broken — loop, or
check one file at a time. Every tracked `.json` must parse, and every agent or skill file's
YAML frontmatter must be valid; `verify-repo.mjs` checks both. For a hook change, exercise
the real path — pipe a payload through the hook and read back what it wrote. zsh's builtin
`echo` expands `\n` before the hook sees it, which silently breaks a synthetic JSON payload;
use `printf '%s'` instead, and pass `cwd` so any file the hook writes lands where you expect.

Conventions this repo enforces on itself, and that a pull request is expected to match:

- **Aliases, never version numbers, in agent config.** `opus` / `sonnet` / `haiku`, not a
  dated model name. The one exception is the Claude Code version floor, which lives in
  `user/version-floor.json` and nowhere else.
- **No `effort` field on a `model: haiku` agent.** Haiku does not support effort levels; the
  setting would be silently ignored, which asserts a guarantee the runtime never provides.
- **Nothing personal ships.** No real names, absolute home paths, private project names, or
  content from a private conversation, in any file including docs and comments.
- **Hook paths are generated, not committed.** `settings.template.json` carries
  `__CLAUDE_HOME__`; `bootstrap.mjs` resolves it per machine.
- **Observability hooks fail open.** Every hook in `user/hooks/` must exit 0 on every path,
  including malformed input, and none of them may block *even where the event would allow
  it*: `packet-check.mjs` and `big-read-guard.mjs` run on `PreToolUse` and must never emit
  `permissionDecision: "deny"` or `updatedInput`, and `compact-state.mjs`,
  `verify-reminder.mjs`, and `context-cost.mjs` must never emit a blocking `decision` though
  `PreCompact` and `Stop` both permit one. `verify-reminder.mjs` is additionally inert unless
  a project opts in via `verifyCommands` — it must never infer verification commands.
- **A hook is not verified until its real payload has been seen.** Exercise a change against
  a payload captured from a live run, not a hand-written guess — `verify-repo.mjs` pins the
  fields each hook depends on for exactly this reason.
- **`Stop` fires every assistant turn, not once per session.** Anything hooked there scans
  incrementally from a saved offset and short-circuits before doing real work.
- **After changing anything under `user/`, sync this machine:** `node bootstrap.mjs install`
  then `node bootstrap.mjs doctor`. A fix committed here but not installed is not active
  anywhere.

This repository is itself the distributable package, not a project built with it, so it
keeps no changelog, decision log, or agent memory of its own — describe what changed and
why in the commit message instead.

## License

MIT — see [LICENSE](LICENSE).
