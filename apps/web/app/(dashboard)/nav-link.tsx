"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * A nav item that knows whether it is the current section.
 *
 * A client component only because it needs the current path; the layout around
 * it stays on the server so no session data reaches the bundle.
 */
export function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium dark:bg-neutral-800"
          : "rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-900"
      }
    >
      {children}
    </Link>
  );
}
