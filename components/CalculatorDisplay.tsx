'use client';

import type { ReactNode } from 'react';

export interface CalculatorDisplayProps {
  /** The full expression being evaluated, e.g. `"12 + 7 × 3"`. Rendered small and muted above the main value. */
  expression: string;
  /** The current main value shown in the large right-aligned area. */
  display: string;
  /** Optional error message. When present, the display switches to a red error state. */
  error?: string | null;
}

/**
 * Returns a Tailwind font-size class that shrinks as the display string grows,
 * so long numbers stay readable instead of being clipped.
 *
 * @param value - The string currently shown in the main display.
 * @returns A Tailwind text-size class name.
 */
function getDisplaySizeClass(value: string): string {
  const length = value.length;
  if (length <= 9) return 'text-4xl sm:text-5xl';
  if (length <= 13) return 'text-3xl sm:text-4xl';
  if (length <= 18) return 'text-2xl sm:text-3xl';
  if (length <= 24) return 'text-xl sm:text-2xl';
  return 'text-lg sm:text-xl';
}

/**
 * CalculatorDisplay
 *
 * A presentational display panel for a calculator. Shows the running
 * expression in small muted text above a large, right-aligned main value.
 * Long values are handled by scaling the font size down and truncating with
 * an ellipsis as a final fallback. Errors are rendered in red.
 *
 * Accessibility: the main value region uses `aria-live="polite"` so screen
 * readers announce updates without interrupting the user.
 *
 * @example
 * ```tsx
 * <CalculatorDisplay expression="12 + 7" display="19" />
 * <CalculatorDisplay expression="5 ÷ 0" display="0" error="Cannot divide by zero" />
 * ```
 */
export function CalculatorDisplay({
  expression,
  display,
  error = null,
}: CalculatorDisplayProps): ReactNode {
  const hasError = typeof error === 'string' && error.trim().length > 0;
  const mainValue = hasError ? 'Error' : display;

  return (
    <div
      className={[
        'flex w-full flex-col gap-1 rounded-lg border px-4 py-3',
        'bg-zinc-50 dark:bg-zinc-900',
        hasError
          ? 'border-red-300 dark:border-red-800'
          : 'border-zinc-200 dark:border-zinc-800',
      ].join(' ')}
    >
      {/* Expression line — small, muted, right-aligned */}
      <div
        className="min-h-5 truncate text-right text-xs font-medium tracking-wide text-zinc-500 sm:text-sm dark:text-zinc-400"
        title={expression || undefined}
        aria-hidden="true"
      >
        {expression || '\u00A0'}
      </div>

      {/* Main display — large, right-aligned, scales with length */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={hasError ? `Error: ${error}` : `Result: ${display}`}
        className={[
          'w-full overflow-hidden text-right font-mono font-semibold tabular-nums',
          'truncate leading-tight',
          getDisplaySizeClass(mainValue),
          hasError
            ? 'text-red-600 dark:text-red-400'
            : 'text-zinc-900 dark:text-zinc-50',
        ].join(' ')}
        title={hasError ? (error ?? undefined) : display}
      >
        {mainValue}
      </div>

      {/* Error detail — visible text for sighted users, announced politely */}
      {hasError ? (
        <div
          className="truncate text-right text-xs font-medium text-red-600 dark:text-red-400"
          title={error ?? undefined}
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}

export default CalculatorDisplay;
