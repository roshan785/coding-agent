import type { Metadata } from 'next';
import Calculator from '@/components/Calculator';
import { CalculatorButton } from '@/components/CalculatorButton';
import { CalculatorDisplay } from '@/components/CalculatorDisplay';

export const metadata: Metadata = {
  title: 'Calculator',
  description: 'A fast, keyboard-friendly calculator built with Next.js and Tailwind CSS.',
};

/**
 * CalculatorPage
 *
 * Server component shell for the calculator route. All interactive logic lives
 * in the client-side {@link Calculator} component, which owns the expression
 * state, keypad handling and keyboard shortcuts.
 *
 * @returns The calculator page element.
 */
export default function CalculatorPage(): React.JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10">
      <section className="w-full max-w-sm" aria-label="Calculator">
        <header className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-white">Calculator</h1>
          <p className="mt-1 text-sm text-slate-400">
            Basic arithmetic · keyboard supported
          </p>
        </header>

        <Calculator />

        <p className="mt-6 text-center text-xs text-slate-500">
          Keys: 0-9 · + − × ÷ % · ( ) · Enter = · Backspace · Esc
        </p>
      </section>
    </main>
  );
}
