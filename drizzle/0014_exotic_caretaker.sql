CREATE TABLE "company_industry_cache" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "company_industry_cache_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"normalized_company_name" text NOT NULL,
	"industry" "company_industry" NOT NULL,
	"inferred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_industry_cache_normalized_company_name_unique" UNIQUE("normalized_company_name")
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "normalized_company_name" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "industry" "company_industry";