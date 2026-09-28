import Link from "next/link";
import { notFound } from "next/navigation";

import { api, ApiError, type KnowledgeBase, type KnowledgeDocument, type Me } from "@/lib/api";
import { when } from "@/lib/format";

import { cellClass, Empty, rowClass, Table } from "../../form";
import { AddDocument, DeleteDocument, DeleteKnowledgeBase } from "../forms";

export const metadata = { title: "Knowledge base" };

export default async function KnowledgeBasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let detail: { knowledgeBase: KnowledgeBase; documents: KnowledgeDocument[] };
  let me: Me;
  try {
    [detail, me] = await Promise.all([
      api<{ knowledgeBase: KnowledgeBase; documents: KnowledgeDocument[] }>(`/knowledge-bases/${id}`),
      api<Me>("/me"),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const { knowledgeBase, documents } = detail;
  const readOnly = me.role === "viewer";

  return (
    <div className="space-y-8">
      <div>
        <Link href="/knowledge" className="text-sm text-neutral-500 underline-offset-4 hover:underline">
          ← Knowledge
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">{knowledgeBase.name}</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Changes reach every agent searching this from its next call; no republish is needed.
        </p>
      </div>

      {documents.length === 0 ? (
        <Empty>No documents yet.</Empty>
      ) : (
        <Table head={["Document", "Size", "Added", ""]}>
          {documents.map((doc) => (
            <tr key={doc.id} className={rowClass}>
              <td className={cellClass}>
                {doc.title}
                {doc.sourceUrl ? <p className="font-mono text-xs text-neutral-500">{doc.sourceUrl}</p> : null}
              </td>
              <td className={`${cellClass} whitespace-nowrap tabular-nums text-neutral-500`}>
                {doc.chars.toLocaleString("en-IN")} chars · {doc.chunkCount} passages
              </td>
              <td className={`${cellClass} whitespace-nowrap text-neutral-500`}>{when(doc.createdAt)}</td>
              <td className={cellClass}>
                {readOnly ? null : <DeleteDocument knowledgeBaseId={knowledgeBase.id} documentId={doc.id} />}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {readOnly ? null : (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-medium">Add a document</h2>
            <AddDocument id={knowledgeBase.id} />
          </section>
          <DeleteKnowledgeBase id={knowledgeBase.id} />
        </>
      )}
    </div>
  );
}
