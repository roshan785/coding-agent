import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export interface CardSectionProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  children: ReactNode;
}

export interface CardDescriptionProps extends HTMLAttributes<HTMLParagraphElement> {
  children: ReactNode;
}

function cx(...classes: Array<string | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export default function Card({ children, className, ...rest }: CardProps) {
  return (
    <div
      className={cx(
        'rounded-lg border border-zinc-200 bg-white shadow-sm',
        'dark:border-zinc-800 dark:bg-zinc-900',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ children, className, ...rest }: CardSectionProps) {
  return (
    <div className={cx('flex flex-col gap-1 border-b border-zinc-200 p-4 dark:border-zinc-800', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({ children, className, ...rest }: CardTitleProps) {
  return (
    <h3 className={cx('text-base font-semibold leading-tight', className)} {...rest}>
      {children}
    </h3>
  );
}

export function CardDescription({ children, className, ...rest }: CardDescriptionProps) {
  return (
    <p className={cx('text-sm text-zinc-500 dark:text-zinc-400', className)} {...rest}>
      {children}
    </p>
  );
}

export function CardContent({ children, className, ...rest }: CardSectionProps) {
  return (
    <div className={cx('p-4', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({ children, className, ...rest }: CardSectionProps) {
  return (
    <div
      className={cx('flex items-center gap-2 border-t border-zinc-200 p-4 dark:border-zinc-800', className)}
      {...rest}
    >
      {children}
    </div>
  );
}
