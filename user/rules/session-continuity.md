# Session continuity

Each session starts with an empty context window. What the next session knows is exactly
what this one wrote down. Continuity is produced deliberately, in files that travel with
the repository — not in machine-local memory, which does not follow you to a server.

## Session changelog (required whenever code, config, migrations, or docs changed)

One file per session at `docs/changelogs/YYYY-MM-DD-<short-slug>.md`. If several sessions
land on one day, keep the slugs distinct; never overwrite a prior session's file. Commit it
in the same commit as the change it describes, so history and audit trail stay in lockstep.

Cover, with concrete detail:

- **What** changed — the specific files, endpoints, models, migrations, or settings.
- **Why** — the request, bug, or requirement behind it.
- **How** — the approach taken, notable decisions, and any tradeoff made.
- **Affected modules and behaviors** — including downstream effects on auth, migrations,
  async tasks, webhooks, and analytics.
- **Verification** — the commands run and their real results. Name anything left unverified.
- **Critical notes** — security implications, rollback considerations, breaking changes,
  and follow-ups an on-call engineer or auditor would need.

Never record secrets, API keys, OTPs, credentials, or PII in a changelog.

## Decision log (required when a choice constrains future work)

Append to `docs/decisions/DECISIONS.md` when a session settles something a future session
would otherwise re-litigate: an architectural direction, a rejected alternative, a
deliberate constraint. Three or four lines each — date, decision, why, what it rules out.

Rejected alternatives matter as much as the choice. Most wasted sessions are a rediscovery
of an option that was already ruled out for a reason nobody wrote down.

## At session start

Read the most recent changelog entries and the decision log before proposing an approach,
so today's work aligns with what already happened rather than contradicting it. The
`session-brief` hook surfaces both automatically; if it did not run, read them directly.

## At session end

Write the changelog before the session ends, not after the last commit "when there is time."
A session that changed something and left no trace is an incomplete session.
