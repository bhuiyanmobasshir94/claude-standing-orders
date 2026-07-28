---
paths:
  - "**/migrations/**"
  - "**/migrate/**"
  - "**/models/**"
  - "**/models.py"
  - "**/entities/**"
  - "**/schema.prisma"
  - "**/*.sql"
---

# Data integrity and migrations

<!-- Adjust `paths` to this repository, and delete rules that do not apply. -->

## Migrations

- **Assume the migration runs against a live production database** with the previous
  version of the application still serving traffic. A migration that is only safe after a
  deploy is not backward-compatible.
- **No destructive change without a multi-step path.** Dropping or renaming a column or
  table happens as: add the new shape, backfill, dual-write, cut over reads, remove the old
  shape in a later release.
- **Know the rollback.** Before finishing, state what happens if this migration is reverted
  and whether data is lost. If it cannot be reverted safely, say so explicitly.
- **Long-running data changes belong in a background job, not a migration.** A migration
  that rewrites millions of rows holds locks and blocks deploys.

## Deletion and history

- **Check how this project deletes before adding a delete path.** If it uses soft deletion,
  tombstones, or an archive table, match that; do not introduce a hard delete alongside it.
- **Treat event, audit, and analytics records as append-only.** Historical rows are not
  corrected in place — new state is a new row.
- **Preserve provenance.** Do not manually override created and updated timestamps.

## Growth and access patterns

- **Be deliberate about indexes** on any new filterable, sortable, or joined field. Identify
  which tables grow without bound in this system; a missing index there is an incident, not
  a slow query.
- **Never add an unbounded query to a hot path.** Anything that scales with total row count
  rather than page size will eventually fail in production even when it is instant locally.
