import { AcceptForm } from "./accept-form";

export const metadata = { title: "Join" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Join your team on automitra</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Choose a password to create your account. If you already have one with this email address, enter its
          password instead.
        </p>
      </div>
      <AcceptForm token={token} />
    </main>
  );
}
