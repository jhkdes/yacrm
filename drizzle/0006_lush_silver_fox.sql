ALTER TABLE "event" ADD COLUMN "embedding" vector(512);--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "summary_embedding" vector(512);