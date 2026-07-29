# CLAUDE.md — <!-- FILL: project name -->

<!--
  Template. Keep this file under ~150 lines.

  What belongs here: judgment context Claude cannot derive by reading the code —
  risk profile, scale constraints, non-obvious conventions, and rules that differ from
  what a competent engineer would assume by default.

  What does NOT belong here: directory listings, dependency lists, or an architecture
  tour. Claude can read those from the repository, and `/doctor` will propose cutting
  them. Detailed standards belong in .claude/rules/ with `paths:` frontmatter so they
  load only when relevant.

  Delete every comment block like this one once you have filled the file in.
-->

<!-- FILL: one paragraph. What this system is, who depends on it, and what breaks if it
     is wrong. Be concrete about consequence — "an outage blocks customer payouts" tells
     Claude how to weigh a tradeoff; "this is an important service" does not. -->

Detailed standards live in `.claude/rules/` and load when you touch the paths they cover:

| Rule | Loads when working on |
| --- | --- |
| `rules/security.md` | application source and configuration |
| `rules/data-and-migrations.md` | models, schemas, migrations |
| `rules/reliability-and-performance.md` | background jobs, request handlers, hot paths |

<!-- Delete rows for rules you removed; add rows for rules you added. -->

## Operating constraints

<!--
  FILL: the constraints that make this project different from a generic one of its type.
  This is the highest-value section in the file, and the one Claude cannot infer.

  Prompts, if useful — delete what does not apply:
  - Volume and shape of traffic. Peak vs average, burstiness, what spikes and when.
  - Latency tiers. Which paths have a user actively waiting, and which do not.
  - Hard external limits. Rate limits, quotas, per-account caps, third-party throttling,
    and what the system does when it hits them.
  - Data volume. Which tables or collections grow without bound, and what that rules out.
  - Compliance and audit. What must be reconstructable after the fact, and for how long.
  - Anything a new engineer gets wrong in their first week.

  Write these as consequences, not facts. "Campaign tables reach tens of millions of rows,
  so an unbounded query that is fine locally is a production incident" is usable.
  "We have a lot of data" is not.
-->

<!-- If these numbers change, treat the update as authoritative and re-evaluate designs
     already built against the old ones. -->

## Non-negotiables

<!--
  FILL: rules that hold for every change, with no exceptions for "small" edits.
  Keep this to a summary — the reasoning and detail go in .claude/rules/.
  Each line should be checkable: a reviewer can point at code and say yes or no.

  Starting set — keep what applies, delete the rest, and add what is specific to you:
-->

- **Authentication is never bypassed, weakened, or made optional** — including for
  internal, debug, or admin-only routes.
- **No plaintext secrets** in code, configuration, migrations, tests, or logs.
- **No secrets, tokens, credentials, or personal data in logs.** Logs must be safe to ship
  to a central store by default.
- **All external input is validated before use** — request bodies, webhooks, uploaded
  files, query parameters. Assume every external payload is hostile.
- **Slow or externally-dependent work runs asynchronously**, never inline in a request.
- **Migrations are backward-compatible and safe against a live database.**
- **List endpoints are paginated** and queries avoid N+1 access patterns.
- **Verify before claiming.** <!-- FILL: your test and lint commands --> are run and their
  real output reported. A claimed pass that was not observed is a defect. List those same
  commands in `.claude/continuity.json` as `verifyCommands` so the reminder hook can tell
  whether they ran; omit the key and that hook stays silent.

## Orchestration in this repository

Global roles are defined in `~/.claude/CLAUDE.md`. Repo-specific routing:

- **Always dispatch `reviewer` before integrating** changes to:
  <!-- FILL: the paths where a defect is an incident rather than a bug — auth, credentials,
       payments, permissions, migrations, deletion paths, anything touching personal data. -->
- **Route to `implementer`, not `fast-implementer`,** for those same paths. A "mechanical"
  edit to an authorization path is not mechanical.
- **`verifier` runs the suite** when it is slow or noisy, so its output stays out of the
  main conversation.
- **Do not parallelize across:**
  <!-- FILL: file sets that collide. Common cases: two workers editing the same module's
       models while migrations are generated; shared configuration or dependency manifests;
       a single generated file that several features append to. -->

## Session changelog

Every session that changes code, configuration, or documentation writes an entry to
`docs/changelogs/` and commits it with the change it describes. Format is in
`docs/changelogs/README.md`.

<!-- FILL: if this project has audit obligations, say so here and say what an auditor
     must be able to reconstruct from the changelog alone. -->

## Commands

```bash
# FILL: the commands you actually run. Install, run, test, lint, format, migrate.
# Include the narrow forms too — running one test file matters more than the full suite.
```

<!-- FILL: anything needed to run the project that is not obvious from the above —
     required services, environment variable defaults, where API docs are served. -->

## Architecture

<!-- FILL: 3-6 sentences maximum. The mental model, not the file tree: what the major
     components are, which one owns which concern, and any inheritance or layering rule
     that is easy to violate. Claude reads the code for everything else. -->
