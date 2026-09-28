ALTER TYPE "public"."call_event_type" ADD VALUE 'amd';--> statement-breakpoint
ALTER TYPE "public"."call_status" ADD VALUE 'voicemail';--> statement-breakpoint
CREATE TABLE "suppressed_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"call_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "auth_header" text;--> statement-breakpoint
ALTER TABLE "tools" ADD COLUMN "auth_secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN "last_outcome" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "from_number_id" uuid;--> statement-breakpoint
ALTER TABLE "suppressed_numbers" ADD CONSTRAINT "suppressed_numbers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressed_numbers" ADD CONSTRAINT "suppressed_numbers_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressed_numbers" ADD CONSTRAINT "suppressed_numbers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "suppressed_numbers_org_e164_key" ON "suppressed_numbers" USING btree ("org_id","e164");--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_from_number_id_phone_numbers_id_fk" FOREIGN KEY ("from_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_contacts_campaign_e164_key" ON "campaign_contacts" USING btree ("campaign_id","e164");