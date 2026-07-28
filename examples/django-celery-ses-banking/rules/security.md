---
paths:
  - "apps/**"
  - "config/**"
---

# Security standards

Every rule here is mandatory. A "small" change is not an exception.

## Authentication and authorization

- **MUST** require API key authentication on every endpoint. Never bypass, weaken, or add
  an opt-out for `APIKeyAuthentication` / `APIKeyUsageMiddleware`. New views inherit the
  existing permission layer — no exceptions for "internal" or "debug" routes.
- **MUST** apply least privilege. New API keys, roles, or service accounts get only the
  scopes and IP restrictions they need — see `APIKey`'s usage tracking and IP fields.
- **NEVER** widen CORS, disable CSRF, or relax auth to make local testing easier, and never
  let such a change reach `staging.py` or `production.py`. Development allowing all CORS
  origins is intentional and stays confined to development.

## Secrets

- **MUST** encrypt secrets and sensitive fields at rest, following the `SESCredential`
  pattern in `apps/email_service/models/credential.py`, which Fernet-encrypts
  `aws_access_key_id` / `aws_secret_access_key`. Any new credential, token, or secret field
  follows the same pattern.
- **NEVER** hardcode credentials, keys, or secrets in code, settings, migrations, or tests.
  Source them from environment variables or encrypted database fields only.
- **NEVER** log secrets, API keys, OTPs, full email bodies, or recipient PII. Logging must
  be safe to ship to a centralized log store by default.

## Input and payloads

- **MUST** validate and sanitize all external input — webhook payloads, CSV/Excel bulk
  imports, unsubscribe tokens, query params. Assume every external payload is hostile until
  validated.
- **MUST** verify SES/SNS webhook signatures — see
  `apps/email_service/services/sns_service.py` — before trusting or acting on a payload.
- **MUST** use the Django ORM for all queries. Never construct raw SQL from user-supplied
  input.
- **MUST** keep unsubscribe and verification tokens HMAC-signed and time-bound as currently
  implemented. Never weaken token verification for convenience.

## Testing these paths

Security- and PII-adjacent code — auth, credential handling, webhook signature
verification, suppression lists, unsubscribe tokens, password reset and change — requires
real coverage of four cases: happy path, permission denied, tampered or invalid input, and
failure mode. Run `make test` (or a targeted `pytest`) before treating this work as done.

## Observability

Errors in webhook processing, sending, and auth must be logged with enough context to
diagnose without exposing secrets or PII — log `credential.id` or `member.id`, never raw
keys or email bodies. Never catch-and-ignore in a way that hides a production incident
(failed sends, bad signatures, exhausted retries) from logs and monitoring.
