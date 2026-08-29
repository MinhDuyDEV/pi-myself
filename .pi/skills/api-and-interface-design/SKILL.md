---
name: api-and-interface-design
description: Use when designing REST/GraphQL APIs, SDK interfaces, or public module boundaries — covers contract-first design, versioning, error shapes, and backward compatibility
version: 1.0.0
tags: [architecture, code-quality]
dependencies: []
agent_types: [planner, worker, reviewer]
tools: []
---

# API & Interface Design

## Iron Laws

<EXTREMELY-IMPORTANT>
- **Contract first, implementation second.** The API is the contract. Internal code can change freely; the contract cannot.
- **Version explicitly.** `/v1/`, `/v2/`, or header. Implied versions break unexpectedly.
- **Errors are part of the contract.** Shape them as deliberately as the success response.
- **Backward compatibility is a feature.** Breaking changes cost users; every break must justify.
- **Document what you ship, not what you intended.** Generated docs from the schema, not hand-written.
</EXTREMELY-IMPORTANT>

## Contract-First Design

1. **Write the schema** (OpenAPI, GraphQL SDL, Protobuf, JSON Schema).
2. **Generate types** from the schema (client + server).
3. **Validate** at the boundary (decode unknown → typed value).
4. **Implement** against the types, not the raw input.

Never let a request body reach the implementation as `any` or `unknown`. Decode first.

## Versioning Strategy

| Strategy | When |
|---|---|
| URL path (`/v1/`, `/v2/`) | Public API, multiple versions live simultaneously |
| Header (`Accept: application/vnd.api+json;v=2`) | Internal API, more flexible |
| Query param (`?v=2`) | Web-only, simple cases |
| None (breaking is breaking) | Internal-only, single consumer |

For public APIs, prefer URL path. It's visible, cacheable, and easy to reason about.

## Error Shape

```json
{
  "error": {
    "code": "user_not_found",
    "message": "User 123 not found",
    "details": { "userId": "123" },
    "traceId": "abc-def-ghi"
  }
}
```

Always: machine-readable `code` (stable, never localized), human-readable `message` (localized OK), `details` (structured context), `traceId` (correlation). Never: stack traces, internal paths, secrets.

## Backward Compatibility

**Add only.** Don't change existing field meanings. Don't tighten validation. Don't remove fields. Don't rename.

If you must break: new version, deprecation period, migration guide, codemod if possible.

## Idempotency

`PUT` should be idempotent. `POST` for creation can be made idempotent with an `Idempotency-Key` header. `DELETE` should be idempotent. The client should be able to retry safely.

## Pagination

Prefer **cursor-based** for feeds and large lists. Skip-relations are slow on big tables. Return a `nextCursor` and `hasMore`. Document the cursor format if you can.

## Rate Limiting

Return headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After` (on 429). Make limits visible. Document them.

## Common Mistakes

Schema after impl (backwards); no version; generic errors; no idempotency; no pagination (returns 10k items); no rate limit headers; breaking without bump; hand-written docs; field reused for new purpose; no `traceId`; asymmetric shapes.

## Red Flags

`/api/` (no version); error as string; no idempotency; no pagination; no rate limit; hand-written docs; breaking in minor; field reused; no `traceId`; "schema is in the code".

## Anti-Patterns

**Schema after impl**; **no version**; **generic errors**; **breaking without bump**; **hand-written docs**; **no idempotency**; **no pagination**; **silent breaking**.
