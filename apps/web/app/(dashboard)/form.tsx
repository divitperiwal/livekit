/**
 * The pieces every dashboard form is built from, so they look and behave the
 * same: a labelled field with its error beneath it, and the notices a form
 * shows after it is submitted.
 */

export const inputClass =
  "mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-400";

export const buttonClass =
  "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900";

export const secondaryButtonClass =
  "rounded-md border border-neutral-300 px-3 py-1.5 text-sm disabled:opacity-60 dark:border-neutral-700";

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {hint ? <span className="ml-2 text-xs text-neutral-500">{hint}</span> : null}
      {children}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : null}
    </label>
  );
}

export function ErrorNotice({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
      {message}
    </p>
  );
}

export function SuccessNotice({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">
      {children}
    </p>
  );
}

/** A table with the dashboard's standard frame and header row. */
export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
      <table className="w-full text-sm">
        <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-4 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const rowClass = "border-b border-neutral-100 last:border-0 dark:border-neutral-800";
export const cellClass = "px-4 py-2";

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-neutral-300 px-4 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700">
      {children}
    </p>
  );
}
