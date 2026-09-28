import Link from "next/link";

import { api, type Me, type Tool } from "@/lib/api";

import { cellClass, Empty, rowClass, Table } from "../form";
import { EnableToggle } from "./enable-toggle";
import { ToolForm } from "./tool-form";

export const metadata = { title: "Tools" };

export default async function ToolsPage() {
  const [{ tools }, me] = await Promise.all([api<{ tools: Tool[] }>("/tools"), api<Me>("/me")]);
  const readOnly = me.role === "viewer";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Tools</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Your systems the agent can call mid-conversation — look up an order, book a slot, create a lead.
          Attach them to an agent on its page.
        </p>
      </div>

      {tools.length === 0 ? (
        <Empty>No tools yet. Add one below.</Empty>
      ) : (
        <Table head={["Name", "Endpoint", "Auth", "Enabled"]}>
          {tools.map((tool) => (
            <tr key={tool.id} className={rowClass}>
              <td className={cellClass}>
                <Link href={`/tools/${tool.id}`} className="font-mono underline-offset-4 hover:underline">
                  {tool.name}
                </Link>
                <p className="mt-0.5 line-clamp-1 text-xs text-neutral-500">{tool.description}</p>
              </td>
              <td className={`${cellClass} font-mono text-xs text-neutral-600 dark:text-neutral-400`}>
                {tool.method} {tool.url}
              </td>
              <td className={`${cellClass} text-neutral-600 dark:text-neutral-400`}>
                {tool.authType === "none" ? "—" : tool.authType}
                {tool.authType !== "none" && !tool.hasSecret ? (
                  <span className="ml-1 text-xs text-red-600">no secret</span>
                ) : null}
              </td>
              <td className={cellClass}>
                <EnableToggle id={tool.id} enabled={tool.enabled} readOnly={readOnly} />
              </td>
            </tr>
          ))}
        </Table>
      )}

      {readOnly ? null : (
        <section className="space-y-4">
          <h2 className="text-sm font-medium">Add a tool</h2>
          <ToolForm readOnly={readOnly} />
        </section>
      )}
    </div>
  );
}
