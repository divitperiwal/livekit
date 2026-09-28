import {
  api,
  type ApiKey,
  type Invite,
  type TeamMember,
  type Me,
  type Settings,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "@/lib/api";
import { when } from "@/lib/format";

import { cellClass, Empty, rowClass, Table } from "../form";
import { CreateKeyForm, CreateWebhookForm, RecordingForm, RevokeKey, WebhookControls } from "./forms";
import { EraseForm, InviteForm, MemberRow, RedactionToggle, RevokeInvite } from "./people";

export const metadata = { title: "Settings" };

const DELIVERY_STYLE: Record<WebhookDelivery["status"], string> = {
  delivered: "text-green-700 dark:text-green-400",
  pending: "text-amber-700 dark:text-amber-400",
  failed: "text-red-600",
};

export default async function SettingsPage() {
  const [settings, me, team] = await Promise.all([
    api<Settings>("/settings"),
    api<Me>("/me"),
    api<{ members: TeamMember[]; invites: Invite[] }>("/team"),
  ]);
  const isAdmin = me.role === "owner" || me.role === "admin";

  // Keys and webhooks are admin-only on the API; asking as anyone else would
  // only produce an error page.
  const [keys, hooks] = isAdmin
    ? await Promise.all([
        api<{ keys: ApiKey[]; scopes: string[] }>("/api-keys"),
        api<{ endpoints: WebhookEndpoint[]; events: string[] }>("/webhooks"),
      ])
    : [null, null];
  const deliveries = hooks
    ? await Promise.all(
        hooks.endpoints.map((e) => api<{ deliveries: WebhookDelivery[] }>(`/webhooks/${e.id}/deliveries`)),
      )
    : [];

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Recording, and how your own systems connect: API keys to place calls and read results, webhooks to be told
          when calls end.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Call recording</h2>
        <RecordingForm settings={settings} readOnly={!isAdmin} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Team</h2>
        <ul className="space-y-2">
          {team.members.map((m) => (
            <MemberRow key={m.userId} member={m} isSelf={m.email === me.email} canEdit={isAdmin} />
          ))}
        </ul>
        {team.invites.length > 0 ? (
          <ul className="space-y-1 text-sm text-neutral-500">
            {team.invites.map((i) => (
              <li key={i.id} className="flex flex-wrap gap-3">
                <span>{i.email}</span>
                <span>{i.role}</span>
                <span>invited, expires {when(i.expiresAt)}</span>
                {isAdmin ? <RevokeInvite invite={i} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {isAdmin ? <InviteForm canInviteOwner={me.role === "owner"} /> : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Privacy</h2>
        <RedactionToggle enabled={settings.redactPii} readOnly={!isAdmin} />
        <p className="text-xs text-neutral-500">
          Applied as calls are recorded, so the unmasked text is never stored. Numbers spoken as words can slip through.
        </p>
        {isAdmin ? (
          <div className="space-y-2 pt-2">
            <p className="text-sm">
              Erase a person&apos;s data: their numbers, transcripts, analysis and recordings, and the details a campaign
              held about them. Billing records are kept, without their number; a do-not-call entry is kept, so they are
              not called again.
            </p>
            <EraseForm />
          </div>
        ) : null}
      </section>

      {!isAdmin ? (
        <p className="text-sm text-neutral-500">API keys and webhooks are managed by an owner or admin.</p>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-medium">API keys</h2>
            <p className="text-sm text-neutral-500">
              For <code>https://…/v1</code>, sent as <code>Authorization: Bearer am_live_…</code>.
            </p>
            {keys!.keys.length === 0 ? (
              <Empty>No keys yet.</Empty>
            ) : (
              <Table head={["Name", "Key", "Scopes", "Last used", ""]}>
                {keys!.keys.map((key) => (
                  <tr key={key.id} className={`${rowClass} ${key.revokedAt ? "opacity-50" : ""}`}>
                    <td className={cellClass}>{key.name}</td>
                    <td className={`${cellClass} font-mono text-xs`}>{key.display}</td>
                    <td className={`${cellClass} text-xs text-neutral-500`}>{key.scopes.join(", ")}</td>
                    <td className={`${cellClass} whitespace-nowrap text-neutral-500`}>
                      {key.revokedAt ? `revoked ${when(key.revokedAt)}` : when(key.lastUsedAt)}
                    </td>
                    <td className={cellClass}>{key.revokedAt ? null : <RevokeKey id={key.id} />}</td>
                  </tr>
                ))}
              </Table>
            )}
            <CreateKeyForm scopes={keys!.scopes} />
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium">Webhooks</h2>
            <p className="text-sm text-neutral-500">
              Each request is signed: <code>X-Automitra-Signature: sha256=…</code> is an HMAC-SHA256 of{" "}
              <code>X-Automitra-Timestamp + &quot;.&quot; + body</code> with the endpoint&apos;s secret. Failed deliveries are
              retried for about a day.
            </p>
            {hooks!.endpoints.length === 0 ? (
              <Empty>No endpoints yet.</Empty>
            ) : (
              <div className="space-y-6">
                {hooks!.endpoints.map((endpoint, index) => (
                  <div key={endpoint.id} className="space-y-2 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-mono text-xs">{endpoint.url}</p>
                        <p className="text-xs text-neutral-500">
                          {endpoint.description ? `${endpoint.description} · ` : ""}
                          {endpoint.events.join(", ")}
                          {endpoint.enabled ? "" : " · disabled"}
                        </p>
                      </div>
                      <WebhookControls id={endpoint.id} enabled={endpoint.enabled} />
                    </div>
                    {deliveries[index]!.deliveries.length === 0 ? (
                      <p className="text-xs text-neutral-500">Nothing sent yet.</p>
                    ) : (
                      <ul className="space-y-1 text-xs">
                        {deliveries[index]!.deliveries.slice(0, 10).map((d) => (
                          <li key={d.id} className="flex flex-wrap gap-2">
                            <span className="text-neutral-500">{when(d.createdAt)}</span>
                            <code>{d.event}</code>
                            <span className={DELIVERY_STYLE[d.status]}>{d.status}</span>
                            {d.lastStatusCode ? <span>HTTP {d.lastStatusCode}</span> : null}
                            {d.status !== "delivered" && d.lastError ? (
                              <span className="text-neutral-500">{d.lastError.slice(0, 120)}</span>
                            ) : null}
                            {d.status === "pending" && d.attempts > 0 ? (
                              <span className="text-neutral-500">next try {when(d.nextAttemptAt)}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
            <CreateWebhookForm events={hooks!.events} />
          </section>
        </>
      )}
    </div>
  );
}
