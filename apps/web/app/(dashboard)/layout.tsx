import Link from "next/link";
import { redirect } from "next/navigation";

import { logout } from "@/app/login/actions";
import { api, ApiError, type Me } from "@/lib/api";

import { NavLink } from "./nav-link";

const SECTIONS = [
  { href: "/calls", label: "Calls" },
  { href: "/agents", label: "Agents" },
  { href: "/numbers", label: "Numbers" },
  { href: "/usage", label: "Usage" },
];

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let me: Me;
  try {
    me = await api<Me>("/me");
  } catch (error) {
    // A cookie that is present but no longer valid -- expired, or signed out
    // elsewhere. The proxy only checks that one exists, so this is where that
    // is noticed.
    if (error instanceof ApiError && error.status === 401) {
      redirect("/login");
    }
    throw error;
  }

  const org = me.organisations.find((o) => o.id === me.orgId);

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
          <Link href="/calls" className="font-semibold tracking-tight">
            automitra
          </Link>

          <nav className="flex items-center gap-1">
            {SECTIONS.map((section) => (
              <NavLink key={section.href} href={section.href}>
                {section.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-neutral-500">
              {org?.name ?? "—"}
              <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                {me.role}
              </span>
            </span>
            <form action={logout}>
              <button
                type="submit"
                className="text-neutral-500 underline-offset-4 hover:underline"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
