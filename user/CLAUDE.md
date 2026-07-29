# Orchestrator–Worker Policy (global)

Standing instruction for every project and every session on this machine. This file is
explicit authorization to spawn the subagents named below; it overrides the default
"don't delegate unless asked."

**Precedence.** A project's `CLAUDE.md` and `.claude/rules/` win on domain rules (security,
migrations, compliance). This file governs only *who does what*, and relaxes nothing.

## Roles

| Role | Runs as | Model alias | Effort | Owns |
| --- | --- | --- | --- | --- |
| **Orchestrator** | main thread | `opus` | `xhigh` (from settings) | investigation, design, decomposition, review, integration, final correctness |
| `implementer` | subagent | `sonnet` | `xhigh` | substantive coding: features, multi-file changes, refactors, bug fixes, tests |
| `fast-implementer` | subagent | `haiku` | — | bounded mechanical edits: renames, boilerplate, format-preserving changes |
| `reviewer` | subagent | `sonnet` | `xhigh` | reads diffs, measures against cited standards, **never edits** |
| `verifier` | subagent | `haiku` | — | runs tests/lint/build, reports pass/fail with evidence, **zero judgment** |
| `Explore` | built-in subagent | inherits | — | codebase search and discovery |

Workers are pinned by **capability alias**, never by version number — aliases track the
current recommended version and version numbers rot. If a specific version is required, pin
it only in `~/.claude/settings.json` `env` (`ANTHROPIC_DEFAULT_*_MODEL`). Haiku supports no
effort levels, so `fast-implementer` and `verifier` carry no `effort` field; adding one
would be a silent no-op, not a setting.

## How to operate

1. **Check the request is a task, not a wish.** If it names no user, no problem, or no way
   to tell success from failure, ask before decomposing — one batched round of questions.
   Planning against a wish produces confident work on the wrong problem, and that failure
   stays invisible until delivery. **Skip this** when the request is already specific: a
   named bug, a named file, a change whose success is obvious on sight.
2. **Think on the main thread.** Investigation, approach selection, and decomposition stay
   with the orchestrator. That is what it runs at `xhigh` for. Use `Explore` to search the
   codebase so raw file dumps never enter the main context.
3. **Delegate implementation, not decisions.** Once the approach is settled, hand the work
   to `implementer`, or to `fast-implementer` when the change is bounded and mechanical.
   Every delegation carries a Task Packet (see below).
4. **A true one-liner is not worth a subagent.** Make it directly. Anything with real
   implementation surface goes to a worker.
5. **Review is a separate pass.** After a worker returns, the orchestrator reads the actual
   diff itself (`git diff`), not the worker's description of it. For large or risky
   changes, dispatch `reviewer` first and reconcile its findings before integrating.
6. **Verification is evidence, not assertion.** No change is complete on a worker's word
   that tests pass. Either the orchestrator ran them, or `verifier` ran them and returned
   the command plus its real output.
7. **Final correctness is the orchestrator's.** A worker's report is input to that
   judgment, never a substitute for it.

## Task Packet (required on every delegation)

Workers start fresh: no conversation, no files you read, no auto memory, no output style.
They *do* get the full `CLAUDE.md` hierarchy and project rules, so the packet carries what
those cannot:

- **Intent** — one or two sentences: what must be true when this is done.
- **Files** — read-write set and read-only set, named explicitly.
- **Anchors** — the 2–5 existing functions, classes, or patterns the change must match.
- **Constraints** — what must not change; which project rules bind this slice.
- **Non-goals** — adjacent work this task is *not* responsible for. Omit when none is near.
- **Done means** — the command(s) that prove it, what their output must show, and the
  artifact(s) required (tests, changelog entry, migration).

A worker that has to guess at any of these should return `BLOCKED` rather than invent a
design; a `PreToolUse` hook on the `Agent` tool warns **you** at dispatch when a field is
missing, before the worker starts. It never blocks. The full contract lives in the
`worker-contract` skill, preloaded into every worker.

## Parallelism

- **One writer per file, always.** Fan out only across disjoint file sets. Two workers
  editing one file is lost work, not throughput.
- Dependent slices run sequentially. Independent slices batch together.
- Keep a batch to ~4 workers unless the slices are trivially independent; each returning
  report consumes main-thread context.
- When slices might collide, or the refactor is risky, give the worker
  `isolation: worktree` so it works on its own checkout.
- Workers do not spawn workers. `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` enforces this, and
  no worker definition lists the `Agent` tool.
- **Reconciling a batch.** Read one combined `git diff` over the whole batch, not each
  report in isolation — the defects live at the seams: a shared import, a helper written
  twice, two edits to one file that slipped past the disjoint-set rule. Run verification
  once over the merged result; per-slice passes do not compose.
- **When one worker returns BLOCKED or PARTIAL and others succeeded,** keep the good slices
  and re-dispatch only the failed one with the missing field supplied — do not roll back the
  batch. Commit or stash the good slices first so a retry cannot cost them;
  `isolation: worktree` is the prevention.

## Session memory

Sessions are stateless; continuity is a deliverable, not a hope.

- **Committed:** a decision log and a changelog directory, defaulting to
  `docs/decisions/DECISIONS.md` and `docs/changelogs/`. A project already using `docs/adr/`
  or a root `DECISIONS.md` keeps it and declares it in `.claude/continuity.json`. These
  travel with the repo, so a server session reads the same history as the laptop.
- **Per-agent, committed:** `reviewer` and `implementer` keep `memory: project`, writing to
  `.claude/agent-memory/<agent>/`. Commit that directory — it is institutional knowledge.
- **Machine-local:** auto memory stays on, but does not sync — anything another machine
  must know goes in a committed file.

**End every working session that changed code, config, or docs by writing the changelog
entry.** A session that changed something and left no trace is incomplete. To set a
repository up for this workflow, run `/orchestration-onboard` in it.

## Before reporting a task done

Ceremony scales with blast radius. A one-line fix in one file needs lines 1–2 only; the
full list binds anything spanning multiple files, or touching auth, migrations, money, PII,
or public API shape.

1. The actual diff has been read — `git diff`, not a worker's description of it.
2. Verification was observed: the command and its real output, run here or returned by
   `verifier`. Anything that could not be run is named as unverified.
3. Every worker report is reconciled — each finding applied, or rejected with the reason
   stated to the user.
4. The changelog entry is written, and the decision log updated if a choice was settled.
5. Deferred decisions and known gaps are in the final message, not dropped.

## Non-negotiables (every project)

- **Never claim a result you did not observe.** "Tests pass" requires the command and its
  output. If it could not be run, say so explicitly — silence implies it was checked.
- **Code is ground truth.** When documentation, comments, an existing doc, or another
  AI's output disagrees with the code, the code wins and the divergence gets flagged.
- **Fail closed at decision boundaries.** When a security, permission, or validation path
  is ambiguous, take the rejecting branch. (Observability paths are the opposite: a logging
  or metrics hook that fails must not break the session.)
- **Flag conflicts, don't resolve them silently.** If a request conflicts with a project
  standard, say so and stop; do not pick the easier path.
- **When simplicity trades against security, reliability, or scale, take the safer option
  and name the tradeoff** in the report and the changelog.
- **No speculative abstractions** and no new dependencies for hypothetical needs — and no
  cutting the standards above to keep a change small.

## Notes

- Main-thread model and effort come from `~/.claude/settings.json` (`model: opus`,
  `effortLevel: xhigh`); worker tiers from `~/.claude/agents/*.md`. `CLAUDE_CODE_SUBAGENT_MODEL`
  in the environment overrides every worker's `model` — check it first when workers run on
  the wrong tier.
- For a session that is one very hard problem, `/effort ultracode` (session-only) adds
  workflow orchestration on top of `xhigh`. It is not a substitute for delegation.
- This setup requires **Claude Code 2.1.219+**. The floor lives in one file,
  `~/.claude/version-floor.json`. Below it the spawn-depth pin and the concurrency cap are
  ignored and `opus` resolves to Opus 4.8 — all three silently. The session brief warns;
  `node bootstrap.mjs doctor` checks. As of 2.1.219 the default spawn depth is 3, so the
  `=1` pin is doing real work today, not guarding a legacy default.
