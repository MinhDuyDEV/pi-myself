---
name: typescript-coding-standards
description: Use when writing, refactoring, or reviewing how TypeScript types and errors are written — branded domain types, discriminated unions, typed errors or Result returns, narrowing unknown — not for which inputs are untrusted (security-and-hardening) or module shape (codebase-design).
---

# TypeScript Coding Standards

Module shape, seams, and adapters are `codebase-design`'s vocabulary; the test loop is `tdd`'s; which inputs are untrusted is `security-and-hardening`'s boundary matrix. This skill covers only how types and errors are written. The samples show shape, not formatting: the repo's formatter wins.

## Iron Laws

<EXTREMELY-IMPORTANT>
- **No `any` in production code.** Branded primitives, schema boundaries, `unknown` + narrow. Tests follow the repo's own rule (this harness relaxes it in `*.test.ts`).
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

The TypeScript shape of `security-and-hardening`'s boundary rule: decode at the edge with a schema whose output is the domain type, so the core never holds `unknown` or `any`; inside, trust the types.

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
