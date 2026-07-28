# Decisions

Standing decisions that constrain future work on this repository — the choices a future
session should not re-litigate without first reading why they were made. Newest entries at
the bottom. Each entry: date, the decision, why, and what it rules out. See
`user/rules/session-continuity.md` for the format this file follows.

---

**2026-07-28 — Workers are pinned by capability alias, never by version number.**
Agents specify `model: opus` / `sonnet` / `haiku`; version numbers appear only in
`docs/CHANGES-AND-RATIONALE.md`. Aliases track the current recommended version, so a config
that names a version rots the moment Anthropic ships a new one.
Rules out: per-agent version pinning in agent frontmatter or settings.

**2026-07-28 — No `effort` field on Haiku-tier agents (`fast-implementer`, `verifier`).**
Haiku does not support effort levels at all; setting one is a silent no-op that asserts a
guarantee the runtime never provides. See `docs/CHANGES-AND-RATIONALE.md` §1.1.
Rules out: "xhigh everywhere" as a uniform policy across worker tiers.

**2026-07-28 — One writer per file, ever.**
Fan out only across disjoint file sets; use `isolation: worktree` when a change is risky or
slices might collide. Concurrent writers to a shared file lose edits — there is no merge
step that reconciles two workers editing the same file.
Rules out: concurrent workers writing to a shared file, at any concurrency level.

**2026-07-28 — Worker reports name files and describe changes; they do not paste diffs.**
The reason to delegate is that a worker's verbose output stays in its own context. Pasting
diffs back into the report spends exactly the context that delegation was meant to buy; the
orchestrator runs `git diff` itself when it needs detail.
Rules out: diff-in-report as a reporting format.

**2026-07-28 — The worker contract ships as a preloaded skill, not a rules file.**
Subagents receive the full `CLAUDE.md` hierarchy at startup but not the conversation, auto
memory, or output style. `worker-contract` is preloaded via each agent's `skills:` field so
its content is guaranteed to reach the worker, rather than hoping a rules file propagates.
Rules out: relying on rule-file propagation to carry contract obligations to workers.

**2026-07-28 — Continuity lives in committed files, not machine-local memory.**
`docs/changelogs/` and `docs/decisions/DECISIONS.md` travel with the repository, so a
session on a server reads the same history as a session on a laptop. Auto memory lives under
`~/.claude/projects/<project>/memory/` and never syncs.
Rules out: machine-local auto memory as the continuity mechanism for cross-machine history.

**2026-07-28 — The installer merges into `settings.json`; it never replaces it.**
A user's `settings.json` holds things this repo does not own — plugins, marketplaces, a
statusline. `bootstrap.mjs` deep-merges, concatenates hook arrays with de-duplication, and
writes a timestamped backup before writing.
Rules out: an installer that overwrites or clobbers an existing `settings.json`.

**2026-07-28 — Hook paths are generated per machine from `__CLAUDE_HOME__`, never committed as absolute paths.**
A hardcoded `/Users/<name>/.claude/hooks/...` path breaks on Linux, Windows, or a server.
`settings.template.json` carries the placeholder; `bootstrap.mjs` resolves it at install
time on each machine.
Rules out: committing machine-specific absolute paths in any config file.

**2026-07-28 — Observability hooks fail open; authorization and validation paths fail closed.**
`session-brief.mjs` and `worker-ledger.mjs` exit 0 on every failure path — a broken brief or
ledger write must never block a session. This is the opposite default from a permission or
validation boundary, which takes the rejecting branch under ambiguity. Same fail-closed
principle, applied to two different kinds of boundary.
Rules out: a logging or metrics hook that can break or slow a session when it fails.

**2026-07-28 — The worker ledger (`.claude/worker-ledger.jsonl`) is gitignored, not committed.**
Decided this session, resolving a standing contradiction: `orchestration-onboard/SKILL.md`
already instructed every onboarded project to gitignore the ledger, but this repository had
committed it anyway (commit `92b735e`) and shipped no `.gitignore` at all. The ledger is
machine-local worker history, regenerated per session, not a record meant to be reviewed or
diffed like source. See `docs/CHANGES-AND-RATIONALE.md` for the fuller writeup.
Rules out: treating the worker ledger as shared, reviewable project history.

**2026-07-28 — `.claude/continuity.json` is not added to this repository.**
Its defaults (`docs/changelogs/`, `docs/decisions/DECISIONS.md`) already match what
`session-brief.mjs` discovers by convention scanning, so declaring them explicitly would be
redundant. The file exists for projects that use a different convention — `docs/adr/`, a
root `DECISIONS.md` — and need to point the hook at it.
Rules out: adding a declaration file that restates the tool's own defaults.
