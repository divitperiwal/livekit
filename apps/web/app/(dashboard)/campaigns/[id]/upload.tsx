"use client";

import { useActionState, useState } from "react";

import { buttonClass, ErrorNotice, inputClass, SuccessNotice } from "../../form";
import { uploadContacts, type UploadState } from "../actions";

/**
 * Adding contacts: paste a list, or pick a CSV and it is read into the box.
 *
 * The file is read in the browser and sent as text, so what is uploaded is
 * exactly what is shown -- there is no second, invisible copy of the list.
 */
export function UploadContacts({ id }: { id: string }) {
  const [state, action, pending] = useActionState<UploadState, FormData>(uploadContacts, {});
  const [csv, setCsv] = useState("");

  async function pick(file: File | undefined) {
    if (file) setCsv(await file.text());
  }

  const result = state.result;

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <ErrorNotice message={state.error} />
      <SuccessNotice>
        {result
          ? `Added ${result.added}.` +
            (result.duplicates ? ` ${result.duplicates} were already on the campaign.` : "") +
            (result.suppressed ? ` ${result.suppressed} are on the do-not-call list and will not be called.` : "") +
            (result.rejected ? ` ${result.rejected} rows were not phone numbers.` : "")
          : null}
      </SuccessNotice>
      {result && result.rejectedRows.length > 0 ? (
        <ul className="text-xs text-neutral-500">
          {result.rejectedRows.map((row) => (
            <li key={row.row}>
              Row {row.row}: “{row.value}” — {row.reason}
            </li>
          ))}
        </ul>
      ) : null}

      <input type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} className="text-sm" />
      <textarea
        name="csv"
        rows={6}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        className={`${inputClass} font-mono text-xs`}
        placeholder={"phone,name,due_date\n9876543210,Asha,5 October\n+919876543211,Ravi,7 October"}
      />
      <p className="text-xs text-neutral-500">
        The first row names the columns. The phone column is found by its name (phone, mobile, number); every other
        column is available to the agent as <code>{"{{column_name}}"}</code>. Ten-digit numbers are read as Indian.
      </p>
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Adding…" : "Add contacts"}
      </button>
    </form>
  );
}
