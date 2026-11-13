'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { evaluate, type CalculatorResult } from '@/lib/calculator';

/**
 * Visual style of a keypad button. Mirrors the classic calculator layout:
 * - `number`   → digit keys (0-9) and the decimal point
 * - `operator` → arithmetic operators (+, -, *, /, %)
 * - `function` → utility keys (AC, DEL, parentheses)
 * - `equals`   → the "=" key
 */
export type ButtonVariant = 'number' | 'operator' | 'function' | 'equals';

/**
 * Describes a single keypad button.
 *
 * `action` is a discriminated tag that the component maps to a state
 * transition. Keeping the action as data (rather than an inline closure)
 * lets the same configuration drive both the rendered keypad and the
 * keyboard handler.
 */
export interface ButtonConfig {
  /** Visible label rendered inside the button, e.g. `"7"`, `"+"`, `"AC"`. */
  label: string;
  /** The token appended to the expression, or a control action tag. */
  action: ButtonAction;
  /** Visual style of the button. */
  variant: ButtonVariant;
  /** Accessible name for screen readers. Falls back to `label` when omitted. */
  ariaLabel?: string;
  /** Optional Tailwind grid-span class (used by the wide "=" key). */
  className?: string;
}

/**
 * The set of actions a button can trigger.
 *
 * - `digit` / `operator` / `paren` / `decimal` append a token to the expression.
 * - `clear` resets the expression.
 * - `delete` removes the last character.
 * - `equals` evaluates the current expression.
 */
export type ButtonAction =
  | { readonly kind: 'digit'; readonly value: string }
  | { readonly kind: 'operator'; readonly value: string }
  | { readonly kind: 'paren'; readonly value: '(' | ')' }
  | { readonly kind: 'decimal' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'equals' };

/** Props accepted by {@link Calculator}. */
export interface CalculatorProps {
  /** Optional Tailwind classes appended to the outer wrapper. */
  className?: string;
}

/** Maximum number of characters allowed in the expression buffer. */
const MAX_EXPRESSION_LENGTH = 64;

/** The static keypad layout, in reading order. */
const BUTTONS: readonly ButtonConfig[] = [
  { label: 'AC', action: { kind: 'clear' }, variant: 'function', ariaLabel: 'All clear' },
  { label: 'DEL', action: { kind: 'delete' }, variant: 'function', ariaLabel: 'Delete last character' },
  { label: '(', action: { kind: 'paren', value: '(' }, variant: 'function', ariaLabel: 'Open parenthesis' },
  { label: ')', action: { kind: 'paren', value: ')' }, variant: 'function', ariaLabel: 'Close parenthesis' },

  { label: '7', action: { kind: 'digit', value: '7' }, variant: 'number' },
  { label: '8', action: { kind: 'digit', value: '8' }, variant: 'number' },
  { label: '9', action: { kind: 'digit', value: '9' }, variant: 'number' },
  { label: '/', action: { kind: 'operator', value: '/' }, variant: 'operator', ariaLabel: 'Divide' },

  { label: '4', action: { kind: 'digit', value: '4' }, variant: 'number' },
  { label: '5', action: { kind: 'digit', value: '5' }, variant: 'number' },
  { label: '6', action: { kind: 'digit', value: '6' }, variant: 'number' },
  { label: '*', action: { kind: 'operator', value: '*' }, variant: 'operator', ariaLabel: 'Multiply' },

  { label: '1', action: { kind: 'digit', value: '1' }, variant: 'number' },
  { label: '2', action: { kind: 'digit', value: '2' }, variant: 'number' },
  { label: '3', action: { kind: 'digit', value: '3' }, variant: 'number' },
  { label: '-', action: { kind: 'operator', value: '-' }, variant: 'operator', ariaLabel: 'Subtract' },

  { label: '0', action: { kind: 'digit', value: '0' }, variant: 'number' },
  { label: '.', action: { kind: 'decimal' }, variant: 'number', ariaLabel: 'Decimal point' },
  { label: '%', action: { kind: 'operator', value: '%' }, variant: 'operator', ariaLabel: 'Modulo' },
  { label: '+', action: { kind: 'operator', value: '+' }, variant: 'operator', ariaLabel: 'Add' },

  {
    label: '=',
    action: { kind: 'equals' },
    variant: 'equals',
    ariaLabel: 'Equals',
    className: 'col-span-4',
  },
];

/** Tailwind classes for each button variant. */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  number: 'bg-slate-700 text-white hover:bg-slate-600 active:bg-slate-500',
  operator: 'bg-orange-500 text-white hover:bg-orange-400 active:bg-orange-600',
  function: 'bg-slate-500 text-white hover:bg-slate-400 active:bg-slate-600',
  equals: 'bg-orange-600 text-white hover:bg-orange-500 active:bg-orange-700',
};

/**
 * Formats a numeric result for display, trimming floating-point noise while
 * preserving very large / very small magnitudes.
 *
 * @param value - The numeric result to format.
 * @returns A human-readable string representation.
 */
function formatResult(value: number): string {
  if (!Number.isFinite(value)) return 'Error';
  // Round to 12 significant digits to hide binary floating-point artifacts.
  const rounded = Number.parseFloat(value.toPrecision(12));
  return String(rounded);
}

/**
 * Calculator
 *
 * A fully client-side calculator UI built with Tailwind CSS. It maintains the
 * raw expression string in React state, renders a display area plus a keypad
 * of digit, operator, parenthesis and control buttons, and evaluates the
 * expression through the pure `evaluate` function from `lib/calculator.ts`.
 *
 * Keyboard input is supported via a `keydown` listener: digits, operators,
 * parentheses, `.`, `Enter`/`=`, `Backspace` and `Escape` are all mapped to
 * the same actions as the on-screen buttons.
 *
 * @example
 * ```tsx
 * <Calculator />
 * ```
 */
export function Calculator({ className }: CalculatorProps): React.JSX.Element {
  const [expression, setExpression] = useState<string>('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Applies a single button action to the calculator state. */
  const dispatch = useCallback((action: ButtonAction): void => {
    setError(null);

    switch (action.kind) {
      case 'clear':
        setExpression('');
        setResult(null);
        return;

      case 'delete':
        setExpression((prev) => prev.slice(0, -1));
        setResult(null);
        return;

      case 'equals': {
        setExpression((prev) => {
          if (prev.trim() === '') return prev;
          const outcome: CalculatorResult = evaluate(prev);
          if (outcome.ok) {
            setResult(formatResult(outcome.value));
            setError(null);
          } else {
            setResult(null);
            setError(outcome.error.message);
          }
          return prev;
        });
        return;
      }

      case 'digit':
      case 'operator':
      case 'paren':
      case 'decimal': {
        const token = action.kind === 'decimal' ? '.' : action.value;
        setExpression((prev) => {
          if (prev.length >= MAX_EXPRESSION_LENGTH) return prev;
          return prev + token;
        });
        setResult(null);
        return;
      }

      default: {
        // Exhaustiveness guard — unreachable for well-typed actions.
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }, []);

  /** Maps a raw keyboard event to a button action, if one applies. */
  const actionForKey = useCallback((key: string): ButtonAction | null => {
    if (/^[0-9]$/.test(key)) return { kind: 'digit', value: key };
    if (key === '.' || key === ',') return { kind: 'decimal' };
    if (key === '+' || key === '-' || key === '*' || key === '/' || key === '%') {
      return { kind: 'operator', value: key };
    }
    if (key === '(' || key === ')') return { kind: 'paren', value: key };
    if (key === 'Enter' || key === '=') return { kind: 'equals' };
    if (key === 'Backspace') return { kind: 'delete' };
    if (key === 'Escape' || key === 'Delete') return { kind: 'clear' };
    return null;
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const action = actionForKey(event.key);
      if (action === null) return;
      event.preventDefault();
      dispatch(action);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [actionForKey, dispatch]);

  const displayValue = useMemo<string>(() => {
    if (error !== null) return 'Error';
    if (result !== null) return result;
    return expression === '' ? '0' : expression;
  }, [error, result, expression]);

  return (
    <div
      className={`mx-auto w-full max-w-sm rounded-2xl bg-slate-900 p-4 shadow-2xl ${className ?? ''}`}
    >
      {/* Display area */}
      <div className="mb-4 rounded-xl bg-slate-800 px-4 py-6 text-right">
        <div className="h-5 truncate text-sm text-slate-400" aria-hidden="true">
          {expression === '' ? '\u00A0' : expression}
        </div>
        <div
          className={`mt-1 truncate text-4xl font-semibold tabular-nums ${
            error !== null ? 'text-red-400' : 'text-white'
          }`}
          aria-live="polite"
          aria-atomic="true"
        >
          {displayValue}
        </div>
        {error !== null && (
          <div className="mt-1 truncate text-xs text-red-400" role="alert">
            {error}
          </div>
        )}
      </div>

      {/* Keypad */}
      <div className="grid grid-cols-4 gap-2">
        {BUTTONS.map((button) => (
          <button
            key={button.label}
            type="button"
            onClick={() => dispatch(button.action)}
            aria-label={button.ariaLabel ?? button.label}
            className={`h-14 rounded-xl text-lg font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 ${
              VARIANT_CLASSES[button.variant]
            } ${button.className ?? ''}`}
          >
            {button.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default Calculator;
