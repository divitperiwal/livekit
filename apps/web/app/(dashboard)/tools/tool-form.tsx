"use client";

import { useActionState, useState } from "react";

import type { Tool } from "@/lib/api";

import { buttonClass, ErrorNotice, Field, inputClass } from "../form";
import { saveTool, type ToolFormState } from "./actions";

const EXAMPLE_SCHEMA = `{
  "type": "object",
  "properties": {
    "order_id": { "type": "string", "description": "The order number the caller gives" }
  },
  "required": ["order_id"]
}`;

/** Creating a tool, or editing one when `tool` is given. */
export function ToolForm({ tool, readOnly }: { tool?: Tool; readOnly: boolean }) {
  const [state, action, pending] = useActionState<ToolFormState, FormData>(saveTool, {});
  const [authType, setAuthType] = useState<string>(tool?.authType ?? "none");
  const fields = state.fields ?? {};

  return (
    <form action={action} className="space-y-4">
      {tool ? <input type="hidden" name="id" value={tool.id} /> : null}
      <ErrorNotice message={state.error} />

      <fieldset disabled={readOnly || pending} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="what the model calls it: letters, digits, _" error={fields.name}>
            <input name="name" defaultValue={tool?.name} className={`${inputClass} font-mono`} placeholder="lookup_order" />
          </Field>
          <Field label="Timeout" hint="milliseconds; the caller hears silence meanwhile" error={fields.timeoutMs}>
            <input name="timeoutMs" type="number" min={500} max={30000} step={100} defaultValue={tool?.timeoutMs ?? 5000} className={inputClass} />
          </Field>
        </div>

        <Field
          label="When to use it"
          hint="the model's only guide to when to call this"
          error={fields.description}
        >
          <textarea
            name="description"
            rows={2}
            defaultValue={tool?.description}
            className={inputClass}
            placeholder="Look up the delivery status of an order once the caller has given their order number."
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
          <Field label="Method" error={fields.method}>
            <select name="method" defaultValue={tool?.method ?? "POST"} className={inputClass}>
              {["POST", "GET", "PUT", "PATCH"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="URL" hint="https only; arguments go in the body, or the query for GET" error={fields.url}>
            <input name="url" defaultValue={tool?.url} className={`${inputClass} font-mono text-xs`} placeholder="https://crm.example.com/orders/lookup" />
          </Field>
        </div>

        <Field label="Arguments" hint="JSON Schema for what the model sends" error={fields.parametersSchema}>
          <textarea
            name="parametersSchema"
            rows={8}
            defaultValue={tool ? JSON.stringify(tool.parametersSchema, null, 2) : EXAMPLE_SCHEMA}
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Authentication" error={fields.authType}>
            <select name="authType" value={authType} onChange={(e) => setAuthType(e.target.value)} className={inputClass}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">API key in a header</option>
              <option value="hmac">HMAC signature</option>
            </select>
          </Field>
          {authType === "header" ? (
            <Field label="Header" error={fields.authHeader}>
              <input name="authHeader" defaultValue={tool?.authHeader ?? "X-API-Key"} className={`${inputClass} font-mono`} />
            </Field>
          ) : null}
          {authType !== "none" ? (
            <Field
              label="Secret"
              hint={tool?.hasSecret ? "leave empty to keep the saved one" : "stored encrypted"}
              error={fields.authSecret}
            >
              <input name="authSecret" type="password" autoComplete="off" className={inputClass} />
            </Field>
          ) : null}
        </div>
        {authType === "hmac" ? (
          <p className="text-xs text-neutral-500">
            Each request carries <code>X-Automitra-Timestamp</code> and <code>X-Automitra-Signature: sha256=…</code>, an
            HMAC-SHA256 of <code>timestamp + &quot;.&quot; + body</code> with this secret. Reject stale timestamps to stop replays.
          </p>
        ) : null}

        <Field label="Other headers" hint="JSON; not for credentials" error={fields.headers}>
          <input
            name="headers"
            defaultValue={tool && Object.keys(tool.headers).length ? JSON.stringify(tool.headers) : ""}
            className={`${inputClass} font-mono text-xs`}
            placeholder='{"X-Tenant": "kbs"}'
          />
        </Field>

        <Field
          label="What the agent sees"
          hint="optional; {{field.path}} from the JSON response. Empty passes the whole response"
          error={fields.responseTemplate}
        >
          <textarea
            name="responseTemplate"
            rows={2}
            defaultValue={tool?.responseTemplate ?? ""}
            className={`${inputClass} font-mono text-xs`}
            placeholder="Order {{order.id}} is {{order.status}}, expected {{order.eta|soon}}."
          />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isSlow" defaultChecked={tool?.isSlow} />
          Slow — the agent tells the caller it is checking before calling it
        </label>
      </fieldset>

      {readOnly ? null : (
        <button type="submit" disabled={pending} className={buttonClass}>
          {pending ? "Saving…" : tool ? "Save changes" : "Add tool"}
        </button>
      )}
    </form>
  );
}
