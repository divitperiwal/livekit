import { describe, expect, test } from "bun:test";
import { redactJson, redactText } from "../../src/modules/privacy/redact";

describe("redaction", () => {
  test.each([
    ["mera number 98765 43210 hai", "mera number [number] hai"],
    ["call me on +919876543210", "call me on [number]"],
    ["Aadhaar 1234-5678-9012", "Aadhaar [number]"],
    ["card 4111 1111 1111 1111 expires", "card [number] expires"],
    ["pin code 560001", "pin code [number]"],
    ["नंबर ९८७६५४३२१० है", "नंबर [number] है"],
    ["mail me at ravi.k@example.co.in please", "mail me at [email] please"],
    ["PAN is ABCDE1234F", "PAN is [pan]"],
  ])("masks %p", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  test("keeps short numbers a conversation needs (times, amounts, counts)", () => {
    expect(redactText("2 log, 5 baje, ₹1500 total")).toBe("2 log, 5 baje, ₹1500 total");
  });

  test("masks every string inside a JSON value and keeps its shape", () => {
    expect(redactJson({ phone: "9876543210", nested: [{ note: "ok" }, 42, null] })).toEqual({
      phone: "[number]",
      nested: [{ note: "ok" }, 42, null],
    });
  });
});
