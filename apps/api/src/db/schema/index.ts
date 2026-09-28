/**
 * The schema.
 *
 * Every tenant-scoped table carries `orgId` and every query must filter on it.
 * That rule is not enforced by types -- it is enforced by review and by tests
 * that assert one organisation cannot read another's rows.
 */

export * from "./identity";
export * from "./agents";
export * from "./telephony";
export * from "./tools";
export * from "./calls";
export * from "./billing";
export * from "./campaigns";
export * from "./webhooks";
export * from "./knowledge";
export * from "./evals";
