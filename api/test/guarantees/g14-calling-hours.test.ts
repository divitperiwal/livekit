import { describe, expect, test } from "bun:test";
import { withinIndianCallingHours } from "../../src/modules/calls/place-call";
import { createV1Scenario } from "../http/v1-scenario";

const ist = (time: string) => new Date(`2026-10-05T${time}:00+05:30`);

describe("guarantee 14: a +91 number is never dialled outside 09:00–21:00 IST", () => {
  test.each([
    ["08:59", false],
    ["09:00", true],
    ["20:59", true],
    ["21:00", false],
    ["02:30", false],
  ])("at %s IST an Indian number may be dialled: %p", (time, allowed) => {
    expect(withinIndianCallingHours("+919876543210", ist(time))).toBe(allowed);
  });

  test("other countries are not held to Indian hours", () => {
    expect(withinIndianCallingHours("+14155550100", ist("23:00"))).toBe(true);
  });

  test("the API refuses a night-time call to India and dispatches nothing", async () => {
    const { api, dispatches, withOrgAndAgent } = await createV1Scenario({
      now: () => ist("21:30"),
    });
    const { agentId } = await withOrgAndAgent();
    const refused = await api("POST", "/orgs/clinic-42/calls", { agentId, to: "+919876543210" });
    expect(refused).toMatchObject({
      status: 422,
      body: { error: "Indian numbers can only be called 09:00–21:00 IST" },
    });
    expect(dispatches).toHaveLength(0);
  });
});
