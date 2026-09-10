// Legal-suffix tokens stripped from the trailing end of a company name,
// case-insensitive. Longest-alternative-first within each group so a
// multi-word suffix ("Pty Ltd") matches before a shorter one ("Ltd") would
// leave a dangling fragment. Deliberately conservative — a single trailing
// suffix is stripped once, nothing is chain-stripped or fuzzy-merged
// beyond that: "Amazon" and "AWS" must stay distinct entries, not
// collapsed by a similarity heuristic (see docs/outreach-roadmap.md
// Phase 5 for why that line was drawn).
const SUFFIXES = [
  "pty ltd",
  "pte ltd",
  "l\\.l\\.c\\.",
  "l\\.p\\.",
  "s\\.a\\.",
  "b\\.v\\.",
  "llc",
  "ltd\\.",
  "ltd",
  "limited",
  "corp\\.",
  "corp",
  "corporation",
  "co\\.",
  "co",
  "company",
  "gmbh",
  "ag",
  "sa",
  "sas",
  "bv",
  "plc",
  "llp",
  "lp",
  "inc\\.",
  "inc",
];

const SUFFIX_PATTERN = new RegExp(`[\\s,]+(?:${SUFFIXES.join("|")})\\.?\\s*$`, "i");

// Pure. Trims and collapses whitespace, strips one trailing legal-suffix
// token, then trims any punctuation left dangling by that strip. Casing is
// preserved as-is — this is a cache/dedup key, not a display string, and
// case-folding wouldn't fix the harder "QLIK" vs "Qlik" vs "Qlik Technologies"
// variant problem anyway (out of scope: a deliberately conservative,
// non-fuzzy normalization).
export function normalizeCompanyName(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ");
  const stripped = collapsed.replace(SUFFIX_PATTERN, "");
  return stripped.trim().replace(/[.,]+$/, "").trim();
}
