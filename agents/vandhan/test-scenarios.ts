// Saves the VanDhan test scenarios to the agent: adds new ones and replaces
// any whose caller or criteria changed. They appear on the agent's Tests tab.
//
//   bun run agents/vandhan/test-scenarios.ts          save only (free)
//   bun run agents/vandhan/test-scenarios.ts --run    also start a test run
//
// A test run is not free: every scenario plays a whole conversation against
// the language model, plus a simulated caller and a judge. Run it deliberately.
import { agentId, call } from "./api";

const AGENT_ID = await agentId();

// Checked in every scenario: the tone and wording rules hold throughout.
const TONE = "The agent never uses an exclamation mark, and its replies are polite and calm.";
const UPAJ = "The agent's own replies never contain the word माल; it says उपज for produce. (The caller may say माल; only the agent's words count.)";

const scenarios = [
  {
    name: "MSP in Hindi: mahua",
    caller:
      "A tribal gatherer named Shanti who speaks only simple Hindi. Opens by asking 'महुआ का रेट क्या है?'. Does not want to register anything, and wants no other rate.",
    criteria: [
      "The agent gives the rate without asking for a name or Unique ID.",
      "The agent gives both rates: mahua flower 30 rupees per kg and mahua seed 29 rupees per kg, or asks which form.",
      "After the rate, the agent asks whether the caller wants to register produce, and on no, offers another rate or ends the call.",
      "The agent replies in Hindi throughout.",
      TONE,
    ],
    maxTurns: 10,
  },
  {
    name: "MSP in English: honey and chironji",
    caller:
      "An English-speaking caller named Arjun, user ID 30912. Gives name and user ID when asked. Then asks the MSP of wild honey, and then of chironji. Does not want to record any produce.",
    criteria: [
      "The agent replies in English after the caller speaks English. (The names वन धन and केंद्र are always written in Devanagari by design and do not count as Hindi.)",
      "The agent states the MSP of wild honey as 225 rupees per kg (in words or digits).",
      "The agent states the MSP of chironji as 126 rupees per kg (in words or digits).",
      "Whenever the agent mentions the scheme's name, it is written in Devanagari as वन धन, never as 'Van Dhan' or 'Vandhan' in English letters.",
      TONE,
    ],
    maxTurns: 10,
  },
  {
    name: "Record produce in Hindi",
    caller:
      "A shy gatherer named Ramesh, Unique ID 77120, who speaks only Hindi and gives very short answers. Opens with 'मुझे माल जमा करना है।' and nothing else. Says 'रमेश' only when asked his name and '77120' only when asked his ID. Says 'महुआ फूल' only when asked which produce, '20 किलो' only when asked the weight. When asked about registering another produce, says 'हाँ, शहद', and '5 किलो' when asked its weight. Then has nothing more.",
    criteria: [
      "The agent asks for the name and then the Unique ID, as separate questions, before registering any produce.",
      "The agent reads the ID back as 7 7 1 2 0 and asks if it is right.",
      "The agent registers mahua flower 20 kg and confirms it on its own, before asking about another produce.",
      "The agent then registers honey 5 kg and confirms it, without asking the name or ID again.",
      UPAJ,
      TONE,
    ],
    maxTurns: 16,
  },
  {
    name: "Produce not on the MSP list",
    caller:
      "A Hindi-speaking gatherer named Sita, user ID 12004. Gives name and ID when asked. Then asks the MSP of tendu leaves (तेंदू पत्ता). If told it is not available, thanks the agent and ends the call.",
    criteria: [
      "The agent does not give any rupee rate for tendu leaves, and does not quote the rate of sal leaves or any other leaf as the tendu rate.",
      "The agent says the केंद्र will give the information or that the rate is not available.",
      TONE,
    ],
    maxTurns: 8,
  },
  {
    name: "Both jobs in English: tamarind",
    caller:
      "An English-speaking gatherer named Sunita, user ID 58003. Gives name and ID when asked. First asks the MSP of tamarind. Has de-seeded tamarind. Then wants to record 50 kg of de-seeded tamarind for drop-off. Has no other produce.",
    criteria: [
      "The agent gives the MSP of de-seeded tamarind as 63 rupees per kg, in words or digits (it may also mention tamarind with seeds at 36).",
      "The agent records 50 kg (fifty kilos) of de-seeded tamarind, confirms it and tells the caller to bring it to the केंद्र.",
      "The agent stays in English throughout, apart from the names वन धन and केंद्र.",
      TONE,
    ],
    maxTurns: 14,
  },
  {
    name: "No user ID, confused caller",
    caller:
      "An elderly Hindi-speaking gatherer named Budhni who is a little confused. Wants to register 10 kg of शहद. Gives her name when asked. When asked for her Unique ID, says 'मुझे नहीं पता, कौन सा ID?'. Then asks what the rate of शहद is.",
    criteria: [
      "The agent does not register the honey without a Unique ID, and says kindly that the केंद्र can give her the ID.",
      "The agent still gives the rate of honey as 225 rupees per kg when asked.",
      "The agent stays patient and reassuring, and does not ask for Aadhaar, bank or any other number.",
      TONE,
    ],
    maxTurns: 10,
  },
  {
    name: "Off-topic questions and unknown produce",
    caller:
      "A Hindi-speaking caller named Kiran, user ID 66310, who gives name and ID when asked. Then asks 'आज मौसम कैसा रहेगा?', then 'हमारे प्रधानमंत्री कौन हैं?', then the rate of coffee (कॉफ़ी), and finally the rate of लौंग (clove). Has nothing to record.",
    criteria: [
      "The agent does not answer the weather or prime-minister questions and politely says it can only help with वन धन produce rates and recording produce.",
      "For coffee the agent says it does not have correct data and gives no number.",
      "The agent states the rate of clove as 850 rupees per kg.",
      TONE,
    ],
    maxTurns: 12,
  },
  {
    name: "English numbers spoken as words",
    caller:
      "An English-speaking caller named Mary, user ID 90417, who gives name and ID when asked. Asks the price of clove, then of small cardamom. Then records 12 kg of clove. Has no other produce.",
    criteria: [
      "When registering, the agent reads the Unique ID back in English words (nine zero four one seven), not digits.",
      "The agent gives clove as eight hundred and fifty rupees and small cardamom as one thousand four hundred and fifty rupees, written in English words, not digits.",
      "The agent confirms twelve kilos of clove in English words, not digits, and tells the caller to bring it to the केंद्र.",
      TONE,
    ],
    maxTurns: 14,
  },
];

const { scenarios: existing } = await call("GET", `/agents/${AGENT_ID}/scenarios`);
for (const s of scenarios) {
  const old = (existing as any[]).find((e) => e.name === s.name);
  if (old && old.caller === s.caller && JSON.stringify(old.criteria) === JSON.stringify(s.criteria)) continue;
  if (old) await call("DELETE", `/scenarios/${old.id}`);
  await call("POST", `/agents/${AGENT_ID}/scenarios`, s);
  console.log(`${old ? "replaced" : "added"} scenario: ${s.name}`);
}

if (process.argv.includes("--run")) {
  const { run } = await call("POST", `/agents/${AGENT_ID}/eval-runs`, {});
  console.log(`test run ${run.id} started`);
}
