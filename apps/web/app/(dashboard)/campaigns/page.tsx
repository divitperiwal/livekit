import Link from "next/link";

import { api, type AgentSummary, type Campaign, type ContactStatus, type Me, type PhoneNumber } from "@/lib/api";
import { when } from "@/lib/format";
import { commonTimezones } from "@/lib/schema";

import { cellClass, Empty, rowClass, Table } from "../form";
import { CampaignForm } from "./campaign-form";
import { CampaignStatus, progress } from "./status";

export const metadata = { title: "Campaigns" };

type Listed = Campaign & { contacts: Partial<Record<ContactStatus, number>> };

export default async function CampaignsPage() {
  const [{ campaigns }, { agents }, { numbers }, me] = await Promise.all([
    api<{ campaigns: Listed[] }>("/campaigns"),
    api<{ agents: AgentSummary[] }>("/agents"),
    api<{ numbers: PhoneNumber[] }>("/numbers"),
    api<Me>("/me"),
  ]);
  const readOnly = me.role === "viewer";
  const agentName = new Map(agents.map((a) => [a.id, a.name]));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Campaigns</h1>
        <p className="mt-1 text-sm text-neutral-500">
          An agent calling a list of people, within the hours you allow, trying again when nobody picks up.
        </p>
      </div>

      {campaigns.length === 0 ? (
        <Empty>No campaigns yet.</Empty>
      ) : (
        <Table head={["Campaign", "Agent", "Status", "Progress", "Created"]}>
          {campaigns.map((campaign) => (
            <tr key={campaign.id} className={rowClass}>
              <td className={cellClass}>
                <Link href={`/campaigns/${campaign.id}`} className="underline-offset-4 hover:underline">
                  {campaign.name}
                </Link>
              </td>
              <td className={`${cellClass} text-neutral-600 dark:text-neutral-400`}>
                {agentName.get(campaign.agentId) ?? "—"}
              </td>
              <td className={cellClass}>
                <CampaignStatus status={campaign.status} />
                {campaign.statusReason ? (
                  <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">{campaign.statusReason}</span>
                ) : null}
              </td>
              <td className={`${cellClass} tabular-nums`}>{progress(campaign.contacts)}</td>
              <td className={`${cellClass} whitespace-nowrap text-neutral-500`}>{when(campaign.createdAt)}</td>
            </tr>
          ))}
        </Table>
      )}

      {readOnly ? null : agents.length === 0 ? (
        <p className="text-sm text-neutral-500">Create an agent before starting a campaign.</p>
      ) : (
        <section className="space-y-4">
          <h2 className="text-sm font-medium">New campaign</h2>
          <CampaignForm
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
