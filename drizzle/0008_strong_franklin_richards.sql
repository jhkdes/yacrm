ALTER TABLE "campaign_recipient" DROP CONSTRAINT "campaign_recipient_campaign_id_campaign_id_fk";
--> statement-breakpoint
ALTER TABLE "campaign_recipient" ADD CONSTRAINT "campaign_recipient_campaign_id_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaign"("id") ON DELETE cascade ON UPDATE no action;