CREATE TABLE "purged_contact" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "purged_contact_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"source" "source" NOT NULL,
	"source_identifier" text NOT NULL,
	"purged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purged_contact_source_source_identifier_unique" UNIQUE("source","source_identifier")
);
