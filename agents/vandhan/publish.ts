// Publishes the VanDhan agent from the files in this folder: the MSP knowledge
// base, the prompt, the opening line and the fields recorded after each call.
// Publishing writes a new version; earlier versions stay in the history.
//
//   bun run agents/vandhan/publish.ts
//
// No model, speech or voice request is made.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { agentId, call } from "./api";

const DIR = import.meta.dir;
const AGENT_ID = await agentId();

// Reuse the knowledge base if this has run before, replacing its documents
// with the current rate lists rather than making a second knowledge base.
const KB_NAME = "वन धन MSP rates";
const { knowledgeBases: list } = await call("GET", "/knowledge-bases");
let kb = (list as any[]).find((k) => k.name === KB_NAME);
if (!kb) {
  kb = (
    await call("POST", "/knowledge-bases", {
      name: KB_NAME,
      description: "Minimum Support Prices for Minor Forest Produce, Ministry of Tribal Affairs (PMJVM list).",
    })
  ).knowledgeBase;
} else {
  const { documents } = await call("GET", `/knowledge-bases/${kb.id}`);
  for (const d of documents) await call("DELETE", `/knowledge-bases/${kb.id}/documents/${d.id}`);
}
const documents = [
  { title: "MSP for Minor Forest Produce, Government of India", file: "msp-rates.txt" },
  // Made-up demo figures, kept in their own document so they can be removed in one step.
  { title: "Sample prices (demo data, not government-notified)", file: "sample-prices.txt" },
];
for (const d of documents) {
  const { document } = await call("POST", `/knowledge-bases/${kb.id}/documents`, {
    title: d.title,
    text: readFileSync(join(DIR, d.file), "utf8"),
  });
  console.log(`${d.title}: ${document.chunkCount} chunks, ${document.chars} chars`);
}

const { live } = await call("GET", `/agents/${AGENT_ID}`);

const config = {
  ...live?.config,
  greetingMode: "verbatim",
  llmTemperature: 0.3,
  // A touch slower than normal reads as calmer.
  ttsPace: 0.95,
  maxInrPerMin: 2.5,
  closingLines: [],
  dispositions: ["msp_enquiry", "produce_recorded", "msp_and_produce", "other_query", "wrong_number", "do_not_call"],
  analysisFields: [
    {
      name: "caller_intent",
      type: "enum",
      options: ["msp_enquiry", "record_produce", "both", "other"],
      description: "What the caller wanted: to know an MSP, to record produce for drop-off at the kendra, both, or something else.",
    },
    {
      name: "produce_items",
      type: "string",
      description:
        "Every produce the gatherer said they will bring to the kendra, as 'item: quantity unit' separated by semicolons, e.g. 'Mahua flower (dried): 20 kg; Wild honey: 5 kg'. Use the final corrected values. Empty if none.",
    },
    {
      name: "total_quantity_kg",
      type: "number",
      description: "Sum of the recorded quantities that were given in kilograms. Leave out quantities in other units.",
    },
    { name: "gatherer_name", type: "string", description: "The caller's name, if they gave it." },
    {
      name: "unique_id",
      type: "string",
      description: "The caller's Unique ID Number exactly as finally confirmed, without spaces. Empty if they did not give one.",
    },
    {
      name: "produce_recorded",
      type: "boolean",
      description: "True if the agent confirmed to the caller that their produce was recorded.",
    },
    {
      name: "msp_items_asked",
      type: "string",
      description: "Produce whose MSP the caller asked about, comma separated. Empty if none.",
    },
  ],
};

const published = await call("POST", `/agents/${AGENT_ID}/versions`, {
  promptMode: "prepend_base_rules",
  instructions: readFileSync(join(DIR, "prompt.txt"), "utf8"),
  greeting: "नमस्ते जी, MARCOFED वन धन से विजय बोल रहा हूँ। बताइए, मैं आपकी क्या सहायता कर सकता हूँ?",
  config,
  knowledgeBaseIds: [kb.id],
});
console.log(`published VanDhan v${published.version} (${published.id})`);
