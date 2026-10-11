import {
  PlivoError,
  type AvailableNumber,
  type KycApplication,
  type KycDocumentType,
  type KycState,
  type Plivo,
  type PlivoKycStatus,
  type PurchaseOutcome,
} from "../../src/modules/numbers/plivo";

/** Plivo's two India business documents, as its Requirements lookup lists them. */
export const FAKE_KYC_DOCUMENT_TYPES: KycDocumentType[] = [
  {
    documentTypeId: "doc-registration-certificate",
    name: "Registration Certificate",
    requiredFields: [{ fieldName: "business_name", required: true }],
  },
  { documentTypeId: "doc-gst-certificate", name: "GST Certificate", requiredFields: [] },
];

type HeldNumber = { complianceApplicationId: string | null; inboundTrunkId: string | null };
type Application = { application: KycApplication; state: KycState };
type PlivoMethod = keyof Plivo;

/**
 * An in-memory Plivo that keeps Plivo's rules: a number is bought once, only under an
 * accepted application; releasing a number not held succeeds; only a rejected
 * application can be resubmitted. `failNext` makes the next call to a method throw.
 */
export class FakePlivo implements Plivo {
  readonly offered = new Map<string, AvailableNumber>();
  readonly held = new Map<string, HeldNumber>();
  readonly applications = new Map<string, Application>();
  readonly calls: PlivoMethod[] = [];
  purchaseOutcome: PurchaseOutcome = "active";
  readonly #failures = new Map<PlivoMethod, PlivoError>();
  #nextApplication = 1;

  offer(...numbers: string[]): this {
    for (const e164 of numbers) {
      this.offered.set(e164, {
        e164,
        numberType: "local",
        city: "Bangalore",
        region: "Karnataka",
        smsEnabled: false,
      });
    }
    return this;
  }

  failNext(method: PlivoMethod, error = new PlivoError(503, "service unavailable")): this {
    this.#failures.set(method, error);
    return this;
  }

  /** What Plivo decides about an application (its callback then tells us). */
  decideKyc(applicationId: string, status: PlivoKycStatus, rejectionReason: string | null = null) {
    this.#application(applicationId).state = { status, rejectionReason };
  }

  async searchNumbers(search: Parameters<Plivo["searchNumbers"]>[0]) {
    this.#enter("searchNumbers");
    const matching = [...this.offered.values()].filter(
      (number) => search.pattern === undefined || number.e164.includes(search.pattern),
    );
    return matching.slice(0, search.limit ?? 20);
  }

  async buyNumber(e164: string, complianceApplicationId: string) {
    this.#enter("buyNumber");
    const { state } = this.#application(complianceApplicationId);
    if (state.status !== "accepted") {
      throw new PlivoError(400, `compliance application status is '${state.status}'`);
    }
    if (!this.offered.has(e164)) throw new PlivoError(404, "number not available");
    this.offered.delete(e164);
    this.held.set(e164, { complianceApplicationId, inboundTrunkId: null });
    return this.purchaseOutcome;
  }

  async connectNumber(e164: string, inboundTrunkId: string) {
    this.#enter("connectNumber");
    const number = this.held.get(e164);
    if (!number) throw new PlivoError(404, "number not found");
    number.inboundTrunkId = inboundTrunkId;
  }

  async holdsNumber(e164: string) {
    this.#enter("holdsNumber");
    return this.held.has(e164);
  }

  async releaseNumber(e164: string) {
    this.#enter("releaseNumber");
    this.held.delete(e164);
  }

  async kycRequirements() {
    this.#enter("kycRequirements");
    return FAKE_KYC_DOCUMENT_TYPES;
  }

  async submitKyc(application: KycApplication) {
    this.#enter("submitKyc");
    const applicationId = `compliance-${this.#nextApplication++}`;
    this.applications.set(applicationId, {
      application,
      state: { status: "submitted", rejectionReason: null },
    });
    return { applicationId };
  }

  async resubmitKyc(applicationId: string, application: KycApplication) {
    this.#enter("resubmitKyc");
    const existing = this.#application(applicationId);
    if (existing.state.status !== "rejected") {
      throw new PlivoError(400, "compliance_not_editable");
    }
    this.applications.set(applicationId, {
      application,
      state: { status: "submitted", rejectionReason: null },
    });
  }

  async kycState(applicationId: string) {
    this.#enter("kycState");
    return { ...this.#application(applicationId).state };
  }

  async linkNumbers(applicationId: string, e164s: string[]) {
    this.#enter("linkNumbers");
    if (this.#application(applicationId).state.status !== "accepted") {
      throw new PlivoError(400, "compliance application must be accepted");
    }
    const notHeld = e164s.filter((e164) => !this.held.has(e164));
    if (notHeld.length > 0) {
      throw new PlivoError(null, `could not link ${notHeld.join(", ")}: not on the account`);
    }
    for (const e164 of e164s) this.held.get(e164)!.complianceApplicationId = applicationId;
  }

  /** A number we bought by hand in Plivo's console, before it is assigned to anyone. */
  holdManaged(e164: string): this {
    this.held.set(e164, { complianceApplicationId: null, inboundTrunkId: "trunk-in" });
    return this;
  }

  #enter(method: PlivoMethod) {
    this.calls.push(method);
    const failure = this.#failures.get(method);
    if (!failure) return;
    this.#failures.delete(method);
    throw failure;
  }

  #application(applicationId: string): Application {
    const found = this.applications.get(applicationId);
    if (!found) throw new PlivoError(404, "compliance application not found");
    return found;
  }
}
