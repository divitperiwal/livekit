CREATE TYPE "public"."agent_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."prompt_mode" AS ENUM('prepend_base_rules', 'verbatim');--> statement-breakpoint
CREATE TYPE "public"."ledger_kind" AS ENUM('usage', 'payment', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."call_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."call_event_role" AS ENUM('user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."call_event_type" AS ENUM('user_message', 'agent_message', 'tool_call', 'tool_result', 'stage_change', 'transfer', 'error', 'amd');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('queued', 'ringing', 'in_progress', 'completed', 'failed', 'no_answer', 'busy', 'voicemail');--> statement-breakpoint
CREATE TYPE "public"."number_direction" AS ENUM('inbound', 'outbound', 'both');--> statement-breakpoint
CREATE TYPE "public"."number_provider" AS ENUM('plivo');--> statement-breakpoint
CREATE TYPE "public"."number_status" AS ENUM('available', 'assigned', 'releasing');--> statement-breakpoint
CREATE TYPE "public"."suppression_source" AS ENUM('caller_request', 'api', 'operator');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."org_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."webhook_event" AS ENUM('call.ended', 'usage.recorded', 'account.credit_low');--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"prompt_mode" "prompt_mode" NOT NULL,
	"instructions" text NOT NULL,
	"greeting" text NOT NULL,
	"config" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_agent_version_key" UNIQUE("agent_id","version"),
	CONSTRAINT "agent_versions_id_agent_key" UNIQUE("id","agent_id"),
	CONSTRAINT "agent_versions_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "agent_versions_version_positive" CHECK ("agent_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"draft_version_id" uuid,
	"live_version_id" uuid,
	"candidate_version_id" uuid,
	"candidate_percent" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_org_slug_key" UNIQUE("org_id","slug"),
	CONSTRAINT "agents_id_org_key" UNIQUE("id","org_id"),
	CONSTRAINT "agents_candidate_percent_range" CHECK ("agents"."candidate_percent" between 0 and 100),
	CONSTRAINT "agents_candidate_needs_version" CHECK ("agents"."candidate_percent" = 0 or "agents"."candidate_version_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "account_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "ledger_kind" NOT NULL,
	"amount_inr" numeric(14, 2) NOT NULL,
	"usage_record_id" uuid,
	"idempotency_key" text NOT NULL,
	"reference" text,
	"description" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_ledger_usage_record_id_unique" UNIQUE("usage_record_id"),
	CONSTRAINT "account_ledger_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "account_ledger_usage_links_record" CHECK (("account_ledger"."kind" = 'usage') = ("account_ledger"."usage_record_id" is not null)),
	CONSTRAINT "account_ledger_amount_sign" CHECK (case "account_ledger"."kind" when 'usage' then "account_ledger"."amount_inr" >= 0 when 'payment' then "account_ledger"."amount_inr" > 0 else "account_ledger"."amount_inr" <> 0 end)
);
--> statement-breakpoint
CREATE TABLE "rate_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"name" text NOT NULL,
	"rates" jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_cards_effective_order" CHECK ("rate_cards"."effective_to" is null or "rate_cards"."effective_to" > "rate_cards"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"rate_card_id" uuid,
	"billable_seconds" integer NOT NULL,
	"pstn_seconds" integer NOT NULL,
	"stt_seconds" numeric(12, 3) NOT NULL,
	"tts_characters" integer NOT NULL,
	"llm_prompt_tokens" integer NOT NULL,
	"llm_cached_tokens" integer NOT NULL,
	"llm_completion_tokens" integer NOT NULL,
	"stt_model" text NOT NULL,
	"tts_model" text NOT NULL,
	"llm_model" text NOT NULL,
	"stt_cost_inr" numeric(14, 4) NOT NULL,
	"tts_cost_inr" numeric(14, 4) NOT NULL,
	"llm_cost_inr" numeric(14, 4) NOT NULL,
	"pstn_cost_inr" numeric(14, 4) NOT NULL,
	"total_cost_inr" numeric(14, 4) NOT NULL,
	"price_inr" numeric(14, 2) NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"review_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_call_id_unique" UNIQUE("call_id"),
	CONSTRAINT "usage_records_review_has_reason" CHECK (not "usage_records"."needs_review" or "usage_records"."review_reason" is not null),
	CONSTRAINT "usage_records_price_nonnegative" CHECK ("usage_records"."price_inr" >= 0)
);
--> statement-breakpoint
CREATE TABLE "call_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" "call_event_type" NOT NULL,
	"role" "call_event_role",
	"content" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "call_events_call_seq_key" UNIQUE("call_id","seq"),
	CONSTRAINT "call_events_seq_positive" CHECK ("call_events"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"request_id" uuid,
	"lk_job_id" text,
	"lk_room_name" text,
	"direction" "call_direction" NOT NULL,
	"from_number" text,
	"to_number" text,
	"phone_number_id" uuid,
	"status" "call_status" NOT NULL,
	"end_reason" text,
	"answered" boolean DEFAULT false NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"campaign_id" uuid,
	"contact_id" uuid,
	"started_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"duration_seconds" integer,
	"recording_key" text,
	"recording_deleted_at" timestamp with time zone,
	"summary" text,
	"disposition" text,
	"analysis_fields" jsonb,
	"qa" jsonb,
	"latency" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "calls_lk_job_id_unique" UNIQUE("lk_job_id"),
	CONSTRAINT "calls_duration_nonnegative" CHECK ("calls"."duration_seconds" is null or "calls"."duration_seconds" >= 0),
	CONSTRAINT "calls_opened_has_job" CHECK ("calls"."status" = 'queued' or "calls"."lk_job_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"e164" text NOT NULL,
	"provider" "number_provider" DEFAULT 'plivo' NOT NULL,
	"direction" "number_direction" DEFAULT 'both' NOT NULL,
	"status" "number_status" DEFAULT 'available' NOT NULL,
	"agent_id" uuid,
	"lk_dispatch_rule_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_numbers_e164_unique" UNIQUE("e164"),
	CONSTRAINT "phone_numbers_pool_has_no_agent" CHECK ("phone_numbers"."org_id" is not null or "phone_numbers"."agent_id" is null)
);
--> statement-breakpoint
CREATE TABLE "suppressed_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"source" "suppression_source" NOT NULL,
	"reason" text,
	"call_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressed_numbers_org_e164_key" UNIQUE("org_id","e164")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"credit_cap_inr" numeric(14, 2),
	"daily_cap_inr" numeric(14, 2),
	"balance_check_url" text,
	"balance_check_secret_ciphertext" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_slug_unique" UNIQUE("slug"),
	CONSTRAINT "accounts_credit_cap_positive" CHECK ("accounts"."credit_cap_inr" is null or "accounts"."credit_cap_inr" > 0),
	CONSTRAINT "accounts_daily_cap_positive" CHECK ("accounts"."daily_cap_inr" is null or "accounts"."daily_cap_inr" > 0),
	CONSTRAINT "accounts_balance_check_has_secret" CHECK ("accounts"."balance_check_url" is null or "accounts"."balance_check_secret_ciphertext" is not null)
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix"),
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "org_status" DEFAULT 'active' NOT NULL,
	"record_calls" boolean DEFAULT false NOT NULL,
	"recording_retention_days" integer DEFAULT 30 NOT NULL,
	"redact_pii" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_account_external_id_key" UNIQUE("account_id","external_id"),
	CONSTRAINT "orgs_retention_positive" CHECK ("orgs"."recording_retention_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event" "webhook_event" NOT NULL,
	"event_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_endpoint_event_key" UNIQUE("endpoint_id","event","event_key"),
	CONSTRAINT "webhook_deliveries_usage_never_fails" CHECK ("webhook_deliveries"."event" <> 'usage.recorded' or "webhook_deliveries"."status" <> 'failed')
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"org_id" uuid,
	"url" text NOT NULL,
	"description" text,
	"secret_ciphertext" text NOT NULL,
	"events" "webhook_event"[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_draft_version_fk" FOREIGN KEY ("draft_version_id","id") REFERENCES "public"."agent_versions"("id","agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_live_version_fk" FOREIGN KEY ("live_version_id","id") REFERENCES "public"."agent_versions"("id","agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_candidate_version_fk" FOREIGN KEY ("candidate_version_id","id") REFERENCES "public"."agent_versions"("id","agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_ledger" ADD CONSTRAINT "account_ledger_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_ledger" ADD CONSTRAINT "account_ledger_usage_record_id_usage_records_id_fk" FOREIGN KEY ("usage_record_id") REFERENCES "public"."usage_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_rate_card_id_rate_cards_id_fk" FOREIGN KEY ("rate_card_id") REFERENCES "public"."rate_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_events" ADD CONSTRAINT "call_events_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_phone_number_id_phone_numbers_id_fk" FOREIGN KEY ("phone_number_id") REFERENCES "public"."phone_numbers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_agent_fk" FOREIGN KEY ("agent_id","org_id") REFERENCES "public"."agents"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_agent_version_fk" FOREIGN KEY ("agent_version_id","org_id") REFERENCES "public"."agent_versions"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_org_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressed_numbers" ADD CONSTRAINT "suppressed_numbers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppressed_numbers" ADD CONSTRAINT "suppressed_numbers_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orgs" ADD CONSTRAINT "orgs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_ledger_account_idx" ON "account_ledger" USING btree ("account_id","kind");--> statement-breakpoint
CREATE INDEX "rate_cards_account_effective_idx" ON "rate_cards" USING btree ("account_id","effective_from");--> statement-breakpoint
CREATE INDEX "usage_records_account_created_idx" ON "usage_records" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_records_org_created_idx" ON "usage_records" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "calls_org_created_idx" ON "calls" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "calls_org_disposition_idx" ON "calls" USING btree ("org_id","disposition");--> statement-breakpoint
CREATE INDEX "calls_recording_retention_idx" ON "calls" USING btree ("ended_at") WHERE "calls"."recording_key" is not null and "calls"."recording_deleted_at" is null;--> statement-breakpoint
CREATE INDEX "phone_numbers_org_idx" ON "phone_numbers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "api_keys_account_idx" ON "api_keys" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_endpoints_account_idx" ON "webhook_endpoints" USING btree ("account_id");