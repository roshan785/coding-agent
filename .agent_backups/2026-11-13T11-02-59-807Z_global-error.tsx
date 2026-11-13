'use client';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  return (
    <html lang="en">
      <body className="min-h-full flex flex-col items-center justify-center bg-neutral-950 text-neutral-100 p-6">
        <div className="w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-lg">
          <h1 className="text-lg font-semibold text-red-400">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            An unexpected error occurred while rendering the application.
          </p>
          {error.digest ? (
            <p className="mt-3 font-mono text-xs text-neutral-500">
              digest: {error.digest}
            </p>
          ) : null}
          <form action={reset}>
            <button
              type="submit"
              className="mt-5 w-full rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white"
            >
              Try again
            </button>
          </form>
        </div>
      </body>
    </html>
  );
}
