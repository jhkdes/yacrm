ALTER TABLE "campaign" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_recipient" ADD COLUMN "deleted_at" timestamp with time zone;