---
name: claude-orchestrator-repo
description: Working notes for the claude-orchestrator repo itself (the orchestrator-worker tooling package) - hook testing gotcha, ledger/gitignore invariants, and doc files that must stay cross-consistent.
metadata:
  type: project
---

Verified 2026-07-28 on branch chore/v2-continuity, worktree
`.claude/worktrees/v2-continuity`.

- `zsh`'s builtin `echo` interprets `\n` as a literal newline before the argument ever
  reaches the program, so `echo '...\n...' | node hook.mjs` silently breaks JSON payloads
  containing `\n` inside a string value (JSON.parse then fails and the fail-open hook
  exits 0 with no visible error). Use `printf '%s' '...json...'` instead when constructing
  synthetic hook payloads with embedded `\n` — printf does not expand escapes inside a
  `%s`-substituted argument.

- `user/hooks/worker-ledger.mjs` and `user/hooks/session-brief.mjs` both read
  `.claude/worker-ledger.jsonl` at a project-relative path resolved via
  `CLAUDE_PROJECT_DIR` env var, then `payload.cwd`, then `process.cwd()` — pass `cwd` in
  any synthetic test payload or the write goes to the wrong root silently.

- The repo's own onboarding skill (`user/skills/orchestration-onboard/SKILL.md`) instructs
  onboarded projects to gitignore `.claude/settings.local.json` and
  `.claude/worker-ledger.jsonl`, and to keep `.claude/agent-memory/` tracked. This repo now
  follows that itself (root `.gitignore`, added 2026-07-28) — check that invariant hasn't
  drifted before trusting either file's tracked status.

- Doc files that describe the same facts and must be kept in sync when editing hooks or
  policy: `docs/CHANGES-AND-RATIONALE.md` (numbered sections, `###` subheads, `**Fix:**`
  lead-ins, tone is direct/evidence-first), `docs/decisions/DECISIONS.md` (date + decision +
  why + what it rules out, 3-4 lines), `user/skills/orchestration-onboard/SKILL.md`, and
  `user/agents/verifier.md` vs `user/skills/worker-contract/SKILL.md` (two *deliberately*
  different Result vocabularies: DONE|PARTIAL|BLOCKED for worker-contract,
  PASS|FAIL|BLOCKED for verifier — the ledger's `extractResult` regex must accept both).

See [[worker-contract-report-format]] for the general report-format rule (name files,
don't paste diffs) that also governs how this repo's own worker-facing docs are written.
