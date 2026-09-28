import Link from "next/link";
import { notFound } from "next/navigation";

import { api, type Me, type Tool } from "@/lib/api";

import { ToolForm } from "../tool-form";

export const metadata = { title: "Tool" };

export default async function ToolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [{ tools }, me] = await Promise.all([api<{ tools: Tool[] }>("/tools"), api<Me>("/me")]);
  const tool = tools.find((t) => t.id === id);
  if (!tool) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link href="/tools" className="text-sm text-neutral-500 underline-offset-4 hover:underline">
          ← Tools
        </Link>
        <h1 className="mt-2 font-mono text-xl font-semibold tracking-tight">{tool.name}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Changes reach every agent using this tool from its next call. Tools are not versioned the way agents are,
          so fixing a URL or rotating a key needs no republish.
        </p>
      </div>
      <ToolForm tool={tool} readOnly={me.role === "viewer"} />
    </div>
  );
}
