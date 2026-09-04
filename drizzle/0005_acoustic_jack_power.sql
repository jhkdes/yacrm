CREATE TABLE "dismissed_merge_suggestion" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dismissed_merge_suggestion_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"person_a_id" integer NOT NULL,
	"person_b_id" integer NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dismissed_merge_suggestion_person_a_id_person_b_id_unique" UNIQUE("person_a_id","person_b_id")
);
--> statement-breakpoint
ALTER TABLE "dismissed_merge_suggestion" ADD CONSTRAINT "dismissed_merge_suggestion_person_a_id_person_id_fk" FOREIGN KEY ("person_a_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dismissed_merge_suggestion" ADD CONSTRAINT "dismissed_merge_suggestion_person_b_id_person_id_fk" FOREIGN KEY ("person_b_id") REFERENCES "public"."person"("id") ON DELETE cascade ON UPDATE no action;