---
paths:
  - "docs/**"
  - "**/*.md"
  - "**/README*"
  - "**/openapi*.{json,yaml,yml}"
---

# Documentation accuracy

A documented claim is a factual statement about how the system behaves. An inaccurate doc
is a defect, not a cosmetic issue — it is worse than no doc, because it is trusted.

These rules apply to API references, endpoint docs, integration guides, READMEs, and any
handoff document meant to feed downstream documentation.

- **Verify against source before writing a line.** Read the real implementation — routes,
  views, serializers, models, settings, tasks — and know the `file:line` each claim comes
  from. Never document from memory, from an existing doc, or from what an endpoint
  *should* do. Existing docs may predate the code and are not a trusted source.
- **Code is ground truth.** Where docs and code disagree, document what the code does and
  flag the divergence as a finding.
- **Exercise the real path where a claim is testable.** Real request/response, real URL
  resolution, real serializer validation, real command invocation. Never write a passing
  test that mocks the very behavior being documented, and never invent request shapes,
  field names, defaults, status codes, or error messages.
- **Copy, don't paraphrase, the specifics.** Field lists, defaults, limits, enums, and
  error cases come from the code — serializer fields, settings constants, view logic — not
  from a plausible reconstruction. Example payloads use real field names and real value
  shapes; only sensitive values are placeholders.
- **Document behavior as implemented, and name the surprises.** Missing scoping, a
  surprising default, a caller-supplied assumption — call it out explicitly rather than
  smoothing it over.
- **Pin and date the source.** State the branch and commit the documentation was verified
  against, so a later reader can tell when it went stale.
- **Never present unverified as verified.** If a claim could not be exercised — environment
  unavailable, path unreachable — mark that claim unverified and say why, in the doc and in
  the changelog. Silence implies it was checked.
- **Never put real secrets, API keys, OTPs, credentials, or recipient PII in a document**,
  including in examples and error samples.
