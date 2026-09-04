export interface ContactForMatching {
  contactId: number;
  personId: number;
  source: string;
  sourceIdentifier: string;
  displayName: string | null;
}

export interface MergeSuggestion {
  personAId: number;
  personBId: number;
  // The specific Contact pair that produced this suggestion's score —
  // useful for showing "why" in a review UI (M8).
  contactAId: number;
  contactBId: number;
  score: number;
  reasons: string[];
}

const MIN_SUGGESTION_SCORE = 0.5;
const FUZZY_NAME_SIMILARITY_THRESHOLD = 0.85;

function normalizeName(name: string | null): string | null {
  if (!name) return null;
  const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized || null;
}

// Damerau-Levenshtein (restricted/optimal-string-alignment variant): like
// Levenshtein, but an adjacent transposition (e.g. "theil" -> "thiel") costs
// 1 edit instead of 2 — the common case for a typo'd name, so plain
// Levenshtein would under-rate an obvious near-match.
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        dist[i - 1][j] + 1,
        dist[i][j - 1] + 1,
        dist[i - 1][j - 1] + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        best = Math.min(best, dist[i - 2][j - 2] + 1);
      }
      dist[i][j] = best;
    }
  }
  return dist[rows - 1][cols - 1];
}

// 1.0 = identical, 0.0 = completely different.
function nameSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - editDistance(a, b) / maxLen;
}

function emailLocalPart(identifier: string): string | null {
  const atIndex = identifier.indexOf("@");
  return atIndex === -1 ? null : identifier.slice(0, atIndex);
}

// Does this email local-part plausibly spell out this full name? Handles
// the common address conventions: "firstname.lastname", "flastname",
// "firstnamel" — deliberately excludes a bare first- or last-name-only
// match, since "smith@..." alone is far too likely to collide with an
// unrelated person who happens to share that last name.
function localPartMatchesName(
  localPart: string,
  name: string | null,
): boolean {
  if (!name) return false;

  const rawTokens = localPart.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const nameTokens = name
    .toLowerCase()
    .replace(/\./g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (rawTokens.length === 0 || nameTokens.length < 2) return false;

  const first = nameTokens[0];
  const last = nameTokens[nameTokens.length - 1];

  if (rawTokens.length >= 2) {
    // e.g. "nadia.kowalski" vs "Nadia Kowalski"
    const rawSet = new Set(rawTokens);
    return rawSet.has(first) && rawSet.has(last);
  }

  // Single unseparated token, e.g. "nkowalski" — try common conventions.
  const token = rawTokens[0];
  return [first + last, first[0] + last, first + last[0], last + first[0]].includes(
    token,
  );
}

// True if the two names have the same first/last "shape" (2 tokens each)
// where exactly one slot matches fully and the other is abbreviated to an
// initial in one of the two names — e.g. "Dana W." vs "Dana Wilkins"
// (first matches fully, last is an initial). Requires at least one full
// match so two bare initial-pairs (which collide far too easily — "D. W."
// matches both "Dana Wilkins" and "Derek Watts") never qualify here.
function namesMatchViaSingleInitial(
  nameA: string,
  nameB: string,
): boolean {
  const tokensA = nameA.replace(/\./g, "").split(/\s+/).filter(Boolean);
  const tokensB = nameB.replace(/\./g, "").split(/\s+/).filter(Boolean);
  if (tokensA.length !== 2 || tokensB.length !== 2) return false;

  const slotMatches = (x: string, y: string) =>
    x === y || (x.length === 1 && x === y[0]) || (y.length === 1 && y === x[0]);
  // Two matching initials (e.g. "V." vs "V.") must NOT count as a full-word
  // match — that's exactly the too-weak bare-initials case to exclude.
  const slotIsFullWordMatch = (x: string, y: string) =>
    x === y && x.length > 1;

  const [aFirst, aLast] = tokensA;
  const [bFirst, bLast] = tokensB;

  if (!slotMatches(aFirst, bFirst) || !slotMatches(aLast, bLast)) return false;
  return slotIsFullWordMatch(aFirst, bFirst) || slotIsFullWordMatch(aLast, bLast);
}

function scoreContactPair(
  a: ContactForMatching,
  b: ContactForMatching,
): { score: number; reasons: string[] } | null {
  let score = 0;
  const reasons: string[] = [];

  // The same raw identifier (email/phone) showing up under a different
  // source — e.g. the same email address used for both Gmail and LinkedIn.
  if (a.sourceIdentifier === b.sourceIdentifier && a.source !== b.source) {
    score += 0.9;
    reasons.push("same_identifier_different_source");
  }

  const nameA = normalizeName(a.displayName);
  const nameB = normalizeName(b.displayName);
  if (nameA && nameB) {
    if (nameA === nameB) {
      score += 0.6;
      reasons.push("exact_name_match");
    } else if (namesMatchViaSingleInitial(nameA, nameB)) {
      // Weakest of the name-based signals by design — an abbreviated name
      // slot is real evidence, but far less certain than a full match.
      score += 0.52;
      reasons.push("name_initial_match");
    } else {
      const similarity = nameSimilarity(nameA, nameB);
      if (similarity >= FUZZY_NAME_SIMILARITY_THRESHOLD) {
        // Scaled so a just-qualifying match still clears
        // MIN_SUGGESTION_SCORE, capping just below a full exact-name-match
        // score (a fuzzy match should never outrank an exact one).
        score += 0.5 + similarity * 0.1;
        reasons.push("similar_name");
      }
    }
  }

  // Catches cases where the display name alone is uninformative (e.g. "V.
  // O.") but the email address spells out the other Contact's full name.
  const aLocalPart = emailLocalPart(a.sourceIdentifier);
  const bLocalPart = emailLocalPart(b.sourceIdentifier);
  if (
    (aLocalPart && localPartMatchesName(aLocalPart, b.displayName)) ||
    (bLocalPart && localPartMatchesName(bLocalPart, a.displayName))
  ) {
    score += 0.55;
    reasons.push("email_matches_other_name");
  }

  if (score === 0) return null;
  return { score: Math.min(score, 1), reasons };
}

// Compares Contacts across different Persons (contacts already on the same
// Person have nothing to suggest) and returns ranked, deduplicated
// Person-level suggestions — the strongest Contact-pair evidence found for
// each candidate Person pair.
export function generateMergeSuggestions(
  contacts: ContactForMatching[],
): MergeSuggestion[] {
  const bestByPersonPair = new Map<string, MergeSuggestion>();

  for (let i = 0; i < contacts.length; i += 1) {
    for (let j = i + 1; j < contacts.length; j += 1) {
      const a = contacts[i];
      const b = contacts[j];
      if (a.personId === b.personId) continue;

      const result = scoreContactPair(a, b);
      if (!result || result.score < MIN_SUGGESTION_SCORE) continue;

      const [personAId, personBId] =
        a.personId < b.personId
          ? [a.personId, b.personId]
          : [b.personId, a.personId];
      const key = `${personAId}:${personBId}`;

      const existing = bestByPersonPair.get(key);
      if (!existing || result.score > existing.score) {
        bestByPersonPair.set(key, {
          personAId,
          personBId,
          contactAId: a.contactId,
          contactBId: b.contactId,
          score: result.score,
          reasons: result.reasons,
        });
      }
    }
  }

  return Array.from(bestByPersonPair.values()).sort(
    (x, y) => y.score - x.score,
  );
}
