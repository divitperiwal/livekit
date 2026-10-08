ALTER TABLE "calls" ADD COLUMN "api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "max_concurrent_calls" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_live_by_api_key_idx" ON "calls" USING btree ("api_key_id") WHERE "calls"."status" in ('queued', 'ringing', 'in_progress');--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_max_concurrent_calls_positive" CHECK ("api_keys"."max_concurrent_calls" > 0);