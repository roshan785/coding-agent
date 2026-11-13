'use client';

/**
 * CalculatorButton
 *
 * A reusable, accessible calculator keypad button.
 *
 * Renders a semantic `<button type="button">` styled exclusively with Tailwind
 * CSS utility classes. Supports four visual variants that map to the classic
 * calculator keypad layout:
 *
 * - `number`   → gray key (digits)
 * - `operator` → orange key (+, −, ×, ÷)
 * - `function` → light-gray key (AC, ±, %)
 * - `equals`   → orange key that spans two grid columns
 *
 * @example
 * ```tsx
 * <CalculatorButton label="7" onClick={() => press('7')} variant="number" />
 * <CalculatorButton label="+" onClick={() => press('+')} variant="operator" />
 * <CalculatorButton label="=" onClick={evaluate} variant="equals" />
 * ```
 */

export type CalculatorButtonVariant = 'number' | 'operator' | 'function' | 'equals';

export interface CalculatorButtonProps {
  /** Visible text content of the button (e.g. "7", "+", "AC", "="). */
  label: string;
  /** Click handler invoked when the button is activated. */
  onClick: () => void;
  /** Visual style of the button. Defaults to `'number'`. */
  variant?: CalculatorButtonVariant;
  /** Additional Tailwind classes appended to the base classes. */
  className?: string;
  /** Accessible name for screen readers. Falls back to `label` when omitted. */
  ariaLabel?: string;
}

const BASE_CLASSES = [
  'inline-flex items-center justify-center select-none',
  'h-16 w-full rounded-full text-2xl font-medium',
  'transition-colors duration-150 ease-in-out',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
  'focus-visible:ring-blue-500 focus-visible:ring-offset-zinc-900',
  'active:scale-[0.97] active:brightness-90',
  'disabled:cursor-not-allowed disabled:opacity-50',
].join(' ');

const VARIANT_CLASSES: Record<CalculatorButtonVariant, string> = {
  number: [
    'bg-zinc-700 text-white',
    'hover:bg-zinc-600',
    'dark:bg-zinc-700 dark:text-white dark:hover:bg-zinc-600',
  ].join(' '),
  operator: [
    'bg-orange-500 text-white',
    'hover:bg-orange-400',
    'dark:bg-orange-500 dark:text-white dark:hover:bg-orange-400',
  ].join(' '),
  function: [
    'bg-zinc-300 text-zinc-900',
    'hover:bg-zinc-200',
    'dark:bg-zinc-400 dark:text-zinc-900 dark:hover:bg-zinc-300',
  ].join(' '),
  equals: [
    'col-span-2 bg-orange-500 text-white',
    'hover:bg-orange-400',
    'dark:bg-orange-500 dark:text-white dark:hover:bg-orange-400',
  ].join(' '),
};

/**
 * Renders a single calculator keypad button.
 *
 * @param props - {@link CalculatorButtonProps}
 * @returns A styled, accessible `<button>` element.
 */
export function CalculatorButton({
  label,
  onClick,
  variant = 'number',
  className = '',
  ariaLabel,
}: CalculatorButtonProps) {
  const classes = [BASE_CLASSES, VARIANT_CLASSES[variant], className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      className={classes}
    >
      {label}
    </button>
  );
}

export default CalculatorButton;
