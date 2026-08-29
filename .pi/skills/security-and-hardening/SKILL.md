---
name: security-and-hardening
description: Use when auditing security, implementing authentication or authorization, handling secrets, or validating data across external trust boundaries.
---

# Security and Hardening

## Iron Laws

<EXTREMELY-IMPORTANT>
- **Validate every external boundary.** Decode `unknown` into a trusted domain type.
- **Authn is not authz.** Identity never implies permission.
- **Deny and minimize by default.** Least privilege, short retention, explicit access.
- **Secrets never enter code, logs, or git.**
- **Use layered controls.** Application checks and persistence constraints cover different failures.
</EXTREMELY-IMPORTANT>

## Boundary Matrix

| Boundary | Required control |
| --- | --- |
| HTTP path/query/body | Schema decode, limits, reject unknown fields |
| Job queue message | Versioned schema; never assume the producer validated |
| User file or third-party response | Treat as untrusted bytes/data |
| Config / env | Validate presence, type, range, and allowed values at startup |
| DB read into a domain type | Validate current invariants; stored data may be stale |
| Internal typed function call | Trust types unless the call changes trust/domain |
| Database write | Parameterized query plus database constraints (`NOT NULL`, `UNIQUE`, `CHECK`, FK) |

Validate at boundaries, not randomly inside business logic. Service code enforces domain preconditions; the database protects invariants and races. Return validation failures as typed errors, not unclassified exceptions.

## Security Controls

- **Injection:** parameterized queries; never concatenate untrusted SQL or shell input.
- **Authentication:** Argon2/bcrypt, MFA where sensitive, rate limit by account and IP.
- **Sessions:** random signed identifiers, `httpOnly`, `secure`, short expiry, refresh rotation.
- **Authorization:** check every action and object; test that user A cannot access user B.
- **XSS/CSRF:** output encoding, CSP, safe templating, appropriate same-site/CSRF protection.
- **Dependencies:** lock versions, review advisories and major upgrades; do not apply audit fixes blindly.
- **Logging:** record failed auth, denials, and anomalous access; redact credentials and tokens.
- **Headers:** HSTS, CSP, `nosniff`, frame protection, and restrictive referrer policy.

## Secrets

Use local environment variables, CI secret stores, and a production vault. Rotate on exposure. Never print secrets during debugging or transmit them to tools without explicit authorization.

## Verification

Test negative paths: malformed boundary input, missing permission, cross-tenant access, replay/rate-limit behavior, invalid queue payload, invalid environment configuration, and persistence constraint violations.

## Red Flags

`as any` at a boundary; trusting frontend IDs; validation only in the controller; unvalidated queue/DB/env data; plaintext or fast-hashed passwords; permissive CORS; secrets in logs; default credentials; auth “later”; database invariants enforced only in application code.
