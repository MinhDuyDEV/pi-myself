---
name: typescript-coding-standards
description: Use when writing, refactoring, or reviewing TypeScript code that needs strong domain modeling, typed errors, schema parsing at boundaries, or safe narrowing of unknown input.
---

# TypeScript Coding Standards

Module shape, seams, and adapters are `codebase-design`'s vocabulary; the test loop is `tdd`'s. This skill covers only how types and errors are written.

## Iron Laws

<EXTREMELY-IMPORTANT>
- **No `any`.** Branded primitives, schema boundaries, `unknown` + narrow.
- **Errors as data.** Typed domain errors or a `Result`-style return, in whatever shape the project already uses; no untyped throws for recoverable failures.
- **Pure core, effects at edges.** Business logic takes inputs, returns values.
- **Types describe the domain.** `UserId` not `string`.
</EXTREMELY-IMPORTANT>

## Domain Modeling

```ts
// Branded primitives (no runtime cost)
type UserId = string & { readonly __brand: "UserId" }
const UserId = (s: string): UserId => s as UserId

// Discriminated unions — `kind`, not `type` (collides with TS)
type RequestState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; data: T }
  | { kind: "error"; error: AppError }
```

## Schema Boundaries

Validate untrusted input at the edge; inside, trust the types. `req.body`, `JSON.parse`, `process.env`, query strings, queue payloads, and rows read back from a database never reach the core undecoded.

```ts
const input = UserSchema.parse(req.body) // `User`, not `unknown`
```

## Error Modeling

The return type is the contract; handlers switch on the discriminant. Keep the error shape the project or dependency boundary already uses; do not introduce a new error library for a local fix.

```ts
class UserNotFound extends Error {
  readonly _tag = "UserNotFound" as const
  constructor(readonly userId: UserId) { super(`User ${userId} not found`) }
}

type GetUser = (id: UserId) => Promise<Result<User, UserNotFound | DbError>>
```

## Red Flags

`any` in production; untyped `JSON.parse`; `try/catch` around `await` that swallows the error; `Date.now()` inside logic; `console.log` left behind; a `string` standing in for a domain concept; `type` as a discriminant name.
