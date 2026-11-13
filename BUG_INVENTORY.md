# Bug Inventory — TypeScript & Lint Error Scan

Generated: TypeScript & lint scan of the `coding-agent` project.
Scope: real source only (`app/`, `components/`, `lib/`, `types/`, `next.config.ts`).
`.agent_backups/` is excluded from the inventory (backup snapshots, not live source).

---

## 1. TypeScript (`npx tsc --noEmit`)

**Result: ✅ 0 errors (exit 0).** No compile-time errors in the project.

---

## 2. ESLint (`npx eslint app components lib types next.config.ts`)

**Result: ❌ 19 errors, 19 warnings across 11 files (exit 1).**

> Note: `scripts/` contains only `verify.sh` (no lintable JS/TS) and is ignored by ESLint.
> Running `npx eslint .` also lints `.agent_backups/*` (hundreds of stale errors) — those are
> backup files and are NOT part of the live codebase.

### 2.1 Errors (must fix)

| # | File | Line:Col | Rule | Message |
|---|------|----------|------|---------|
| 1 | `app/api/chat/route.ts` | 170:25 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 2 | `app/api/chat/route.ts` | 200:32 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 3 | `app/api/file/route.ts` | 17:15 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 4 | `app/api/git/route.ts` | 16:15 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 5 | `app/api/history/route.ts` | 24:15 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 6 | `app/api/tree/route.ts` | 8:57 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 7 | `app/api/tree/route.ts` | 44:15 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 8 | `app/multi/page.tsx` | 42:28 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 9 | `app/multi/page.tsx` | 80:19 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 10 | `app/multi/page.tsx` | 123:17 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 11 | `app/multi/page.tsx` | 152:9 | `@next/next/no-html-link-for-pages` | Do not use an `<a>` element to navigate to `/`. Use `<Link />` from `next/link` instead |
| 12 | `app/page.tsx` | 9:41 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 13 | `app/page.tsx` | 25:29 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 14 | `app/page.tsx` | 34:40 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 15 | `app/page.tsx` | 136:17 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 16 | `app/page.tsx` | 154:9 | `prefer-const` | `'currentSteps'` is never reassigned. Use `'const'` instead |
| 17 | `app/page.tsx` | 165:28 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 18 | `app/page.tsx` | 226:17 | `@typescript-eslint/no-explicit-any` | Unexpected `any`. Specify a different type |
| 19 | `components/Modal.tsx` | 60:5 | `react-hooks/set-state-in-effect` | Calling `setState` synchronously within an effect can trigger cascading renders |

### 2.2 Warnings (should fix)

| # | File | Line:Col | Rule | Message |
|---|------|----------|------|---------|
| 1 | `app/api/chat/route.ts` | 2:36 | `no-unused-vars` | `'needsApproval'` is defined but never used |
| 2 | `app/api/chat/route.ts` | 2:51 | `no-unused-vars` | `'runVerify'` is defined but never used |
| 3 | `app/api/chat/route.ts` | 2:62 | `no-unused-vars` | `'getPreviewDiff'` is defined but never used |
| 4 | `app/api/chat/route.ts` | 6:3 | `no-unused-vars` | `'ChatCompletionStreamChunk'` is defined but never used |
| 5 | `app/api/chat/route.ts` | 8:3 | `no-unused-vars` | `'ToolArgs'` is defined but never used |
| 6 | `app/api/chat/route.ts` | 9:3 | `no-unused-vars` | `'errorMessage'` is defined but never used |
| 7 | `app/api/chat/route.ts` | 11:8 | `no-unused-vars` | `'fs'` is defined but never used |
| 8 | `app/api/chat/route.ts` | 12:8 | `no-unused-vars` | `'path'` is defined but never used |
| 9 | `app/api/chat/route.ts` | 17:7 | `no-unused-vars` | `'WORKSPACE'` is assigned a value but never used |
| 10 | `app/calculator/page.tsx` | 3:10 | `no-unused-vars` | `'CalculatorButton'` is defined but never used |
| 11 | `app/calculator/page.tsx` | 4:10 | `no-unused-vars` | `'CalculatorDisplay'` is defined but never used |
| 12 | `app/page.tsx` | 56:6 | `react-hooks/exhaustive-deps` | React Hook `useEffect` has a missing dependency: `'loadChat'` |
| 13 | `app/page.tsx` | 136:14 | `no-unused-vars` | `'e'` is defined but never used |
| 14 | `lib/calculator.ts` | 203:7 | `no-unused-vars` | `'BINARY_PRECEDENCE'` is assigned a value but never used |
| 15 | `lib/calculator.ts` | 212:7 | `no-unused-vars` | `'isRightAssociative'` is assigned a value but never used |
| 16 | `lib/calculator.ts` | 505:23 | `no-unused-vars` | `'state'` is defined but never used |
| 17 | `lib/multiAgent.ts` | 8:7 | `no-unused-vars` | `'execAsync'` is assigned a value but never used |
| 18 | `lib/reviewer.ts` | 1:8 | `no-unused-vars` | `'fs'` is defined but never used |
| 19 | `lib/reviewer.ts` | 2:8 | `no-unused-vars` | `'path'` is defined but never used |

---

## 3. Error Categories (grouped for fixing)

### A. `no-explicit-any` — 16 errors (highest priority)
All are `catch (e: any)` blocks or untyped JSON/event payloads. Fix pattern:
- `catch (e: any)` → `catch (e: unknown)` + `e instanceof Error ? e.message : String(e)`.
- Untyped JSON (`let args: any`, `let ev: any`, `onEvent(data: any)`) → define interfaces in `types/index.ts`.

Affected: `app/api/chat/route.ts` (170, 200), `app/api/file/route.ts` (17), `app/api/git/route.ts` (16),
`app/api/history/route.ts` (24), `app/api/tree/route.ts` (8, 44), `app/multi/page.tsx` (42, 80, 123),
`app/page.tsx` (9, 25, 34, 136, 165, 226).

### B. `prefer-const` — 1 error
`app/page.tsx:154` — `let currentSteps` → `const currentSteps` (only `.push()` is used, never reassigned).

### C. `no-html-link-for-pages` — 1 error
`app/multi/page.tsx:152` — `<a href="/">` → `<Link href="/">` from `next/link`.

### D. `react-hooks/set-state-in-effect` — 1 error
`components/Modal.tsx:60` — `setMounted(true)` inside `useEffect`. Fix: use `useSyncExternalStore`
or a `mounted` ref / `typeof window` guard instead of effect-driven state.

### E. `no-unused-vars` — 18 warnings
Dead imports/variables. Safe to remove (verify no side-effect imports first).

### F. `react-hooks/exhaustive-deps` — 1 warning
`app/page.tsx:56` — `useEffect` missing `loadChat` dependency. Wrap `loadChat` in `useCallback` or add to deps.

---

## 4. Summary

| Category | Count |
|----------|-------|
| TypeScript errors | 0 |
| ESLint errors | 19 |
| ESLint warnings | 19 |
| **Total actionable issues** | **38** |

**Verdict:** Project compiles cleanly (tsc ✅). Lint fails with 19 errors — all fixable without
architectural change. No runtime-breaking type errors detected.
