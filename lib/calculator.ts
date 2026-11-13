/**
 * Pure TypeScript calculator engine.
 *
 * No UI coupling, no DOM access, no side effects. Everything here is a pure
 * function or a small immutable data structure so it can be reused by any
 * front-end (React, CLI, tests) without modification.
 */

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/** Binary arithmetic operators supported by the engine. */
export type BinaryOperator = "+" | "-" | "*" | "/" | "%" | "^";

/** Unary operators supported by the engine. */
export type UnaryOperator = "+" | "-";

/** Any operator token. */
export type Operator = BinaryOperator | UnaryOperator;

/** A single token produced by the tokenizer. */
export type Token =
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "operator"; readonly value: Operator }
  | { readonly type: "paren"; readonly value: "(" | ")" };

/** A node in the parsed expression tree. */
export type ExpressionNode =
  | { readonly type: "number"; readonly value: number }
  | {
      readonly type: "unary";
      readonly operator: UnaryOperator;
      readonly operand: ExpressionNode;
    }
  | {
      readonly type: "binary";
      readonly operator: BinaryOperator;
      readonly left: ExpressionNode;
      readonly right: ExpressionNode;
    };

/** Machine-readable error codes returned by the engine. */
export type CalculatorErrorCode =
  | "EMPTY_EXPRESSION"
  | "INVALID_CHARACTER"
  | "INVALID_NUMBER"
  | "UNEXPECTED_TOKEN"
  | "UNBALANCED_PARENTHESES"
  | "DIVISION_BY_ZERO"
  | "NON_FINITE_RESULT"
  | "INVALID_ARGUMENT";

/** Successful evaluation result. */
export interface CalculatorSuccess {
  readonly ok: true;
  readonly value: number;
}

/** Failed evaluation result. */
export interface CalculatorFailure {
  readonly ok: false;
  readonly error: CalculatorError;
}

/** Discriminated union returned by every public entry point. */
export type CalculatorResult = CalculatorSuccess | CalculatorFailure;

/** Structured error thrown/returned by the engine. */
export interface CalculatorError {
  readonly code: CalculatorErrorCode;
  readonly message: string;
  /** Zero-based character offset in the source expression, when known. */
  readonly position?: number;
}

/** Options controlling evaluation behaviour. */
export interface EvaluateOptions {
  /**
   * Maximum number of decimal places the result is rounded to.
   * `undefined` (default) disables rounding.
   */
  readonly precision?: number;
  /**
   * When `true`, results that are not finite (Infinity / NaN) are reported as
   * a `NON_FINITE_RESULT` error instead of being returned. Defaults to `true`.
   */
  readonly rejectNonFinite?: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                  Errors                                    */
/* -------------------------------------------------------------------------- */

/** Error class used internally and exposed for consumers that prefer throws. */
export class CalculatorException extends Error {
  public readonly code: CalculatorErrorCode;
  public readonly position?: number;

  public constructor(error: CalculatorError) {
    super(error.message);
    this.name = "CalculatorException";
    this.code = error.code;
    if (error.position !== undefined) {
      this.position = error.position;
    }
  }
}

const fail = (
  code: CalculatorErrorCode,
  message: string,
  position?: number,
): CalculatorFailure => ({
  ok: false,
  error: position === undefined ? { code, message } : { code, message, position },
});

/* -------------------------------------------------------------------------- */
/*                                Tokenizer                                   */
/* -------------------------------------------------------------------------- */

const isDigit = (char: string): boolean => char >= "0" && char <= "9";

const isWhitespace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\n" || char === "\r";

const isBinaryOperator = (char: string): char is BinaryOperator =>
  char === "+" || char === "-" || char === "*" || char === "/" || char === "%" || char === "^";

/**
 * Converts a raw expression string into a flat token list.
 * Returns a `CalculatorFailure` for malformed input.
 */
export function tokenize(input: string): { ok: true; tokens: Token[] } | CalculatorFailure {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index] as string;

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char });
      index += 1;
      continue;
    }

    if (isBinaryOperator(char)) {
      tokens.push({ type: "operator", value: char });
      index += 1;
      continue;
    }

    if (isDigit(char) || char === ".") {
      const start = index;
      let seenDot = false;

      while (index < input.length) {
        const current = input[index] as string;
        if (isDigit(current)) {
          index += 1;
          continue;
        }
        if (current === ".") {
          if (seenDot) {
            return fail("INVALID_NUMBER", `Malformed number at position ${start}`, start);
          }
          seenDot = true;
          index += 1;
          continue;
        }
        break;
      }

      const raw = input.slice(start, index);
      const value = Number(raw);
      if (raw === "." || Number.isNaN(value)) {
        return fail("INVALID_NUMBER", `Malformed number "${raw}" at position ${start}`, start);
      }
      tokens.push({ type: "number", value });
      continue;
    }

    return fail(
      "INVALID_CHARACTER",
      `Unexpected character "${char}" at position ${index}`,
      index,
    );
  }

  return { ok: true, tokens };
}

/* -------------------------------------------------------------------------- */
/*                                  Parser                                    */
/* -------------------------------------------------------------------------- */

const BINARY_PRECEDENCE: Record<BinaryOperator, number> = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2,
  "%": 2,
  "^": 3,
};

const isRightAssociative = (operator: BinaryOperator): boolean => operator === "^";

interface ParserState {
  readonly tokens: readonly Token[];
  index: number;
}

const peek = (state: ParserState): Token | undefined => state.tokens[state.index];

/**
 * Recursive-descent parser producing an `ExpressionNode` tree.
 * Grammar (lowest to highest precedence):
 *   expression := term (('+' | '-') term)*
 *   term       := power (('*' | '/' | '%') power)*
 *   power      := unary ('^' power)?          // right associative
 *   unary      := ('+' | '-') unary | primary
 *   primary    := number | '(' expression ')'
 */
function parseExpression(state: ParserState): ExpressionNode | CalculatorFailure {
  let left = parseTerm(state);
  if (!isNode(left)) return left;

  for (;;) {
    const token = peek(state);
    if (token?.type !== "operator" || (token.value !== "+" && token.value !== "-")) break;
    state.index += 1;
    const right = parseTerm(state);
    if (!isNode(right)) return right;
    left = { type: "binary", operator: token.value, left, right };
  }

  return left;
}

function parseTerm(state: ParserState): ExpressionNode | CalculatorFailure {
  let left = parsePower(state);
  if (!isNode(left)) return left;

  for (;;) {
    const token = peek(state);
    if (
      token?.type !== "operator" ||
      (token.value !== "*" && token.value !== "/" && token.value !== "%")
    ) {
      break;
    }
    state.index += 1;
    const right = parsePower(state);
    if (!isNode(right)) return right;
    left = { type: "binary", operator: token.value, left, right };
  }

  return left;
}

function parsePower(state: ParserState): ExpressionNode | CalculatorFailure {
  const base = parseUnary(state);
  if (!isNode(base)) return base;

  const token = peek(state);
  if (token?.type === "operator" && token.value === "^") {
    state.index += 1;
    const exponent = parsePower(state);
    if (!isNode(exponent)) return exponent;
    return { type: "binary", operator: "^", left: base, right: exponent };
  }

  return base;
}

function parseUnary(state: ParserState): ExpressionNode | CalculatorFailure {
  const token = peek(state);
  if (token?.type === "operator" && (token.value === "+" || token.value === "-")) {
    state.index += 1;
    const operand = parseUnary(state);
    if (!isNode(operand)) return operand;
    return { type: "unary", operator: token.value, operand };
  }
  return parsePrimary(state);
}

function parsePrimary(state: ParserState): ExpressionNode | CalculatorFailure {
  const token = peek(state);

  if (token === undefined) {
    return fail("UNEXPECTED_TOKEN", "Unexpected end of expression");
  }

  if (token.type === "number") {
    state.index += 1;
    return { type: "number", value: token.value };
  }

  if (token.type === "paren" && token.value === "(") {
    state.index += 1;
    const inner = parseExpression(state);
    if (!isNode(inner)) return inner;
    const closing = peek(state);
    if (closing?.type !== "paren" || closing.value !== ")") {
      return fail("UNBALANCED_PARENTHESES", "Missing closing parenthesis");
    }
    state.index += 1;
    return inner;
  }

  return fail("UNEXPECTED_TOKEN", `Unexpected token "${String(token.value)}"`);
}

/** Type guard distinguishing a parsed node from a failure result. */
function isNode(value: ExpressionNode | CalculatorFailure): value is ExpressionNode {
  return !("ok" in value);
}

/**
 * Parses an expression string into an AST.
 */
export function parse(input: string): { ok: true; ast: ExpressionNode } | CalculatorFailure {
  if (input.trim() === "") {
    return fail("EMPTY_EXPRESSION", "Expression is empty");
  }

  const tokenized = tokenize(input);
  if (!tokenized.ok) return tokenized;

  const state: ParserState = { tokens: tokenized.tokens, index: 0 };
  const ast = parseExpression(state);
  if (!isNode(ast)) return ast;

  if (state.index < state.tokens.length) {
    const leftover = state.tokens[state.index];
    return fail(
      "UNEXPECTED_TOKEN",
      `Unexpected token "${String(leftover?.value)}" after expression`,
    );
  }

  return { ok: true, ast };
}

/* -------------------------------------------------------------------------- */
/*                                Operations                                  */
/* -------------------------------------------------------------------------- */

/**
 * Applies a binary operator to two numbers.
 * Returns a `CalculatorFailure` for division/modulo by zero.
 */
export function applyBinaryOperator(
  operator: BinaryOperator,
  left: number,
  right: number,
): CalculatorResult {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return fail("INVALID_ARGUMENT", "Operands must be finite numbers");
  }

  switch (operator) {
    case "+":
      return { ok: true, value: left + right };
    case "-":
      return { ok: true, value: left - right };
    case "*":
      return { ok: true, value: left * right };
    case "/":
      if (right === 0) return fail("DIVISION_BY_ZERO", "Division by zero");
      return { ok: true, value: left / right };
    case "%":
      if (right === 0) return fail("DIVISION_BY_ZERO", "Modulo by zero");
      return { ok: true, value: left % right };
    case "^":
      return { ok: true, value: left ** right };
    default: {
      const exhaustive: never = operator;
      return fail("INVALID_ARGUMENT", `Unsupported operator "${String(exhaustive)}"`);
    }
  }
}

/** Applies a unary operator to a number. */
export function applyUnaryOperator(operator: UnaryOperator, operand: number): CalculatorResult {
  if (!Number.isFinite(operand)) {
    return fail("INVALID_ARGUMENT", "Operand must be a finite number");
  }
  return { ok: true, value: operator === "-" ? -operand : operand };
}

/* -------------------------------------------------------------------------- */
/*                                Evaluation                                  */
/* -------------------------------------------------------------------------- */

/** Recursively evaluates a parsed AST. */
export function evaluateNode(node: ExpressionNode): CalculatorResult {
  switch (node.type) {
    case "number":
      return { ok: true, value: node.value };
    case "unary": {
      const operand = evaluateNode(node.operand);
      if (!operand.ok) return operand;
      return applyUnaryOperator(node.operator, operand.value);
    }
    case "binary": {
      const left = evaluateNode(node.left);
      if (!left.ok) return left;
      const right = evaluateNode(node.right);
      if (!right.ok) return right;
      return applyBinaryOperator(node.operator, left.value, right.value);
    }
    default: {
      const exhaustive: never = node;
      return fail("INVALID_ARGUMENT", `Unsupported node "${String(exhaustive)}"`);
    }
  }
}

const roundTo = (value: number, precision: number): number => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

/**
 * Evaluates a raw expression string end-to-end (tokenize → parse → evaluate).
 *
 * @example
 * evaluate("2 + 3 * (4 - 1)") // { ok: true, value: 11 }
 * evaluate("1 / 0")           // { ok: false, error: { code: "DIVISION_BY_ZERO", ... } }
 */
export function evaluate(input: string, options: EvaluateOptions = {}): CalculatorResult {
  const parsed = parse(input);
  if (!parsed.ok) return parsed;

  const result = evaluateNode(parsed.ast);
  if (!result.ok) return result;

  const rejectNonFinite = options.rejectNonFinite ?? true;
  if (rejectNonFinite && !Number.isFinite(result.value)) {
    return fail("NON_FINITE_RESULT", "Result is not a finite number");
  }

  const { precision } = options;
  if (precision !== undefined) {
    if (!Number.isInteger(precision) || precision < 0 || precision > 15) {
      return fail("INVALID_ARGUMENT", "precision must be an integer between 0 and 15");
    }
    return { ok: true, value: roundTo(result.value, precision) };
  }

  return result;
}

/**
 * Convenience wrapper that throws a `CalculatorException` on failure.
 * Useful for callers that prefer exceptions over result objects.
 */
export function evaluateOrThrow(input: string, options: EvaluateOptions = {}): number {
  const result = evaluate(input, options);
  if (!result.ok) throw new CalculatorException(result.error);
  return result.value;
}

/* -------------------------------------------------------------------------- */
/*                          Stateful calculator helper                        */
/* -------------------------------------------------------------------------- */

/**
 * Small immutable-ish helper for building expressions incrementally
 * (e.g. from keypad button presses) without any UI dependency.
 */
export interface CalculatorState {
  readonly expression: string;
  readonly lastResult: number | null;
}

export const initialCalculatorState: CalculatorState = {
  expression: "",
  lastResult: null,
};

/** Appends a raw token/character to the current expression. */
export function appendInput(state: CalculatorState, input: string): CalculatorState {
  return { ...state, expression: state.expression + input };
}

/**
 * Removes the last character of the current expression.
 *
 * @param state - Current calculator state.
 * @returns The next state with the trailing character removed.
 */
export function backspaceExpression(state: CalculatorState): CalculatorState {
  return { ...state, expression: state.expression.slice(0, -1) };
}

/** Clears the expression and the last result. */
export function clear(state: CalculatorState): CalculatorState {
  return initialCalculatorState;
}

/**
 * Evaluates the current expression. On success the expression is replaced by
 * the result so chained calculations work naturally; on failure the state is
 * returned unchanged along with the error.
 */
export function commit(
  state: CalculatorState,
  options: EvaluateOptions = {},
): { state: CalculatorState; result: CalculatorResult } {
  const result = evaluate(state.expression, options);
  if (!result.ok) {
    return { state, result };
  }
  return {
    state: { expression: String(result.value), lastResult: result.value },
    result,
  };
}

/* -------------------------------------------------------------------------- */
/*                        Keypad engine (display state)                       */
/* -------------------------------------------------------------------------- */

/**
 * Binary operators supported by the keypad engine.
 *
 * `%` is treated as a binary modulo operator (e.g. `10 % 3 === 1`).
 */
export type KeypadOperator = "+" | "-" | "*" | "/" | "%";

/**
 * Immutable state of a keypad-driven calculator.
 *
 * The engine follows the classic "immediate execution" model used by pocket
 * calculators: pressing an operator folds the pending operation into
 * `previous`, so chained input such as `2 + 3 + 4` evaluates left-to-right.
 */
export interface KeypadState {
  /** Text currently shown on the display (never empty). */
  readonly display: string;
  /** Left-hand operand of the pending operation, or `null` when none. */
  readonly previous: number | null;
  /** Pending operator, or `null` when none. */
  readonly operator: KeypadOperator | null;
  /** `true` when the next digit should start a fresh operand. */
  readonly waitingForOperand: boolean;
  /** Human-readable expression history, e.g. `"2 + 3"`. */
  readonly expression: string;
}

/** Maximum number of characters rendered by {@link formatNumber}. */
const MAX_DISPLAY_LENGTH = 12;

/** Largest magnitude that can be shown without switching to exponent form. */
const MAX_PLAIN_MAGNITUDE = 1e12;

/** Smallest non-zero magnitude that can be shown without exponent form. */
const MIN_PLAIN_MAGNITUDE = 1e-9;

/** Display text used when a result overflows the representable range. */
const OVERFLOW_DISPLAY = "Error";

/** Display text used when a computation is mathematically undefined. */
const ERROR_DISPLAY = "Error";

/** Symbol shown in the expression history for each operator. */
const OPERATOR_SYMBOL: Record<KeypadOperator, string> = {
  "+": "+",
  "-": "−",
  "*": "×",
  "/": "÷",
  "%": "%",
};

/** The pristine state returned by {@link clearAll}. */
export const INITIAL_STATE: KeypadState = {
  display: "0",
  previous: null,
  operator: null,
  waitingForOperand: false,
  expression: "",
};

/**
 * Applies a binary operator to two numbers.
 *
 * @param a - Left operand.
 * @param op - Operator to apply.
 * @param b - Right operand.
 * @returns The arithmetic result.
 * @throws {RangeError} When dividing (or taking modulo) by zero.
 * @throws {RangeError} When either operand is not a finite number.
 * @throws {RangeError} When the result overflows the finite number range.
 *
 * @example
 * calculate(6, "*", 7); // 42
 * calculate(1, "/", 0); // throws RangeError: Cannot divide by zero
 */
export function calculate(a: number, op: KeypadOperator, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new RangeError("Operands must be finite numbers");
  }

  let result: number;

  switch (op) {
    case "+":
      result = a + b;
      break;
    case "-":
      result = a - b;
      break;
    case "*":
      result = a * b;
      break;
    case "/":
      if (b === 0) {
        throw new RangeError("Cannot divide by zero");
      }
      result = a / b;
      break;
    case "%":
      if (b === 0) {
        throw new RangeError("Cannot divide by zero (modulo)");
      }
      result = a % b;
      break;
    default: {
      const exhaustive: never = op;
      throw new RangeError(`Unsupported operator "${String(exhaustive)}"`);
    }
  }

  if (!Number.isFinite(result)) {
    throw new RangeError("Result is too large to represent");
  }

  return result;
}

/**
 * Formats a number for display, capped at 12 characters.
 *
 * - Integers and short decimals are shown as-is.
 * - Floating-point noise is trimmed (e.g. `0.1 + 0.2` → `0.3`).
 * - Very large / very small magnitudes fall back to exponential notation.
 * - Non-finite values render as `"Error"`.
 *
 * @param n - The number to format.
 * @returns A display-safe string of at most 12 characters.
 *
 * @example
 * formatNumber(0.1 + 0.2); // "0.3"
 * formatNumber(1e21);      // "1e+21"
 * formatNumber(NaN);       // "Error"
 */
export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return ERROR_DISPLAY;
  if (!Number.isFinite(n)) return OVERFLOW_DISPLAY;
  if (n === 0) return "0";

  const magnitude = Math.abs(n);

  if (magnitude >= MAX_PLAIN_MAGNITUDE || magnitude < MIN_PLAIN_MAGNITUDE) {
    return n.toExponential(5).replace(/\.?0+e/, "e");
  }

  // Trim binary floating-point noise (e.g. 0.30000000000000004 → 0.3).
  const cleaned = Number.parseFloat(n.toPrecision(12));
  let text = String(cleaned);

  if (text.length > MAX_DISPLAY_LENGTH) {
    const decimals = Math.max(0, MAX_DISPLAY_LENGTH - String(Math.trunc(cleaned)).length - 1);
    text = cleaned.toFixed(decimals).replace(/\.?0+$/, "");
  }

  if (text.length > MAX_DISPLAY_LENGTH) {
    text = cleaned.toExponential(5).replace(/\.?0+e/, "e");
  }

  return text;
}

/** Parses the current display text into a number, tolerating `"Error"`. */
const parseDisplay = (display: string): number => {
  const value = Number(display);
  return Number.isFinite(value) ? value : 0;
};

/** Builds the expression history string for a pending operation. */
const buildExpression = (previous: number | null, operator: KeypadOperator | null): string =>
  previous === null || operator === null
    ? ""
    : `${formatNumber(previous)} ${OPERATOR_SYMBOL[operator]}`;

/** Returns a state representing an unrecoverable calculation error. */
const errorState = (expression: string): KeypadState => ({
  display: ERROR_DISPLAY,
  previous: null,
  operator: null,
  waitingForOperand: true,
  expression,
});

/**
 * Handles an operator key press.
 *
 * If an operation is already pending, it is evaluated first (chained
 * operations). Pressing the same operator twice simply replaces it.
 *
 * @param state - Current calculator state.
 * @param op - Operator that was pressed.
 * @returns The next calculator state.
 *
 * @example
 * applyOperator(inputDigit(INITIAL_STATE, "2"), "+"); // display "2", operator "+"
 */
export function applyOperator(state: KeypadState, op: KeypadOperator): KeypadState {
  const current = parseDisplay(state.display);

  // Replace a pending operator when the user changes their mind.
  if (state.waitingForOperand && state.operator !== null) {
    return {
      ...state,
      operator: op,
      expression: buildExpression(state.previous, op),
    };
  }

  if (state.previous === null || state.operator === null) {
    return {
      display: formatNumber(current),
      previous: current,
      operator: op,
      waitingForOperand: true,
      expression: buildExpression(current, op),
    };
  }

  const expression = `${formatNumber(state.previous)} ${OPERATOR_SYMBOL[state.operator]} ${formatNumber(current)}`;

  try {
    const result = calculate(state.previous, state.operator, current);
    return {
      display: formatNumber(result),
      previous: result,
      operator: op,
      waitingForOperand: true,
      expression: buildExpression(result, op),
    };
  } catch {
    return errorState(expression);
  }
}

/**
 * Handles a digit key press (`0`–`9`).
 *
 * @param state - Current calculator state.
 * @param digit - Single character between `"0"` and `"9"`.
 * @returns The next calculator state (unchanged for invalid input).
 *
 * @example
 * inputDigit(INITIAL_STATE, "7").display; // "7"
 */
export function inputDigit(state: KeypadState, digit: string): KeypadState {
  if (!/^[0-9]$/.test(digit)) return state;

  if (state.waitingForOperand) {
    return {
      ...state,
      display: digit,
      waitingForOperand: false,
    };
  }

  if (state.display === "0") {
    return { ...state, display: digit };
  }

  if (state.display.replace(/[-.]/g, "").length >= MAX_DISPLAY_LENGTH) {
    return state;
  }

  return { ...state, display: `${state.display}${digit}` };
}

/**
 * Handles the decimal point key.
 *
 * @param state - Current calculator state.
 * @returns The next calculator state; a no-op when a decimal point already exists.
 *
 * @example
 * inputDecimal(INITIAL_STATE).display; // "0."
 */
export function inputDecimal(state: KeypadState): KeypadState {
  if (state.waitingForOperand) {
    return { ...state, display: "0.", waitingForOperand: false };
  }
  if (state.display.includes(".")) return state;
  return { ...state, display: `${state.display}.` };
}

/**
 * Resets the calculator to its initial state.
 *
 * @returns A fresh {@link INITIAL_STATE}.
 */
export function clearAll(): KeypadState {
  return INITIAL_STATE;
}

/**
 * Deletes the last character of the current operand.
 *
 * Named `backspaceKeypad` to avoid colliding with the expression-level
 * {@link backspaceExpression} helper that operates on {@link CalculatorState}.
 *
 * @param state - Current calculator state.
 * @returns The next calculator state; falls back to `"0"` when emptied.
 */
export function backspaceKeypad(state: KeypadState): KeypadState {
  if (state.waitingForOperand) return state;

  const next = state.display.slice(0, -1);
  if (next === "" || next === "-") {
    return { ...state, display: "0", waitingForOperand: false };
  }
  return { ...state, display: next };
}

/**
 * Toggles the sign of the current operand.
 *
 * @param state - Current calculator state.
 * @returns The next calculator state with a negated display value.
 */
export function toggleSign(state: KeypadState): KeypadState {
  if (state.display === "0" || state.display === ERROR_DISPLAY) return state;

  const next = state.display.startsWith("-")
    ? state.display.slice(1)
    : `-${state.display}`;

  return { ...state, display: next };
}

/**
 * Converts the current operand to a percentage (divides by 100).
 *
 * @param state - Current calculator state.
 * @returns The next calculator state showing the percentage value.
 */
export function percent(state: KeypadState): KeypadState {
  const current = parseDisplay(state.display);
  const result = current / 100;

  if (!Number.isFinite(result)) return errorState(state.expression);

  return {
    ...state,
    display: formatNumber(result),
    waitingForOperand: false,
  };
}

/**
 * Evaluates the pending operation (the `=` key).
 *
 * @param state - Current calculator state.
 * @returns The next calculator state showing the result.
 *
 * @example
 * // 2 + 3 =
 * equals(applyOperator(inputDigit(INITIAL_STATE, "2"), "+")).display; // "2"
 */
export function equals(state: KeypadState): KeypadState {
  if (state.previous === null || state.operator === null) {
    return { ...state, waitingForOperand: true };
  }

  const current = parseDisplay(state.display);
  const expression = `${formatNumber(state.previous)} ${OPERATOR_SYMBOL[state.operator]} ${formatNumber(current)} =`;

  try {
    const result = calculate(state.previous, state.operator, current);
    return {
      display: formatNumber(result),
      previous: null,
      operator: null,
      waitingForOperand: true,
      expression,
    };
  } catch {
    return errorState(expression);
  }
}
