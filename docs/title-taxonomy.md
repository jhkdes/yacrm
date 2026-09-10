# Title Taxonomy

Fixed enums the LinkedIn import's title-extraction step maps every connection's raw `Position` string onto. Canonical — when the extraction prompt, schema enum, or filter UI disagree with this file, this file wins.

Three fields come out of one raw title string:

- **Standardized title** — a short, human-readable canonical title (freeform text, not an enum)
- **Seniority** — one fixed value from the list below
- **Function** — one fixed value from the list below

Fixed enums exist so the campaign filter UI can offer a clean dropdown instead of free text that fragments across near-duplicate values ("Product" vs "Product Management"). Standardized title stays freeform since it's for display, not filtering.

## Seniority

| Value | Guidance |
|---|---|
| `ic` | Individual contributor — no reports. Includes "Senior," "Staff," "Principal," "Lead" *when "Lead" doesn't denote people management* (title-dependent, use judgment) |
| `manager` | First-line or mid-level people management: "Manager," "Team Lead" (people-management sense), "Head of" a small team |
| `director` | "Director," "Senior Director," "Group Manager" |
| `vp` | "VP," "Vice President," "SVP," "EVP" |
| `c_level` | "Chief \*Officer" (CEO, CTO, CPO, CMO, etc.), "President" |
| `founder` | "Founder," "Co-Founder," "Owner" — takes priority over any other seniority signal in the same title |
| `unknown` | Title present but seniority can't be confidently determined (e.g. just "Consultant," "Advisor," or too vague) |

## Function

| Value | Guidance |
|---|---|
| `product_management` | Product Manager, Product Owner, Head of Product |
| `product_marketing` | Product Marketing Manager, PMM |
| `engineering` | Software/Platform/Infrastructure/QA Engineering, Engineering Management |
| `design` | Product Design, UX/UI, Design Research |
| `data_analytics` | Data Science, Data Engineering, Analytics, BI |
| `sales` | Sales, Account Executive, Business Development (revenue-generating, external-facing) |
| `marketing` | Marketing (brand, demand gen, content) — everything marketing *except* product marketing |
| `customer_success` | Customer Success, Support, Implementation, Solutions Engineering (post-sale, customer-facing) |
| `operations` | Business Ops, Revenue Ops, Strategy & Ops, general "Operations" |
| `finance` | Finance, Accounting, FP&A |
| `people_hr` | HR, People, Talent, Recruiting |
| `legal` | Legal, Compliance |
| `it` | Internal IT, Security (corporate, not product security) |
| `executive_general` | General management not captured above: CEO acting as generalist, General Manager, Managing Director |
| `other` | Doesn't fit cleanly, or title is too vague to classify |

## Standardized title

Strip qualifiers, scope, and team/product-area detail that don't change the role itself; keep seniority + function words.

**Examples:**

| Raw `Position` | Standardized title | Seniority | Function |
|---|---|---|---|
| Director of Product Management - Cloud Platform, Integration, Embedded and API Strategy | Director of Product Management | `director` | `product_management` |
| Product Team Lead | Product Team Lead | `manager` | `product_management` |
| Senior Software Engineer, Payments Infrastructure | Senior Software Engineer | `ic` | `engineering` |
| VP, Global Product Marketing | VP of Product Marketing | `vp` | `product_marketing` |
| Co-Founder & CEO | Co-Founder & CEO | `founder` | `executive_general` |
| Growth Marketing Consultant | Growth Marketing Consultant | `unknown` | `marketing` |

## Ambiguity rule

When either seniority or function can't be determined with reasonable confidence from the title text alone, use `unknown` / `other` rather than guessing. A wrong-but-confident-looking value is worse than a visibly-unclassified one, since it silently corrupts filter results instead of surfacing as a gap.

---

*Extraction runs once per person at LinkedIn CSV import time (and only on new/changed rows on re-import), independent of the per-company industry inference — see [glossary](./glossary.md) and [technical design](./technical-design-and-milestones.md) for how this fits the broader import pipeline.*
