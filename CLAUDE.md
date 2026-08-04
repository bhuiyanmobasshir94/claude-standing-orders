# claude-standing-orders

This repository **is** the orchestrator–worker package. `user/` installs into `~/.claude/`
on every machine, so a change here changes how Claude Code behaves everywhere the package
is installed — not just in this checkout.

## This repo does not keep a changelog, a decision log, or agent memory

Deliberate exception to `rules/session-continuity.md`, which this package itself ships and
which remains correct for every *other* repository. The reasons are specific to this one:

- It is a distributable package, not a codebase a team works in day to day. A maintainer's
  session narrative would ship to everyone who clones it.
- `docs/DESIGN-RATIONALE.md` already records why the package is shaped the way it is.
  A decision log alongside it would be a second home for the same facts.
- A repository with no continuity files produces no session brief. That is
  `session-brief.mjs` behaving as documented, not a gap to fix.

So: **do not create `docs/changelogs/`, `docs/decisions/`, or `.claude/agent-memory/` here.**
`.gitignore` already blocks the last one. Record what changed and why in the commit message.

## Product references are not this repo's own usage

`user/`, `project-template/`, `examples/`, and `INSTALL.md` mention `docs/changelogs/`,
`docs/decisions/DECISIONS.md`, `docs/adr/`, and `.claude/continuity.json` throughout. Those
describe what *onboarded projects* do. They are the product. Removing them to make the repo
"consistent" breaks the package. When unsure whether a reference is product or this repo's
own practice, it is product — leave it.

## Conventions

- **Aliases, never version numbers, in agent config.** Agents pin `opus` / `sonnet` /
  `haiku`. The one exception is the Claude Code version floor, which is a real runtime
  dependency rather than a model choice: it lives in `user/version-floor.json` and nowhere
  else. `bootstrap.mjs` substitutes it into `settings.template.json` at install time
  (`__MIN_VERSION__`), `session-brief.mjs` warns against it, and `bootstrap.mjs doctor`
  checks it. Never restate the number in prose — reference the file.
- **No `effort` field on a `model: haiku` agent.** Haiku does not support effort levels; the
  setting is silently ignored, which asserts a guarantee the runtime never provides.
- **Nothing personal ships.** No real names, absolute home paths, private project names, or
  content from a private conversation — in any file, including docs and comments.
- **Hook paths are generated, not committed.** `settings.template.json` carries
  `__CLAUDE_HOME__`; `bootstrap.mjs` resolves it per machine.
- **Observability hooks fail open.** `session-brief.mjs`, `worker-ledger.mjs`,
  `packet-check.mjs`, `compact-state.mjs`, and `verify-reminder.mjs` must exit 0 on every
  path, including malformed input. There is no authorization boundary among them, and none
  of them may block even where the event would allow it: `packet-check.mjs` runs on
  `PreToolUse` and must never emit `permissionDecision: "deny"`, and `compact-state.mjs` and
  `verify-reminder.mjs` must never block, though `PreCompact` and `Stop` both permit it.
  `verify-reminder.mjs` is additionally inert unless a project opts in via `verifyCommands`
  — it must never infer verification commands.
- **A hook is not verified until its real payload has been seen.** `packet-check.mjs` shipped
  reading a `prompt_text` field that no Claude Code release ever sent, and every static check
  in this repo passed while it did nothing. Exercise a hook against a payload captured from a
  live run — `verify-repo.mjs` pins the fields each one depends on for exactly this reason.
- **`Stop` fires every assistant turn, not once per session.** Anything hooked there scans
  incrementally from a saved offset and short-circuits before doing real work.
- **No subprocess on the session-start path.** `session-brief.mjs` derives the Claude Code
  version from `CLAUDE_CODE_EXECPATH` and stays silent when it cannot. `claude --version`
  costs 0.26–1.5s and belongs in `doctor`, which the user ran on purpose.

## After changing anything under `user/`

The installed copy in `~/.claude/` does not update itself. Run:

```bash
node bootstrap.mjs status     # show drift (file hashes only)
node bootstrap.mjs install    # sync this machine
node bootstrap.mjs doctor     # confirm the install actually works; exits 1 on failure
```

A fix committed here but not installed is not active anywhere.

## Verifying a change

```bash
for f in bootstrap.mjs user/hooks/*.mjs; do
  node --check "$f" || echo "FAILED: $f"
done
```

`node --check` takes a single file and **silently ignores every argument after the first**,
so passing all three in one invocation reports success even when the second or third is
broken. Loop, or invoke it once per file.

Every tracked `.json` must parse, and every agent file's YAML frontmatter must be valid. For
hook changes, exercise the real path — pipe a payload through the hook and read back what it
wrote. Note that zsh's builtin `echo` expands `\n` before the program sees it, which silently
breaks synthetic JSON payloads; use `printf '%s'` instead, and pass `cwd` so the write lands
in the project root you expect.
