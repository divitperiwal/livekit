import Link from "next/link";
import { notFound } from "next/navigation";

import {
  api,
  ApiError,
  type AgentSummary,
  type Campaign,
  type CampaignContact,
  type ContactStatus,
  type Me,
  type PhoneNumber,
} from "@/lib/api";
import { when } from "@/lib/format";
import { commonTimezones } from "@/lib/schema";

import { cellClass, Empty, rowClass, Table } from "../../form";
import { CampaignForm } from "../campaign-form";
import { CampaignStatus, CONTACT_STATES, progress } from "../status";
import { CampaignControls } from "./controls";
import { UploadContacts } from "./upload";

export const metadata = { title: "Campaign" };

interface CampaignDetail {
  campaign: Campaign;
  counts: Partial<Record<ContactStatus, number>>;
  contacts: CampaignContact[];
}

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { id } = await params;
  const { status } = await searchParams;
  const filter = CONTACT_STATES.includes(status as ContactStatus) ? status : undefined;

  let detail: CampaignDetail;
  let agents: AgentSummary[];
  let numbers: PhoneNumber[];
  let me: Me;
  try {
    [detail, { agents }, { numbers }, me] = await Promise.all([
      api<CampaignDetail>(`/campaigns/${id}${filter ? `?status=${filter}` : ""}`),
      api<{ agents: AgentSummary[] }>("/agents"),
      api<{ numbers: PhoneNumber[] }>("/numbers"),
      api<Me>("/me"),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const { campaign, counts, contacts } = detail;
  const readOnly = me.role === "viewer";
  const finished = campaign.status === "completed" || campaign.status === "cancelled";

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link href="/campaigns" className="text-sm text-neutral-500 underline-offset-4 hover:underline">
          ← Campaigns
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{campaign.name}</h1>
          <CampaignStatus status={campaign.status} />
          <span className="text-sm text-neutral-500">{progress(counts)}</span>
        </div>
        {campaign.statusReason ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">Paused: {campaign.statusReason}. Fix it, then resume.</p>
        ) : null}
        <CampaignControls id={campaign.id} status={campaign.status} readOnly={readOnly} />
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap gap-2 text-sm">
          <Link
            href={`/campaigns/${campaign.id}`}
            className={`rounded px-2 py-1 ${filter ? "text-neutral-500" : "bg-neutral-100 dark:bg-neutral-800"}`}
          >
            All
          </Link>
          {CONTACT_STATES.map((state) => (
            <Link
              key={state}
              href={`/campaigns/${campaign.id}?status=${state}`}
              className={`rounded px-2 py-1 ${filter === state ? "bg-neutral-100 dark:bg-neutral-800" : "text-neutral-500"}`}
            >
              {state} <span className="tabular-nums">{counts[state] ?? 0}</span>
            </Link>
          ))}
        </div>

        {contacts.length === 0 ? (
          <Empty>{filter ? `No ${filter} contacts.` : "No contacts yet. Add some below."}</Empty>
        ) : (
          <Table head={["Number", "Status", "Attempts", "Last outcome", "Next try", "Details"]}>
            {contacts.map((contact) => (
              <tr key={contact.id} className={rowClass}>
                <td className={`${cellClass} font-mono text-xs`}>{contact.e164}</td>
                <td className={cellClass}>{contact.status}</td>
                <td className={`${cellClass} tabular-nums`}>{contact.attempts}</td>
                <td className={cellClass}>
                  {contact.lastCallId ? (
                    <Link href={`/calls/${contact.lastCallId}`} className="underline-offset-4 hover:underline">
                      {contact.lastOutcome?.replace(/_/g, " ") ?? "call"}
                    </Link>
                  ) : (
                    (contact.lastOutcome?.replace(/_/g, " ") ?? "—")
                  )}
                </td>
                <td className={`${cellClass} whitespace-nowrap text-neutral-500`}>
                  {contact.status === "pending" && contact.nextAttemptAt ? when(contact.nextAttemptAt) : "—"}
                </td>
                <td className={`${cellClass} text-xs text-neutral-500`}>
                  {Object.entries(contact.variables)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(" · ") || "—"}
                </td>
              </tr>
            ))}
          </Table>
        )}
        {contacts.length >= 100 ? <p className="text-xs text-neutral-500">Showing the 100 most recently updated.</p> : null}
      </section>

      {readOnly || finished ? null : (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Add contacts</h2>
          <UploadContacts id={campaign.id} />
        </section>
      )}

      {finished ? null : (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Settings</h2>
          <CampaignForm
            campaign={campaign}
            agents={agents.map((a) => ({ id: a.id, name: a.name }))}
            numbers={numbers.filter((n) => n.direction !== "inbound").map((n) => ({ id: n.id, e164: n.e164 }))}
            timezones={commonTimezones()}
            readOnly={readOnly}
          />
        </section>
      )}
    </div>
  );
}
