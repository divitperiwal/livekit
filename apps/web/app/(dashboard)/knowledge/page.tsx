import Link from "next/link";

import { api, type KnowledgeBase, type Me } from "@/lib/api";
import { when } from "@/lib/format";

import { cellClass, Empty, rowClass, Table } from "../form";
import { CreateKnowledgeBase } from "./forms";

export const metadata = { title: "Knowledge" };

export default async function KnowledgePage() {
  const [{ knowledgeBases }, me] = await Promise.all([
    api<{ knowledgeBases: KnowledgeBase[] }>("/knowledge-bases"),
    api<Me>("/me"),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Knowledge</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Reference material the agent searches when a caller asks something its prompt does not answer — prices,
          hours, policies. Attach a knowledge base to an agent on its page.
        </p>
      </div>

      {knowledgeBases.length === 0 ? (
        <Empty>No knowledge bases yet.</Empty>
      ) : (
        <Table head={["Name", "Documents", "Updated"]}>
          {knowledgeBases.map((kb) => (
            <tr key={kb.id} className={rowClass}>
              <td className={cellClass}>
                <Link href={`/knowledge/${kb.id}`} className="underline-offset-4 hover:underline">
                  {kb.name}
                </Link>
                {kb.description ? <p className="text-xs text-neutral-500">{kb.description}</p> : null}
              </td>
              <td className={`${cellClass} tabular-nums`}>{kb.documents ?? 0}</td>
              <td className={`${cellClass} whitespace-nowrap text-neutral-500`}>{when(kb.updatedAt)}</td>
            </tr>
          ))}
        </Table>
      )}

      {me.role === "viewer" ? null : (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">New knowledge base</h2>
          <CreateKnowledgeBase />
        </section>
      )}
    </div>
  );
}
