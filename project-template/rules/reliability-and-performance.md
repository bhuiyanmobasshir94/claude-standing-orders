---
paths:
  - "**/tasks.py"
  - "**/tasks/**"
  - "**/jobs/**"
  - "**/workers/**"
  - "**/queues/**"
  - "**/handlers/**"
  - "**/services/**"
  - "**/views.py"
  - "**/views/**"
  - "**/controllers/**"
  - "**/routes/**"
---

# Reliability and performance

<!-- Adjust `paths` to this repository, and delete rules that do not apply. -->

## Asynchronous work

- **Offload slow or externally-dependent work to a background job** — outbound network
  calls, bulk imports, fan-out, report generation. Never perform it inline in a
  request/response cycle.
- **Make job and webhook handlers idempotent.** Queues redeliver and third parties retry.
  Processing the same message twice must not double-charge, double-send, double-count, or
  corrupt state.
- **Handle failure with retry and backoff, not a silent drop.** Do not swallow exceptions;
  surface, log, and where appropriate re-raise so failures are alertable.
- **Treat the queue and its broker as required infrastructure.** Paths depending on async
  delivery degrade predictably — a clear error, never a hang or a silent no-op — when the
  worker is unavailable.
- **Prefer partial success where it is safe.** One bad row in a batch import should not
  silently abort the batch; report per-item failures.

## Performance

- **Avoid N+1 access patterns.** Eager-load related data on any query touching related
  records, especially in list endpoints, batch operations, and aggregation.
- **Paginate every list endpoint.** Never return an unbounded collection to a client.
- **Push expensive computation out of the request path** — large file parsing, report
  generation, bulk writes.

## Scalability

- **Keep request handling stateless.** No in-memory or per-instance state that breaks when
  a second instance starts.
- **Design async work for concurrent workers.** No reliance on execution order, and no
  assumption that only one worker is running.
- **Separate latency tiers.** Work a user is actively waiting on must not queue behind bulk
  or batch work. <!-- FILL: name this project's tiers and their queues. -->

## Tests for this code

Background jobs need tests for failure and retry behavior, not only the happy path.
