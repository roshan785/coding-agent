'use client';

import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

export type InputSize = 'sm' | 'md' | 'lg';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Visible label text. Rendered as a <label> linked to the input. */
  label?: string;
  /** Error message. When present, the input is marked invalid. */
  error?: string;
  /** Helper text shown below the input when there is no error. */
  hint?: ReactNode;
  /** Marks the field as required (adds a visual asterisk). */
  required?: boolean;
  inputSize?: InputSize;
}

const SIZE_CLASSES: Record<InputSize, string> = {
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-3 py-2 text-sm',
  lg: 'px-4 py-2.5 text-base',
};

function cx(...classes: Array<string | undefined | false>): string {
  return classes.filter(Boolean).join(' ');
}

const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    error,
    hint,
    required = false,
    inputSize = 'md',
    disabled = false,
    id,
    className = '',
    'aria-describedby': ariaDescribedBy,
    ...rest
  },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? `input-${generatedId}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  const hasError = Boolean(error);

  const describedBy = [
    ariaDescribedBy,
    hasError ? errorId : hint ? hintId : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  const inputClasses = cx(
    'w-full rounded-md border bg-white text-foreground transition-colors',
    'placeholder:text-zinc-400 dark:placeholder:text-zinc-500',
    'focus-visible:outline-2 focus-visible:outline-offset-2',
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-zinc-100 dark:disabled:bg-zinc-800',
    hasError
      ? 'border-red-500 focus-visible:outline-red-500 dark:border-red-500'
      : 'border-zinc-300 focus-visible:outline-zinc-400 dark:border-zinc-700 dark:bg-zinc-900',
    SIZE_CLASSES[inputSize],
    className,
  );

  return (
    <div className="flex w-full flex-col gap-1.5">
      {label ? (
        <label
          htmlFor={inputId}
          className="text-sm font-medium text-foreground"
        >
          {label}
          {required ? (
            <span className="ml-0.5 text-red-500" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
      ) : null}

      <input
        ref={ref}
        id={inputId}
        disabled={disabled}
        required={required}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy || undefined}
        className={inputClasses}
        {...rest}
      />

      {hasError ? (
        <p id={errorId} role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

export default Input;
