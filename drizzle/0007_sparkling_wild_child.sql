CREATE TYPE "public"."campaign_recipient_channel" AS ENUM('email', 'linkedin');--> statement-breakpoint
CREATE TYPE "public"."campaign_recipient_status" AS ENUM('drafted', 'sent', 'opened', 'clicked', 'completed');--> statement-breakpoint
CREATE TYPE "public"."campaign_type" AS ENUM('interview_link', 'intro');--> statement-breakpoint
CREATE TABLE "campaign" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "campaign_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"type" "campaign_type" DEFAULT 'interview_link' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_recipient" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "campaign_recipient_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"campaign_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"channel" "campaign_recipient_channel" NOT NULL,
	"status" "campaign_recipient_status" DEFAULT 'drafted' NOT NULL,
	"draft_subject" text,
	"draft_body" text NOT NULL,
	"tracking_token" text NOT NULL,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"followed_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_recipient_campaign_id_person_id_unique" UNIQUE("campaign_id","person_id"),
	CONSTRAINT "campaign_recipient_tracking_token_unique" UNIQUE("tracking_token")
);
--> statement-breakpoint
ALTER TABLE "campaign_recipient" ADD CONSTRAINT "campaign_recipient_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipient" ADD CONSTRAINT "campaign_recipient_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipient" ADD CONSTRAINT "campaign_recipient_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE no action ON UPDATE no action;