# VanDhan

The MARCOFED वन धन helpline agent. Callers are tribal gatherers of forest
produce. The agent does two things: tells the MSP of a produce, and registers
produce a gatherer will bring to their वन धन केंद्र. Hindi or English.

The agent lives in the control plane's database like any other. These files
are its source, so a change is reviewed here and then published.

| File | What it is |
| --- | --- |
| `prompt.txt` | The instructions. Published with the shared voice rules in front of it. |
| `msp-rates.txt` | MSP for all 87 items on the Ministry of Tribal Affairs list (PMJVM, source [msplist.pdf](https://tribal.nic.in/downloads/Livelihood/Guidelines/msplist.pdf)), one paragraph per item with its Hindi and local names so a search in either language finds it. |
| `sample-prices.txt` | **Made-up demo prices** (clove, pepper, cardamom and so on). A separate document so it can be removed in one step. Not government figures. |
| `publish.ts` | Publishes all of the above as a new version, and records name, Unique ID, produce and weight after each call. |
| `test-scenarios.ts` | Saves the test scenarios to the agent's Tests tab. |
| `api.ts` | Signs in to the dashboard API and finds the agent by its slug, `vandhan`. |

## Publishing

The API must be running (`apps/api`, `bun run dev`) and an agent with the slug
`vandhan` must exist; create it once in the dashboard.

```bash
bun run agents/vandhan/publish.ts          # new version, live immediately
bun run agents/vandhan/test-scenarios.ts   # save scenarios only
```

Neither makes a model, speech or voice request. `test-scenarios.ts --run` also
starts a test run, which does, and is billed: run it deliberately.

`API_URL`, `SEED_EMAIL` and `SEED_PASSWORD` override the defaults (the local
API and the seeded owner).

## The call

1. The opening line greets the caller and asks how it can help.
2. **Rates** need nothing from the caller. The agent always searches the
   knowledge base and never answers from memory; a produce it cannot find gets
   "I don't have the correct data for that", never a number.
3. After a rate it offers to register produce, or another rate.
4. **Registering** needs the caller's name and Unique ID Number first, read
   back digit by digit. No ID, no registration: the केंद्र issues them.
5. One produce at a time: produce, rough weight, confirmation, then "another?"

## Things that are deliberate

- **वन धन is always written in Devanagari**, even in English sentences.
  Written in English letters the voice says "van" like the vehicle.
- **Numbers**: digits in Hindi replies, English words in English replies. The
  voice runs in Hindi, so it reads any digit in Hindi.
- **Language** starts in Hindi and switches only on a full sentence in the
  other language, never on "hello", "ok" or "हाँ".
- **उपज, never माल**, and no exclamation marks, which make the voice sharper.
- **Guardrails**: facts only from the knowledge base and the prompt; anything
  off-topic gets one polite line and an offer of the two things it can do.
- **Per-minute cost ceiling of Rs 2.50.** The prompt is kept compact because
  every turn sends all of it to the model; a longer one has run the ceiling
  out and left the agent silent.
