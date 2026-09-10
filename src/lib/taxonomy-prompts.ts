// Shared prompt text for the three LLM calls that reference the Phase 5
// taxonomies (docs/title-taxonomy.md, docs/industry-taxonomy.md):
// title-extraction.ts, industry-inference.ts, and filter-drafting.ts.
// Extracted here once these guidance tables had a third consumer, so they
// can't independently drift out of sync across the three prompts the way
// three separate inline copies risked. Each consumer wraps this in its own
// task-specific framing/examples/ambiguity-rule text — this file is just
// the taxonomy tables themselves, verbatim from the source docs.

export const SENIORITY_FUNCTION_GUIDANCE = `## Seniority values
- ic: Individual contributor — no reports. Includes "Senior," "Staff," "Principal," "Lead" when "Lead" doesn't denote people management (title-dependent, use judgment).
- manager: First-line or mid-level people management: "Manager," "Team Lead" (people-management sense), "Head of" a small team.
- director: "Director," "Senior Director," "Group Manager."
- vp: "VP," "Vice President," "SVP," "EVP."
- c_level: "Chief *Officer" (CEO, CTO, CPO, CMO, etc.), "President."
- founder: "Founder," "Co-Founder," "Owner" — takes priority over any other seniority signal in the same title.
- unknown: Title present but seniority can't be confidently determined (e.g. just "Consultant," "Advisor," or too vague).

## Function values
- product_management: Product Manager, Product Owner, Head of Product.
- product_marketing: Product Marketing Manager, PMM.
- engineering: Software/Platform/Infrastructure/QA Engineering, Engineering Management.
- design: Product Design, UX/UI, Design Research.
- data_analytics: Data Science, Data Engineering, Analytics, BI.
- sales: Sales, Account Executive, Business Development (revenue-generating, external-facing).
- marketing: Marketing (brand, demand gen, content) — everything marketing except product marketing.
- customer_success: Customer Success, Support, Implementation, Solutions Engineering (post-sale, customer-facing).
- operations: Business Ops, Revenue Ops, Strategy & Ops, general "Operations."
- finance: Finance, Accounting, FP&A.
- people_hr: HR, People, Talent, Recruiting.
- legal: Legal, Compliance.
- it: Internal IT, Security (corporate, not product security).
- executive_general: General management not captured above: CEO acting as generalist, General Manager, Managing Director.
- other: Doesn't fit cleanly, or title is too vague to classify.`;

export const INDUSTRY_GUIDANCE = `Software/tech is split into sub-categories since a flat "Software" bucket can't express the B2B-enterprise-vs-consumer-vs-dev-tools distinctions that campaign filters actually need. Everything else stays broad.

## Industry values
- tech_enterprise_software: B2B software sold to businesses — horizontal or vertical SaaS, not infra/dev-tools-specific. Examples: Salesforce, Workday, Qlik, ServiceNow.
- tech_dev_tools_infra: Developer tools, cloud infrastructure, API/platform products — B2B but aimed at engineers/technical buyers specifically. Examples: AWS, GitHub, Datadog, Twilio.
- tech_cybersecurity: Security software/services, any buyer. Examples: CrowdStrike, Okta, Palo Alto Networks.
- tech_fintech: Financial software/technology products — not traditional banks/insurers themselves. Examples: Stripe, Plaid, Brex.
- tech_healthtech: Health software/technology products — not hospitals/providers/pharma themselves. Examples: Epic, Oscar Health, Doximity.
- tech_edtech: Education technology products. Examples: Coursera, Duolingo, Canvas (Instructure).
- tech_martech_adtech: Marketing/advertising technology. Examples: HubSpot, The Trade Desk, Braze.
- tech_consumer_software: B2C apps/software not covered above. Examples: Spotify, Airbnb.
- tech_gaming: Video games, interactive entertainment software. Examples: Riot Games, Epic Games, EA.
- tech_hardware_semiconductors: Physical hardware, devices, chips. Examples: NVIDIA, Apple (hardware side), Cisco.
- telecommunications: Telecom carriers/infrastructure (non-software). Examples: Verizon, T-Mobile, AT&T.
- financial_services: Banking, insurance, investment/asset management — traditional, not fintech software companies. Examples: JPMorgan Chase, Goldman Sachs, State Farm.
- healthcare: Healthcare providers, pharma, biotech, medical devices — not health-software companies. Examples: UnitedHealth Group, Pfizer, Mayo Clinic.
- retail_ecommerce: Retail and e-commerce, consumer goods brands. Examples: Walmart, Target, Nike.
- manufacturing_industrial: Manufacturing, industrial equipment, automotive, aerospace. Examples: Boeing, Caterpillar, GE.
- media_entertainment: Publishing, film/TV, music, non-gaming entertainment. Examples: Disney, NBCUniversal, The New York Times.
- professional_services: Consulting, legal, accounting, staffing. Examples: McKinsey, Deloitte.
- education: Schools, universities, non-tech education orgs. Examples: Stanford University, a school district.
- government_public_sector: Government agencies, public sector orgs.
- nonprofit: Nonprofits, foundations, NGOs.
- real_estate: Real estate, property management, construction. Examples: CBRE, a homebuilder.
- transportation_logistics: Shipping, logistics, transportation (non-software). Examples: FedEx, Union Pacific.
- energy_utilities: Energy, oil & gas, utilities. Examples: ExxonMobil, a regional utility.
- other: Real, identifiable industry that doesn't fit any value above.
- unknown: Company can't be confidently classified (unfamiliar/ambiguous name, insufficient signal).`;
