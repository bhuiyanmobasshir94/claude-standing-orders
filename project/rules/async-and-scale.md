---
paths:
  - "**/tasks.py"
  - "**/tasks/**"
  - "**/services/**"
  - "**/views.py"
  - "**/views/**"
  - "apps/campaign/**"
---

# Reliability, performance, and scale

## Async and reliability

- **MUST offload slow or externally-dependent work to Celery** — sending email, bulk
  imports, webhook fan-out. Never perform it inline in the request/response cycle.
- **MUST make webhook and task handlers idempotent.** SES/SNS will redeliver. Duplicate
  delivery must not double-send, double-count, or corrupt state.
- **MUST handle failures with retry and backoff, not silent drops.** Do not swallow
  exceptions; surface, log, and where relevant re-raise so failures are operable and
  alertable.
- **Celery and Redis are required infrastructure, not optional.** Code paths depending on
  async delivery degrade predictably — a clear error, never a hang or a silent no-op — when
  the worker is unavailable.
- **Prefer graceful degradation where a partial result is safe.** One bad row in a bulk
  import must not silently abort the batch; report per-row failures.

## Performance

- **MUST avoid N+1 queries.** Use `select_related` / `prefetch_related` on any queryset
  touching related models — especially campaign bulk operations, list endpoints, and
  analytics aggregation.
- **MUST paginate all list endpoints.** Never return an unbounded queryset to a client.
- Push expensive computation — bulk sends, report generation, large CSV/Excel parsing — to
  Celery rather than blocking a web worker.

## Scalability

- **MUST keep the API stateless.** Auth is per-request via API key header, not server-side
  session. Never introduce in-memory or per-instance state that breaks horizontal scaling.
- **Design async work for multiple concurrent workers.** No reliance on task execution
  order, and no single-worker assumptions.
- **Use the multi-credential design.** Multiple SES credentials exist so throughput and
  sending reputation spread across accounts and regions. Never hardcode a single
  credential or region path in a new sending feature.
- **Separate the priority tiers.** OTP and transactional sends never share an
  undifferentiated queue with bulk campaign traffic.

## Tests for this code

New Celery tasks need tests for success *and* failure/retry behavior, not just the happy
path.
