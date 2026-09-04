CREATE TYPE "public"."contact_status" AS ENUM('pending', 'active');--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "status" "contact_status" DEFAULT 'active' NOT NULL;