---
paths:
  - "**/migrations/**"
  - "**/models/**"
  - "**/models.py"
---

# Data integrity, audit, and migrations

- **NEVER hard-delete records.** Every model extends `SoftDeleteModel`
  (`apps/ses_backend/models/base.py`). Do not add `.delete()` calls that bypass the
  soft-delete manager without an explicit, deliberate, stated reason.
- **MUST preserve `created_at` / `updated_at` provenance.** Do not manually override
  timestamps.
- **MUST write backward-compatible, zero-downtime-safe migrations.** Assume the migration
  runs against a live production database. No destructive column drop or rename without a
  safe multi-step path: add, backfill, dual-write, cut over, remove later.
- **Treat delivery and analytics events as an audit trail.** Opens, clicks, bounces, and
  suppression records are appended, never mutated or deleted. New state is a new row.
- **Be deliberate about indexes** on any new filterable or sortable field. Campaign and
  analytics tables reach tens of millions of rows; a missing index there is an incident,
  not a slow query.

## Before finishing a migration change

State in the changelog: what the migration does, whether it is reversible, what happens if
it runs while the old code is still serving traffic, and the rollback path.
