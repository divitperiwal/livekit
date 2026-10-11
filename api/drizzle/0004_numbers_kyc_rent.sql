CREATE TYPE "public"."number_source" AS ENUM('managed', 'rented');--> statement-breakpoint
CREATE TYPE "public"."number_kyc_status" AS ENUM('none', 'submitted', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "number_rents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"phone_number_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount_inr" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_rents_number_period_key" UNIQUE("phone_number_id","period_start"),
	CONSTRAINT "number_rents_period_order" CHECK ("number_rents"."period_end" > "number_rents"."period_start"),
	CONSTRAINT "number_rents_amount_nonnegative" CHECK ("number_rents"."amount_inr" >= 0)
);
--> statement-breakpoint
ALTER TABLE "phone_numbers" DROP CONSTRAINT "phone_numbers_e164_unique";--> statement-breakpoint
ALTER TABLE "account_ledger" DROP CONSTRAINT "account_ledger_amount_sign";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_usage_never_fails";--> statement-breakpoint
-- Hand-edited: ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it,
-- and every pending migration runs in one transaction. Each changed enum is recreated instead.
ALTER TABLE "account_ledger" DROP CONSTRAINT "account_ledger_usage_links_record";--> statement-breakpoint
ALTER TYPE "public"."ledger_kind" RENAME TO "ledger_kind_old";--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('usage', 'number_rent', 'payment', 'adjustment');--> statement-breakpoint
ALTER TABLE "account_ledger" ALTER COLUMN "kind" TYPE "public"."ledger_kind" USING "kind"::text::"public"."ledger_kind";--> statement-breakpoint
DROP TYPE "public"."ledger_kind_old";--> statement-breakpoint
ALTER TABLE "account_ledger" ADD CONSTRAINT "account_ledger_usage_links_record" CHECK (("account_ledger"."kind" = 'usage') = ("account_ledger"."usage_record_id" is not null));--> statement-breakpoint
ALTER TYPE "public"."number_status" RENAME TO "number_status_old";--> statement-breakpoint
CREATE TYPE "public"."number_status" AS ENUM('renting', 'available', 'assigned', 'releasing', 'released');--> statement-breakpoint
ALTER TABLE "phone_numbers" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "phone_numbers" ALTER COLUMN "status" TYPE "public"."number_status" USING "status"::text::"public"."number_status";--> statement-breakpoint
ALTER TABLE "phone_numbers" ALTER COLUMN "status" SET DEFAULT 'available';--> statement-breakpoint
DROP TYPE "public"."number_status_old";--> statement-breakpoint
ALTER TYPE "public"."webhook_event" RENAME TO "webhook_event_old";--> statement-breakpoint
CREATE TYPE "public"."webhook_event" AS ENUM('call.ended', 'usage.recorded', 'account.credit_low', 'number.rented', 'number.released', 'number.rent_charged', 'number_kyc.updated');--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ALTER COLUMN "events" TYPE "public"."webhook_event"[] USING "events"::text[]::"public"."webhook_event"[];--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "event" TYPE "public"."webhook_event" USING "event"::text::"public"."webhook_event";--> statement-breakpoint
DROP TYPE "public"."webhook_event_old";--> statement-breakpoint
ALTER TABLE "account_ledger" ADD COLUMN "number_rent_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "source" "number_source" DEFAULT 'managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "monthly_rent_inr" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "rented_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "number_kyc_status" "number_kyc_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "number_kyc_application_id" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "number_kyc_rejection_reason" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "number_kyc_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "number_rents" ADD CONSTRAINT "number_rents_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_rents" ADD CONSTRAINT "number_rents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_rents" ADD CONSTRAINT "number_rents_phone_number_id_phone_numbers_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "number_rents_account_created_idx" ON "number_rents" USING btree ("account_id","created_at");--> statement-breakpoint
ALTER TABLE "account_ledger" ADD CONSTRAINT "account_ledger_number_rent_id_number_rents_id_fk" FOREIGN KEY ("number_rent_id") REFERENCES "public"."number_rents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_e164_held_key" ON "phone_numbers" USING btree ("e164") WHERE "phone_numbers"."released_at" is null;--> statement-breakpoint
ALTER TABLE "account_ledger" ADD CONSTRAINT "account_ledger_number_rent_id_unique" UNIQUE("number_rent_id");--> statement-breakpoint
ALTER TABLE "account_ledger" ADD CONSTRAINT "account_ledger_number_rent_links_rent" CHECK (("account_ledger"."kind" = 'number_rent') = ("account_ledger"."number_rent_id" is not null));--> statement-breakpoint
ALTER TABLE "account_ledger" ADD CONSTRAINT "account_ledger_amount_sign" CHECK (case when "account_ledger"."kind" in ('usage', 'number_rent') then "account_ledger"."amount_inr" >= 0 when "account_ledger"."kind" = 'payment' then "account_ledger"."amount_inr" > 0 else "account_ledger"."amount_inr" <> 0 end);--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_available_has_no_org" CHECK ("phone_numbers"."status" <> 'available' or "phone_numbers"."org_id" is null);--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_held_has_org" CHECK ("phone_numbers"."org_id" is not null or "phone_numbers"."status" in ('available', 'released'));--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_released_has_time" CHECK (("phone_numbers"."status" = 'released') = ("phone_numbers"."released_at" is not null));--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_released_has_no_agent" CHECK ("phone_numbers"."status" <> 'released' or "phone_numbers"."agent_id" is null);--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_rented_has_rent" CHECK ("phone_numbers"."source" <> 'rented' or "phone_numbers"."monthly_rent_inr" is not null);--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_rented_has_time" CHECK ("phone_numbers"."source" <> 'rented' or "phone_numbers"."status" = 'renting' or "phone_numbers"."rented_at" is not null);--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_rent_nonnegative" CHECK ("phone_numbers"."monthly_rent_inr" is null or "phone_numbers"."monthly_rent_inr" >= 0);--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_number_kyc_has_application" CHECK (("orgs"."number_kyc_status" = 'none') = ("orgs"."number_kyc_application_id" is null));--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_number_kyc_rejection_has_reason" CHECK (("orgs"."number_kyc_status" = 'rejected') = ("orgs"."number_kyc_rejection_reason" is not null));--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_billing_never_fails" CHECK ("webhook_deliveries"."event" not in ('usage.recorded', 'number.rent_charged') or "webhook_deliveries"."status" <> 'failed');