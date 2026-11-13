# Calculator App

A production-grade calculator built with **Next.js 16 (App Router)**, **React 19**, **TypeScript (strict)** and **Tailwind CSS v4**.

The arithmetic engine is a pure, dependency-free TypeScript module (`lib/calculator.ts`) with no DOM or React coupling, so it can be reused by any front-end, CLI or test suite. The UI layer is composed of small, accessible, dark-mode-aware components.

---

## Features

### Calculation engine (`lib/calculator.ts`)

- **Two complementary engines**
  - **Expression engine** — tokenizer → recursive-descent parser → AST evaluator. Supports `+ - * / % ^`, unary `+`/`-`, parentheses, and correct operator precedence with right-associative exponentiation.
  - **Keypad engine** — classic "immediate execution" pocket-calculator model (`KeypadState`) with chained operations, sign toggle, percent and backspace.
- **Structured, typed errors** — every entry point returns a discriminated union (`CalculatorResult`) with machine-readable codes: `EMPTY_EXPRESSION`, `INVALID_CHARACTER`, `INVALID_NUMBER`, `UNEXPECTED_TOKEN`, `UNBALANCED_PARENTHESES`, `DIVISION_BY_ZERO`, `NON_FINITE_RESULT`, `INVALID_ARGUMENT`.
- **No `any`** — exhaustive `switch` statements with `never` checks guarantee every operator and node type is handled.
- **Safe number formatting** — `formatNumber()` trims binary floating-point noise (`0.1 + 0.2` → `0.3`), caps output at 12 characters, and falls back to exponential notation for extreme magnitudes.
- **Overflow & divide-by-zero protection** — non-finite results are rejected rather than silently displayed.

### UI

- **`CalculatorDisplay`** — shows the current value plus the expression history.
- **`CalculatorButton`** — four visual variants: `number`, `operator`, `function`, `equals`.
- **Accessible** — semantic `<button>` elements, `aria-label`s, visible focus rings.
- **Responsive** — mobile-first layout scaling up with `sm:` / `md:` / `lg:` breakpoints.
- **Dark mode** — full `dark:` class support.

---

## Tech Stack

| Layer      | Technology                                    |
| ---------- | --------------------------------------------- |
| Framework  | Next.js 16.4.6 (App Router, Turbopack)        |
| UI         | React 19.3.0                                  |
| Language   | TypeScript 5 (strict mode, no `any`)          |
| Styling    | Tailwind CSS 4.3.3 (`@tailwindcss/turbopack`) |
| Linting    | ESLint 9 + `eslint-config-next`               |

> **Note:** This project uses **Tailwind CSS v4**, which is configured entirely in CSS (`app/globals.css` via `@import "tailwindcss"`). There is **no `tailwind.config.js`** — do not create one.

---

## Getting Started

### Prerequisites

- **Node.js 20+**
- **npm 10+**

### Install dependencies

```bash
npm install
```

### Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. The page hot-reloads as you edit files.

### Production build

```bash
npm run build
```

> The `build` script sets `NODE_ENV=production` explicitly. This is required: Next.js 16 fails to prerender `/_global-error` when `NODE_ENV=development` is inherited from the shell.

### Start the production server

```bash
npm run start
```

### Other scripts

```bash
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
```

---

## Verification

Run the full verification pipeline (type-check, then production build) with:

```bash
./scripts/verify.sh
```

The script exits on the **first** failure, so a non-zero exit code tells you exactly which stage broke.

---

## Project Structure

```
.
├── app/
│   ├── layout.tsx            # Root layout (fonts, metadata, globals)
│   ├── page.tsx              # Main page
│   ├── globals.css           # Tailwind v4 entry point + theme tokens
│   ├── global-error.tsx      # App Router global error boundary
│   └── api/                  # Route handlers (chat, file, git, tree, …)
├── components/
│   ├── CalculatorButton.tsx  # Keypad button (4 variants)
│   ├── CalculatorDisplay.tsx # Value + expression history display
│   ├── Button.tsx            # Generic button primitive
│   ├── Input.tsx             # Generic input primitive
│   ├── Card.tsx              # Surface container
│   ├── Badge.tsx             # Status badge
│   ├── Modal.tsx             # Accessible modal (focus trap, Esc to close)
│   ├── Tooltip.tsx           # Accessible tooltip
│   └── index.ts              # Barrel export
├── lib/
│   ├── calculator.ts         # Pure calculation engine (no React, no DOM)
│   └── index.ts              # Barrel export
├── scripts/
│   └── verify.sh             # Type-check + build verification
├── public/                   # Static assets
├── next.config.ts
├── tsconfig.json
├── eslint.config.mjs
└── package.json
```

### Engine API at a glance

```ts
import { evaluate, formatNumber } from "@/lib/calculator";

evaluate("2 + 3 * (4 - 1)"); // { ok: true, value: 11 }
evaluate("1 / 0");           // { ok: false, error: { code: "DIVISION_BY_ZERO", … } }
formatNumber(0.1 + 0.2);     // "0.3"
```

Keypad engine:

```ts
import { INITIAL_STATE, inputDigit, applyOperator, equals } from "@/lib/calculator";

let state = INITIAL_STATE;
state = inputDigit(state, "2");
state = applyOperator(state, "+");
state = inputDigit(state, "3");
state = equals(state);
state.display; // "5"
```

---

## Keyboard Shortcuts

> **Not yet implemented.** The calculator components (`CalculatorButton`, `CalculatorDisplay`) currently render the keypad but do **not** register any global key handlers, and no calculator route is wired into `app/` yet. Keyboard input is therefore not available today.
>
> The only keyboard interaction that exists in the codebase is `Escape` closing an open `Modal` or `Tooltip` (see `components/Modal.tsx` and `components/Tooltip.tsx`).
>
> When keyboard support is added, the intended mapping is:

| Key                 | Action                                              |
| ------------------- | --------------------------------------------------- |
| `0` – `9`           | Enter a digit                                       |
| `.`                 | Decimal point                                       |
| `+` `-` `*` `/` `%` | Operators (add, subtract, multiply, divide, modulo) |
| `^`                 | Exponent (expression engine)                        |
| `(` `)`             | Parentheses (expression engine)                     |
| `Enter` / `=`       | Evaluate the current expression                     |
| `Backspace`         | Delete the last character                           |
| `Escape`            | Clear all (`AC`)                                    |
| `Delete`            | Clear all (`AC`)                                    |

---

## Code Conventions

- **TypeScript strict mode** — no `any`; use `interface` / `type` and discriminated unions.
- **Tailwind CSS only** — no inline styles, no CSS modules.
- **Named + default exports** for components.
- **`'use client'`** only where hooks or event handlers are used.
- **JSDoc** above every exported function.
- **Semantic HTML** with `aria-label` / `alt` / `role` where appropriate.
- **Responsive & dark-mode ready** — `sm:` / `md:` / `lg:` and `dark:` classes.

---

## License

Private project — not licensed for redistribution.
