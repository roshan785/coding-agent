#!/usr/bin/env bash
#
# verify.sh — Full verification pipeline for the calculator app.
#
# Runs, in order:
#   1. npx tsc --noEmit   (TypeScript type-check, no output emitted)
#   2. npm run build      (Next.js production build)
#
# Exits immediately with the failing stage's exit code on the first failure.
#
# Usage:
#   ./scripts/verify.sh
#   bash scripts/verify.sh
#
set -euo pipefail

# Resolve the project root regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

# ANSI colours (disabled automatically when not writing to a terminal).
if [ -t 1 ]; then
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  BLUE=$'\033[0;34m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED=''
  GREEN=''
  BLUE=''
  BOLD=''
  RESET=''
fi

step() {
  printf '\n%s%s==> %s%s\n' "${BOLD}" "${BLUE}" "$1" "${RESET}"
}

pass() {
  printf '%s✔ %s%s\n' "${GREEN}" "$1" "${RESET}"
}

fail() {
  printf '%s✘ %s%s\n' "${RED}" "$1" "${RESET}" >&2
}

# ---------------------------------------------------------------------------
# Stage 1 — TypeScript type-check
# ---------------------------------------------------------------------------
step "Stage 1/2: TypeScript type-check (npx tsc --noEmit)"
if npx tsc --noEmit; then
  pass "Type-check passed."
else
  status=$?
  fail "Type-check FAILED (exit ${status}). Aborting."
  exit "${status}"
fi

# ---------------------------------------------------------------------------
# Stage 2 — Production build
# ---------------------------------------------------------------------------
step "Stage 2/2: Production build (npm run build)"
if npm run build; then
  pass "Build passed."
else
  status=$?
  fail "Build FAILED (exit ${status}). Aborting."
  exit "${status}"
fi

printf '\n%s%s✔ All checks passed.%s\n' "${BOLD}" "${GREEN}" "${RESET}"
exit 0
