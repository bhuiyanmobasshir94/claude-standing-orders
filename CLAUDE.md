# claude-orchestrator

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

- **Aliases, never version numbers, in config.** Agents pin `opus` / `sonnet` / `haiku`.
  Model versions and version floors appear in `docs/DESIGN-RATIONALE.md` and nowhere else.
- **No `effort` field on a `model: haiku` agent.** Haiku does not support effort levels; the
  setting is silently ignored, which asserts a guarantee the runtime never provides.
- **Nothing personal ships.** No real names, absolute home paths, private project names, or
  content from a private conversation — in any file, including docs and comments.
- **Hook paths are generated, not committed.** `settings.template.json` carries
  `__CLAUDE_HOME__`; `bootstrap.mjs` resolves it per machine.
- **Observability hooks fail open.** `session-brief.mjs` and `worker-ledger.mjs` must exit 0
  on every path, including malformed input. A broken hook must never block a session.

## After changing anything under `user/`

The installed copy in `~/.claude/` does not update itself. Run:

```bash
node bootstrap.mjs status     # show drift
node bootstrap.mjs install    # sync this machine
```

A fix committed here but not installed is not active anywhere.

## Verifying a change

```bash
for f in bootstrap.mjs user/hooks/session-brief.mjs user/hooks/worker-ledger.mjs; do
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
