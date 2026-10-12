CREATE TYPE "public"."ucc_complaint_status" AS ENUM('pending', 'in_review', 'accepted', 'rejected');--> statement-breakpoint
ALTER TYPE "public"."suppression_source" ADD VALUE 'complaint';--> statement-breakpoint
ALTER TYPE "public"."webhook_event" ADD VALUE 'ucc_complaint.updated';--> statement-breakpoint
CREATE TABLE "ucc_complaints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_id" text NOT NULL,
	"org_id" uuid,
	"from_number" text NOT NULL,
	"complainant_number" text NOT NULL,
	"called_on" date NOT NULL,
	"category" text,
	"plivo_call_uuid" text,
	"status" "ucc_complaint_status" NOT NULL,
	"rejection_reason" text,
	"proof_submitted_at" timestamp with time zone,
	"reported_at" timestamp with time zone NOT NULL,
	"plivo_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ucc_complaints_reference_id_unique" UNIQUE("reference_id")
);
--> statement-breakpoint
ALTER TABLE "ucc_complaints" ADD CONSTRAINT "ucc_complaints_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ucc_complaints_org_idx" ON "ucc_complaints" USING btree ("org_id","reported_at");