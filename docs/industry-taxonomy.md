# Industry Taxonomy

Fixed enum the LinkedIn import's industry-inference step maps every (rule-normalized) company name onto. Canonical — when the extraction prompt, schema enum, or filter UI disagree with this file, this file wins. See [title-taxonomy.md](./title-taxonomy.md) for the sibling per-person taxonomy (seniority/function); this one is per-**company**, inferred once per normalized company name and cached — not re-run per person, and not re-run per raw name variant that normalizes to the same company (see [technical design](./technical-design-and-milestones.md) for the suffix-stripping normalization rule).

Software/tech is split into sub-categories since a flat "Software" bucket can't express the B2B-enterprise-vs-consumer-vs-dev-tools distinctions that campaign filters actually need. Everything else stays broad.

## Values

| Value | Guidance | Example companies |
|---|---|---|
| `tech_enterprise_software` | B2B software sold to businesses — horizontal or vertical SaaS, not infra/dev-tools-specific | Salesforce, Workday, Qlik, ServiceNow |
| `tech_dev_tools_infra` | Developer tools, cloud infrastructure, API/platform products — B2B but aimed at engineers/technical buyers specifically | AWS, GitHub, Datadog, Twilio |
| `tech_cybersecurity` | Security software/services, any buyer | CrowdStrike, Okta, Palo Alto Networks |
| `tech_fintech` | Financial *software/technology* products — not traditional banks/insurers themselves | Stripe, Plaid, Brex |
| `tech_healthtech` | Health *software/technology* products — not hospitals/providers/pharma themselves | Epic, Oscar Health, Doximity |
| `tech_edtech` | Education technology products | Coursera, Duolingo, Canvas (Instructure) |
| `tech_martech_adtech` | Marketing/advertising technology | HubSpot, The Trade Desk, Braze |
| `tech_consumer_software` | B2C apps/software not covered above | Spotify, Airbnb, Duolingo-adjacent consumer apps |
| `tech_gaming` | Video games, interactive entertainment software | Riot Games, Epic Games, EA |
| `tech_hardware_semiconductors` | Physical hardware, devices, chips | NVIDIA, Apple (hardware side), Cisco |
| `telecommunications` | Telecom carriers/infrastructure (non-software) | Verizon, T-Mobile, AT&T |
| `financial_services` | Banking, insurance, investment/asset management — traditional, not fintech software companies | JPMorgan Chase, Goldman Sachs, State Farm |
| `healthcare` | Healthcare providers, pharma, biotech, medical devices — not health-software companies | UnitedHealth Group, Pfizer, Mayo Clinic |
| `retail_ecommerce` | Retail and e-commerce, consumer goods brands | Walmart, Target, Nike |
| `manufacturing_industrial` | Manufacturing, industrial equipment, automotive, aerospace | Boeing, Caterpillar, GE |
| `media_entertainment` | Publishing, film/TV, music, non-gaming entertainment | Disney, NBCUniversal, The New York Times |
| `professional_services` | Consulting, legal, accounting, staffing | McKinsey, Deloitte, WeWork-adjacent services firms |
| `education` | Schools, universities, non-tech education orgs | Stanford University, a school district |
| `government_public_sector` | Government agencies, public sector orgs | A city government, a federal agency |
| `nonprofit` | Nonprofits, foundations, NGOs | A charitable foundation |
| `real_estate` | Real estate, property management, construction | CBRE, a homebuilder |
| `transportation_logistics` | Shipping, logistics, transportation (non-software) | FedEx, Union Pacific |
| `energy_utilities` | Energy, oil & gas, utilities | ExxonMobil, a regional utility |
| `other` | Real, identifiable industry that doesn't fit any value above | — |
| `unknown` | Company can't be confidently classified (unfamiliar/ambiguous name, insufficient signal) | — |

## Ambiguity rule

Same principle as the title taxonomy: if the company can't be confidently classified, use `unknown` rather than guess. A software company that happens to serve, say, healthcare providers (health*tech*) is `tech_healthtech`; an actual hospital system is `healthcare` — when that line is genuinely unclear from the company name alone, prefer `unknown` over picking one arbitrarily.
