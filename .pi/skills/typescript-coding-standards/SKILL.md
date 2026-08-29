---
name: typescript-coding-standards
description: Use when writing, refactoring, or reviewing TypeScript code that needs strong domain modeling, typed errors, schema parsing, safe adapters, test seams, or maintainable module boundaries.
version: 1.0.0
tags: [typescript, code-quality, architecture, testing]
dependencies: []
agent_types: [planner, worker, reviewer]
tools: []
---

# TypeScript Coding Standards

## Iron Laws

<EXTREMELY-IMPORTANT>
- **No `any`.** Branded primitives, schema boundaries, `unknown` + narrow.
- **Errors as data.** Use typed domain errors, `Result<T, E>`, or `Effect<T, E>` according to project conventions; do not force a library or use untyped throws for recoverable failures.
- **Pure core, effects at edges.** Business logic takes inputs, returns values.
- **Types describe the domain.** `UserId` not `string`.
- **Test seams over mocking.** Inject dependencies as values.
</EXTREMELY-IMPORTANT>

## Domain Modeling

```ts
// Branded primitives (no runtime cost)
type UserId = string & { readonly __brand: "UserId" }
const UserId = (s: string): UserId => s as UserId

// Discriminated unions
type RequestState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; data: T }
  | { kind: "error"; error: AppError }
```

Use `kind` for discriminants (not `type` — collides with TS).

## Schema Boundaries

Validate untrusted input at the edge. Inside, trust the types.

```ts
const input = Schema.decodeUnknownSync(UserSchema)(req.body)
// Now `input` is `User`, not `unknown`
```

Never let `req.body`, `JSON.parse`, `process.env`, or query strings reach the core. Decode at the boundary.

## Error Modeling

Choose the error shape already used by the project or dependency boundary. Typed domain errors, `Result`, and `Effect` are valid options; preserve the public contract and avoid forcing a new error library for a local fix.

```ts
class UserNotFound extends Error {
  readonly _tag = "UserNotFound" as const
  constructor(readonly userId: UserId) { super(`User ${userId} not found`) }
}

type GetUser = (id: UserId) => Effect.Effect<User, UserNotFound | DbError>
```

The return type is the contract. Handlers switch on `_tag`.

## Adapters

External systems get an adapter. Adapter implements a domain interface, hides the external API.

```ts
interface UserRepo {
  findById: (id: UserId) => Effect.Effect<User, UserNotFound | DbError>
}

class PostgresUserRepo implements UserRepo {
  findById = (id) => Effect.tryPromise({
    try: () => pg.query("SELECT * FROM users WHERE id = $1", [id]),
    catch: (e) => toDbError(e)
  })
}
```

Business code depends on `UserRepo`, not `pg`. Tests use in-memory `UserRepo`.

## Testing

Test pure core with input/output cases. Test impure edges through injected ports and deterministic fakes; assert boundary interactions. Mock unavoidable systems.

## Module Boundaries

- One concern per module. Name after the concept, not the file type.
- Give public concepts the shortest name that greps uniquely; include a domain term and keep one concept, one spelling.
- Put a definition comment only where it states a hidden constraint or natural-language search phrase; do not restate the type.
- Public API: explicit exports. Internal: not exported or in `internal/`.
- No circular deps. If A imports B, B does not import A.
- Index files are minimal — only the public surface.

## Red Flags

`any` in production; untyped `JSON.parse`; `try/catch` around `await`; `Date.now()` in logic; `console.log` left; `data: any`; circular imports; tests that don't test.

## Anti-Patterns

**"Just a string"** (no branded type); **"errors are exceptions"**; **"types later"**; **"test with mock"** (test seam); **"any to unblock"**; **"utils.ts"**.
