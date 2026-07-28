---
paths:
  - "src/**"
  - "app/**"
  - "apps/**"
  - "lib/**"
  - "api/**"
  - "server/**"
  - "services/**"
  - "internal/**"
  - "pkg/**"
  - "config/**"
---

# Security standards

<!-- Adjust the `paths` list above to this repository's layout, and delete any rule below
     that does not apply. A rule that is present but untrue teaches Claude to ignore the
     file. -->

Every rule here is mandatory. A "small" change is not an exception.

## Authentication and authorization

- **Never bypass, weaken, or add an opt-out to the authentication layer** — including for
  routes described as internal, debug, admin-only, or temporary. New handlers inherit the
  existing permission layer.
- **Authorize on the resource, not just the route.** A request that is authenticated is not
  therefore entitled to the record it names. Check ownership or tenancy on the object.
- **Apply least privilege** to new keys, roles, and service accounts: only the scopes they
  need, and no broader lifetime than they need.
- **Never relax CORS, CSRF, or auth checks to make local development easier**, and never
  let such a change reach a staging or production configuration.

## Secrets

- **Never hardcode credentials, keys, or tokens** in code, configuration, migrations, or
  tests. Source them from the environment or an encrypted store.
- **Follow this project's existing pattern for secrets at rest.** Find how the current
  credential storage works before adding a new secret field, and match it — do not invent
  a second mechanism.
- **Never log secrets, tokens, credentials, one-time codes, full message bodies, or
  personal data.** Logs must be safe to ship to a centralized store by default.

## Input and untrusted data

- **Validate and sanitize all external input** — request bodies, webhook payloads, uploaded
  files, query parameters, and anything read from a third-party API.
- **Verify webhook signatures before acting on a payload.** An unverified webhook is
  attacker-controlled input.
- **Use parameterized queries or the project's ORM.** Never build a query by interpolating
  user-supplied values.
- **Keep signed tokens signed and time-bound.** Do not weaken verification for convenience,
  and do not extend a token's lifetime to work around a test failure.

## Testing these paths

Security-adjacent code — authentication, authorization, credential handling, signature
verification, token issuance and validation, password flows — needs coverage of four cases,
not one: happy path, permission denied, tampered or malformed input, and failure mode.

## Observability

Log errors on auth, external calls, and background processing with enough context to
diagnose them without exposing secrets or personal data — identifiers, not values. Never
catch-and-ignore in a way that hides a production incident from logs or monitoring.
