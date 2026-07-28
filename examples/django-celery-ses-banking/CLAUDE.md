# CLAUDE.md — Email Service backend

Enterprise banking backend. It processes financial-sector communications and customer data:
transactional notices, OTPs, campaign contact lists, PII. The standards here are
**mandatory for every change** — not suggestions, not best-effort. If a request conflicts
with one, flag the conflict rather than silently taking the easier path.

Detailed standards live in `.claude/rules/` and load when you touch the paths they cover:

| Rule | Loads when working on |
| --- | --- |
| `rules/security.md` | `apps/**`, `config/**` |
| `rules/data-and-migrations.md` | models, migrations |
| `rules/async-and-scale.md` | tasks, services, views, campaign code |

## Scale profile (this drives most design decisions)

The system sends **6,000,000+ emails/month and growing** — transactional notices, OTPs,
promotional campaigns — to recipients globally. At this volume latency, throughput, and
efficiency are mission-critical properties, not later optimizations.

- **Design for peak, not average.** 6M/month averages ~200k/day, but traffic is bursty: OTP
  and transactional volume spikes across business hours in multiple timezones, and one
  campaign can inject hundreds of thousands of sends in a short window.
- **Priority tiers are real.** A user is actively waiting on an OTP. OTP and transactional
  mail must never queue behind bulk promotional sends. New send paths use separate Celery
  queues or priorities — never one undifferentiated queue shared with campaign traffic.
- **SES limits are hard constraints.** Per-account and per-region sending rates and daily
  quotas are why the multi-`SESCredential` design exists. New sending features spread load
  across credentials and handle `Throttling` / `MaxSendingRateExceeded` with backoff and
  retry, never a hard failure.
- **Deliverability is a business risk.** At this volume, bounce and complaint handling and
  suppression discipline protect sending reputation. A reputation hit can throttle or
  suspend sending entirely — a business-impacting incident at banking scale.
- **Query discipline compounds.** Campaign, analytics, and event tables reach tens of
  millions of rows. An N+1 or an unbounded queryset that is harmless in development is a
  production incident here.

This profile is a living constraint. When updated volume or architecture details arrive,
treat them as authoritative revisions and re-evaluate designs already built against it.

## Non-negotiables (summary — details in `.claude/rules/`)

- **Auth on every endpoint.** Never bypass, weaken, or add an opt-out for
  `APIKeyAuthentication` / `APIKeyUsageMiddleware`, including for "internal" or "debug" routes.
- **No plaintext secrets, ever** — not in code, settings, migrations, tests, or logs.
- **No secrets, OTPs, full email bodies, or recipient PII in logs.** Logs must be safe to
  ship to a central store by default.
- **Async by default.** Sending, bulk imports, and webhook fan-out go to Celery, never
  inline in the request cycle.
- **Never hard-delete.** Every model extends `SoftDeleteModel`.
- **Backward-compatible, zero-downtime migrations.** Assume a live production database.
- **Paginate every list endpoint** and avoid N+1 queries.
- **Verify before claiming.** `make test` and `make lint` are run and their real output
  reported. A claimed pass that was not observed is a defect.

## Orchestration in this repository

Global roles are defined in `~/.claude/CLAUDE.md`. Repo-specific routing:

- **Always dispatch `reviewer`** before integrating any change touching auth, credential
  handling, webhook signature verification, suppression lists, unsubscribe tokens, password
  flows, migrations, or Celery task semantics. These are the paths where a defect is a
  security or audit incident, not a bug.
- **Route to `implementer`**, not `fast-implementer`, for anything touching those same
  paths — a "mechanical" edit to an auth path is not mechanical.
- **`verifier` runs the suite.** `make test` is slow and noisy; keep it out of the main
  conversation and integrate on its evidence.
- **Never fan two workers onto one Django app's models** in the same batch — migration
  state and model imports collide. Split by app, or run sequentially.

## Session changelog

Every session that changes code, config, migrations, or docs writes
`docs/changelogs/YYYY-MM-DD-<slug>.md`, committed with the change it describes. This is an
audit requirement for a banking system. Follow the format in `~/.claude/rules/session-continuity.md`
and `docs/changelogs/README.md`, and state which of the four apps (`ses_backend`,
`email_service`, `campaign`, `users`) and which behaviors are affected, including downstream
effects on auth, migrations, Celery tasks, webhooks, and analytics.

## Commands

```bash
make install          # or: poetry install
make migrate          # python manage.py migrate
make makemigrations
make run              # dev server
make test             # full suite
make lint             # flake8 + mypy
make format           # black + isort
make docker-up        # db, redis, celery
make docker-down

pytest apps/email_service/tests/test_email.py                          # one file
pytest apps/email_service/tests/test_email.py::TestClass::test_method  # one test
pytest -m unit / -m integration / --cov
```

Default `DJANGO_SETTINGS_MODULE` is `config.settings.development`; override by environment.
API docs at `/api/docs/` (Swagger) and `/api/redoc/` (ReDoc) when running.

## Architecture

Django 4.2 + DRF, PostgreSQL, Redis, Celery, AWS SES. Four apps under `apps/`:
`ses_backend` (API-key auth foundation), `email_service` (sending, templates, webhooks,
analytics, suppression, unsubscribe tokens), `campaign` (bulk campaigns, CSV/Excel import),
`users` (auth and user management). All models inherit
`TimestampedModel` → `SoftDeleteModel` → `BaseModel` (UUID pk) from
`apps/ses_backend/models/base.py`. Endpoints are versioned under `/api/v1/`.

`config/settings/` splits `base` / `development` / `staging` / `production`. Development
allowing all CORS origins is intentional and **must stay confined to development** —
`staging.py` and `production.py` stay locked down regardless of local convenience.
