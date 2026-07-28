# 2026-07-28 — Continuity setup and worker-ledger vocabulary/identity fixes

## What

- Added `.gitignore` at repo root, ignoring `.claude/settings.local.json`,
  `.claude/worker-ledger.jsonl`, and `.claude/worktrees/`.
- Untracked `.claude/worker-ledger.jsonl` from git (`git rm --cached`); the file itself is
  left on disk, unmodified in content, just no longer part of the index.
- `user/hooks/worker-ledger.mjs`, `extractResult`: the Result-line regex now accepts
  `PASS|FAIL` in addition to `DONE|PARTIAL|BLOCKED`.
- `user/hooks/worker-ledger.mjs`, main try block: a SubagentStop payload with neither
  `agent_type` nor `agentType` now exits 0 without appending a row, instead of falling back
  to the literal string `"subagent"`.
- `docs/CHANGES-AND-RATIONALE.md`, §4 memory table: the worker ledger's "travels between
  machines" cell now reads "No — gitignored" instead of "Optional — gitignore it or not",
  and a new §9 documents this session's five fixes.
- Created `docs/decisions/DECISIONS.md`, seeded with the standing decisions already implicit
  in the code and in `docs/CHANGES-AND-RATIONALE.md`.
- `README.md` Layout block: added lines for `.gitignore`, `docs/decisions/DECISIONS.md`, and
  `docs/changelogs/`.
- Added `.claude/agent-memory/implementer/` (`MEMORY.md` and `claude-orchestrator-repo.md`),
  written by the `implementer` worker via `memory: project` and committed per policy —
  `.claude/agent-memory/` is deliberately absent from `.gitignore`.

## Why

Five contradictions existed between what this repository instructs other repositories to do
and what it does itself:

1. `orchestration-onboard/SKILL.md` instructs every onboarded project to gitignore the
   worker ledger and `settings.local.json`, but this repository had committed the ledger
   (`92b735e`) and shipped no `.gitignore` at all.
2. `docs/CHANGES-AND-RATIONALE.md` described the ledger's portability as "optional," directly
   contradicting the skill's unconditional instruction.
3. The ledger's `extractResult` only recognized the worker-contract vocabulary
   (`DONE|PARTIAL|BLOCKED`), but `verifier.md` declares its own vocabulary
   (`PASS|FAIL|BLOCKED`). A live `verifier` subagent run this session produced a report
   beginning `## Result` / `PASS`, and the ledger recorded `result: null` for it — every
   verifier completion was silently unrecorded.
4. The ledger's agent-identity fallback (`payload.agent_type || payload.agentType ||
   "subagent"`) wrote a row for any SubagentStop event lacking an agent type, even though a
   genuine subagent completion always supplies one — those rows carried no information and
   polluted the session brief with `→ unknown` lines.
5. `user/rules/session-continuity.md` requires a changelog entry for any session touching
   code, config, or docs, and a decision log for choices that constrain future work. This
   repository had neither directory, so `session-brief.mjs` produced no brief when a session
   opened here, and all three prior commits left no trace of their reasoning.

## How

- The `.gitignore` groups the three ignored paths with a one-line comment on each, matching
  the packet's spec exactly; `.claude/agent-memory/` is deliberately left out since policy
  keeps it tracked.
- `git rm --cached` was used rather than `rm` + re-add, so the working-tree file is
  untouched and only the index entry is removed.
- `extractResult`'s regex gained `PASS|FAIL` as alternates rather than a second function, to
  keep one extraction path and one set of case-insensitive/multiline semantics for both
  vocabularies; a comment above the function names why both exist.
- The agent-identity fix moves the "no identity" check before the `agent` assignment and
  exits immediately, inside the same outer `try` that already makes the whole hook
  fail-open — no new error-handling path was introduced.
- `docs/CHANGES-AND-RATIONALE.md` gained a new §9 (existing sections were not renumbered)
  documenting C1–C5 in the same table/prose style as the rest of the file.
- `DECISIONS.md` restates decisions that were already load-bearing but undocumented, plus
  records this session's C1/C2 resolution as its own dated entry.

## Affected modules and behaviors

- **`SubagentStop` hook (`worker-ledger.mjs`)** — behavior change: (a) verifier completions
  now produce a real `result` value instead of `null`; (b) stop events without an agent
  identity no longer produce a ledger row at all. Entry shape (`at`, `agent`, `result`,
  `note`, `session`) is unchanged; `session-brief.mjs` needed no changes to keep reading it.
- **`SessionStart` hook (`session-brief.mjs`)** — not modified, but its output changes
  indirectly: `→ unknown` rows for identity-less stop events will no longer appear, and
  verifier rows will render their real PASS/FAIL/BLOCKED result instead of `unknown`.
- **Git index** — `.claude/worker-ledger.jsonl` is no longer tracked; the file remains on
  disk and hooks continue to read/write it at the same path.
- No auth, migration, async-task, webhook, or analytics paths are touched by this change —
  this repository has none of those; the change is confined to hooks, docs, and gitignore.

## Verification

Observed this session, before any of these edits:
- `node --version` → `v22.23.1`.
- `node --check` on `bootstrap.mjs`, `user/hooks/session-brief.mjs`, and
  `user/hooks/worker-ledger.mjs` all exited 0 with no output.
- A live `verifier` subagent run produced a report beginning `## Result` / `PASS`; the
  ledger recorded `{"result": null, ...}` for it — this is the direct evidence for the C3
  fix (the pre-fix `extractResult` did not recognize `PASS`).

Observed after the edits in this session:
- `node --check bootstrap.mjs` → exit 0, no output.
- `node --check user/hooks/session-brief.mjs` → exit 0, no output.
- `node --check user/hooks/worker-ledger.mjs` → exit 0, no output.
- `git status --porcelain` →
  ```
  D  .claude/worker-ledger.jsonl
   M user/hooks/worker-ledger.mjs
  ?? .gitignore
  ?? docs/decisions/
  ```
  (plus this changelog file itself, and the `docs/CHANGES-AND-RATIONALE.md` and `README.md`
  edits, all untracked/modified as expected).
- `git check-ignore -v .claude/worker-ledger.jsonl .claude/settings.local.json` → both
  resolved against the new `.gitignore` (`.gitignore:6` and `.gitignore:2` respectively).
- Synthetic SubagentStop payload with `agent_type: "verifier"` and a `## Result\nPASS\n`
  body, piped into `worker-ledger.mjs`: ledger line count went from 1 to 2; the appended row
  was `{"at":"2026-07-28 07:51","agent":"verifier","result":"PASS","note":null,"session":"testtest"}`
  — confirms the C3 fix with a real execution.
- Synthetic SubagentStop payload with no `agent_type`/`agentType` field, piped into the same
  hook immediately after: ledger line count stayed at 2 (no row appended) — confirms the C4
  fix with a real execution.
- Empty stdin and malformed JSON were also piped through as a spot check of the existing
  fail-open paths: both exited 0 and appended nothing.
- The two synthetic test rows were removed afterward; `.claude/worker-ledger.jsonl` was
  restored to its original single line (`{"at":"2026-07-28 07:16","agent":"subagent",...}`,
  a pre-existing row from before this session's fix, itself an instance of the C4 bug being
  fixed) and line count confirmed back at 1.

Not run: no test suite, lint, or build command exists in this repository beyond
`node --check`; `bootstrap.mjs install` was not executed against a real `~/.claude`, since
the packet's read-write set does not include it and doing so would touch machine state
outside the repository.

## Critical notes

- **Behavior change, deliberate:** a genuine worker completion that ever arrives without
  `agent_type` (neither `agent_type` nor `agentType` set) will now go completely unrecorded
  in the ledger, rather than being logged under the placeholder `"subagent"`. This trades a
  silent gap for a row that carried no information; if a future Claude Code version ever
  omits agent identity from a SubagentStop payload for a real worker, that completion would
  no longer appear in the ledger or the session brief. Nothing today is known to omit it —
  this session's own live `verifier` run confirmed the field is present for genuine
  subagents — but it is worth knowing if ledger gaps are ever investigated.
- **No secrets recorded.** This entry describes ledger row shapes and a truncated session id
  used only for a synthetic test (`"testtest"`); no real session ids, tokens, or credentials
  appear here.
- **Rollback:** reverting `user/hooks/worker-ledger.mjs` restores the old (buggy) behavior
  for both C3 and C4. Reverting the `.gitignore` addition and re-running `git add
  .claude/worker-ledger.jsonl` would re-track the ledger file, but that would restore
  contradiction C1 against `orchestration-onboard/SKILL.md`.
- **No new dependencies** were introduced; both hook changes use only the existing Node
  builtins already imported in the file.
