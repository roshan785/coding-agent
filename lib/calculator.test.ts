/**
 * Lightweight, dependency-free test suite for the calculator engine.
 *
 * Run with Node's built-in TypeScript support (Node >= 22.6):
 *
 *   node --experimental-strip-types lib/calculator.test.ts
 *
 * or, if the project has `tsx` available:
 *
 *   npx tsx lib/calculator.test.ts
 *
 * The suite uses only `node:assert` and `node:test`-free plain assertions so it
 * works in any environment without installing a test runner. It exits with a
 * non-zero status code when any assertion fails.
 */

import assert from "node:assert/strict";

import {
  evaluate,
  calculate,
  formatNumber,
  type CalculatorResult,
  type Operator,
  type CalculatorState,
  type KeypadOperator,
} from "./calculator.ts";

/* -------------------------------------------------------------------------- */
/*                              Tiny test harness                             */
/* -------------------------------------------------------------------------- */

interface TestCase {
  readonly name: string;
  readonly run: () => void;
}

const tests: TestCase[] = [];

/** Registers a test case. */
const test = (name: string, run: () => void): void => {
  tests.push({ name, run });
};

/** Asserts that an evaluation succeeded and returns its numeric value. */
const expectValue = (result: CalculatorResult, expected: number): void => {
  assert.equal(result.ok, true, `expected success, got error: ${JSON.stringify(result)}`);
  if (!result.ok) return; // narrows the union for TypeScript
  assert.equal(result.value, expected);
};

/** Asserts that an evaluation failed with the given error code. */
const expectError = (result: CalculatorResult, code: string): void => {
  assert.equal(result.ok, false, `expected failure, got value: ${JSON.stringify(result)}`);
  if (result.ok) return;
  assert.equal(result.error.code, code);
};

/* -------------------------------------------------------------------------- */
/*                                  Addition                                  */
/* -------------------------------------------------------------------------- */

test("addition: 2 + 3 = 5", () => {
  expectValue(evaluate("2 + 3"), 5);
});

test("addition: multiple operands 1 + 2 + 3 + 4 = 10", () => {
  expectValue(evaluate("1 + 2 + 3 + 4"), 10);
});

test("addition: whitespace is ignored", () => {
  expectValue(evaluate("  7+8  "), 15);
});

/* -------------------------------------------------------------------------- */
/*                                 Subtraction                                */
/* -------------------------------------------------------------------------- */

test("subtraction: 10 - 4 = 6", () => {
  expectValue(evaluate("10 - 4"), 6);
});

test("subtraction: result can be negative 3 - 8 = -5", () => {
  expectValue(evaluate("3 - 8"), -5);
});

test("subtraction: chained 20 - 5 - 5 = 10", () => {
  expectValue(evaluate("20 - 5 - 5"), 10);
});

/* -------------------------------------------------------------------------- */
/*                               Multiplication                               */
/* -------------------------------------------------------------------------- */

test("multiplication: 6 * 7 = 42", () => {
  expectValue(evaluate("6 * 7"), 42);
});

test("multiplication: precedence 2 + 3 * 4 = 14", () => {
  expectValue(evaluate("2 + 3 * 4"), 14);
});

test("multiplication: parentheses override precedence (2 + 3) * 4 = 20", () => {
  expectValue(evaluate("(2 + 3) * 4"), 20);
});

/* -------------------------------------------------------------------------- */
/*                                  Division                                  */
/* -------------------------------------------------------------------------- */

test("division: 20 / 4 = 5", () => {
  expectValue(evaluate("20 / 4"), 5);
});

test("division: precedence 10 - 8 / 2 = 6", () => {
  expectValue(evaluate("10 - 8 / 2"), 6);
});

test("division: left-to-right 100 / 5 / 2 = 10", () => {
  expectValue(evaluate("100 / 5 / 2"), 10);
});

/* -------------------------------------------------------------------------- */
/*                                  Decimals                                  */
/* -------------------------------------------------------------------------- */

test("decimals: 1.5 + 2.25 = 3.75", () => {
  expectValue(evaluate("1.5 + 2.25"), 3.75);
});

test("decimals: leading dot .5 + .5 = 1", () => {
  expectValue(evaluate(".5 + .5"), 1);
});

test("decimals: 0.1 * 3 rounds cleanly with precision option", () => {
  expectValue(evaluate("0.1 * 3", { precision: 10 }), 0.3);
});

test("decimals: 7.5 / 2.5 = 3", () => {
  expectValue(evaluate("7.5 / 2.5"), 3);
});

/* -------------------------------------------------------------------------- */
/*                                Unary minus                                 */
/* -------------------------------------------------------------------------- */

test("unary minus: -5 + 3 = -2", () => {
  expectValue(evaluate("-5 + 3"), -2);
});

test("unary minus: 4 * -2 = -8", () => {
  expectValue(evaluate("4 * -2"), -8);
});

test("unary minus: double negation --7 = 7", () => {
  expectValue(evaluate("--7"), 7);
});

test("unary minus: -(2 + 3) = -5", () => {
  expectValue(evaluate("-(2 + 3)"), -5);
});

/* -------------------------------------------------------------------------- */
/*                                Error cases                                 */
/* -------------------------------------------------------------------------- */

test("error: division by zero returns DIVISION_BY_ZERO", () => {
  expectError(evaluate("1 / 0"), "DIVISION_BY_ZERO");
});

test("error: division by zero inside expression 5 + 3 / 0", () => {
  expectError(evaluate("5 + 3 / 0"), "DIVISION_BY_ZERO");
});

test("error: empty expression returns EMPTY_EXPRESSION", () => {
  expectError(evaluate(""), "EMPTY_EXPRESSION");
});

test("error: whitespace-only expression returns EMPTY_EXPRESSION", () => {
  expectError(evaluate("   "), "EMPTY_EXPRESSION");
});

test("error: invalid character returns INVALID_CHARACTER", () => {
  expectError(evaluate("2 + a"), "INVALID_CHARACTER");
});

test("error: malformed number returns INVALID_NUMBER", () => {
  expectError(evaluate("1.2.3"), "INVALID_NUMBER");
});

test("error: trailing operator returns UNEXPECTED_TOKEN", () => {
  expectError(evaluate("2 +"), "UNEXPECTED_TOKEN");
});

test("error: unbalanced parentheses returns UNBALANCED_PARENTHESES", () => {
  expectError(evaluate("(2 + 3"), "UNBALANCED_PARENTHESES");
});

test("error: result is never NaN for valid input", () => {
  const result = evaluate("2 * 3");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(Number.isNaN(result.value), false);
});

/* -------------------------------------------------------------------------- */
/*                          Keypad helpers & formatting                       */
/* -------------------------------------------------------------------------- */

test("calculate: applies each keypad operator", () => {
  const cases: ReadonlyArray<readonly [number, KeypadOperator, number, number]> = [
    [2, "+", 3, 5],
    [9, "-", 4, 5],
    [6, "*", 7, 42],
    [8, "/", 2, 4],
    [10, "%", 3, 1],
  ];
  for (const [a, op, b, expected] of cases) {
    assert.equal(calculate(a, op, b), expected);
  }
});

test("calculate: throws RangeError on division by zero", () => {
  assert.throws(() => calculate(1, "/", 0), RangeError);
});

test("formatNumber: trims floating point noise", () => {
  assert.equal(formatNumber(0.1 + 0.2), "0.3");
});

test("formatNumber: renders non-finite values as Error", () => {
  assert.equal(formatNumber(Number.NaN), "Error");
  assert.equal(formatNumber(Number.POSITIVE_INFINITY), "Error");
});

/* -------------------------------------------------------------------------- */
/*                            Type-level smoke checks                         */
/* -------------------------------------------------------------------------- */

test("types: Operator and CalculatorState are usable", () => {
  const operator: Operator = "-";
  const state: CalculatorState = { expression: "1 + 1", lastResult: null };
  assert.equal(operator, "-");
  assert.equal(state.expression, "1 + 1");
});

/* -------------------------------------------------------------------------- */
/*                                   Runner                                   */
/* -------------------------------------------------------------------------- */

let passed = 0;
const failures: string[] = [];

for (const { name, run } of tests) {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}\n      ${message}`);
    console.error(`  ✗ ${name}`);
    console.error(`      ${message}`);
  }
}

console.log(`\n${passed}/${tests.length} tests passed`);

if (failures.length > 0) {
  console.error(`\n${failures.length} failing test(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}
