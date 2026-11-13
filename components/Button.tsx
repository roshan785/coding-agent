'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Button text. Kept for backward compatibility. */
  label?: string;
  /** Click handler. Kept for backward compatibility. */
  onClick?: () => void;
  /** Optional children — takes precedence over `label` when provided. */
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-foreground text-background hover:opacity-80 focus-visible:outline-foreground',
  secondary:
    'bg-zinc-200 text-zinc-900 hover:bg-zinc-300 focus-visible:outline-zinc-400 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700',
  outline:
    'border border-zinc-300 bg-transparent text-foreground hover:bg-zinc-100 focus-visible:outline-zinc-400 dark:border-zinc-700 dark:hover:bg-zinc-800',
  ghost:
    'bg-transparent text-foreground hover:bg-zinc-100 focus-visible:outline-zinc-400 dark:hover:bg-zinc-800',
  danger:
    'bg-red-600 text-white hover:bg-red-700 focus-visible:outline-red-500',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-base',
};

export default function Button({
  label,
  onClick,
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  disabled = false,
  className = '',
  ...rest
}: ButtonProps) {
  const classes = [
    'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-opacity',
    'focus-visible:outline-2 focus-visible:outline-offset-2',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={classes}
      {...rest}
    >
      {children ?? label}
    </button>
  );
}
