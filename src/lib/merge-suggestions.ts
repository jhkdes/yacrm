import { namesAreNicknameEquivalent } from "@/lib/nickname-equivalence";

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

// M31: true if the two names have the same first/last "shape" (2 tokens
// each), the last name matches exactly, and the first names are a known
// nickname pair (e.g. "Rob Smith" vs "Robert Smith") — see
// nickname-equivalence.ts. Unlike namesMatchViaSingleInitial, this isn't
// about abbreviation; it requires an actual known name variant, so it's
// scored slightly higher (see scoreContactPair).
function namesMatchViaNickname(nameA: string, nameB: string): boolean {
  const tokensA = nameA.replace(/\./g, "").split(/\s+/).filter(Boolean);
  const tokensB = nameB.replace(/\./g, "").split(/\s+/).filter(Boolean);
  if (tokensA.length !== 2 || tokensB.length !== 2) return false;

  const [aFirst, aLast] = tokensA;
  const [bFirst, bLast] = tokensB;

  return aLast === bLast && namesAreNicknameEquivalent(aFirst, bFirst);
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
    } else if (namesMatchViaNickname(nameA, nameB)) {
      // A known nickname substitution (last name exact, first name a
      // recognized variant) is more specific evidence than a bare
      // initial, so it scores just above name_initial_match.
      score += 0.53;
      reasons.push("name_nickname_match");
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

// A word-like token worth indexing on: strip anything non-alphabetic, then
// require at least 2 letters. Excludes bare initials ("W.", "N.") — those
// are common enough (26-ish buckets) to be useless as a candidate filter,
// and namesMatchViaSingleInitial's own logic already requires the *other*
// side of a pair to contribute the real word, so the initial itself never
// needs to be an index key for that match to still be found.
function indexableTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((token) => token.length > 1);
}

// Every "name-shaped" token this Contact could plausibly be found under:
// its own display-name words, plus its identifier's local part split into
// words (an email like "nadia.kowalski@gmail.com" contributes "nadia" and
// "kowalski" even though this Contact's displayName might just be "N. K.")
// — this is what lets the identifier-spells-out-the-name signal
// (localPartMatchesName) find its candidate pair without a full scan.
function nameIndexTokens(c: ContactForMatching): string[] {
  const nameTokens = c.displayName
    ? indexableTokens(c.displayName.replace(/\s+/g, " "))
    : [];
  const atIndex = c.sourceIdentifier.indexOf("@");
  const localPartTokens =
    atIndex === -1 ? [] : indexableTokens(c.sourceIdentifier.slice(0, atIndex));
  return [...new Set([...nameTokens, ...localPartTokens])];
}

// Builds only the pairs worth ever scoring, instead of every C(n,2)
// combination. A pair is a candidate if the two Contacts either share an
// exact identifier (the same_identifier_different_source signal) or share
// at least one name-shaped token (every other signal — exact/fuzzy/initial
// name match, and identifier-spells-out-name in either direction — always
// has both sides land in at least one common token bucket by construction).
// This trades a small, deliberate recall gap — two names that are *both*
// misspelled in a way that shares no token at all — for turning what was an
// O(n²) scan (with an O(len²) edit-distance call for most pairs) into
// roughly O(n) bucket construction plus work proportional to how many
// Contacts actually share a name or identifier, which is what made the
// merges page slow once the Contact count reached the low thousands.
function findCandidatePairs(
  contacts: ContactForMatching[],
): [ContactForMatching, ContactForMatching][] {
  const byIdentifier = new Map<string, ContactForMatching[]>();
  const byNameToken = new Map<string, ContactForMatching[]>();

  for (const c of contacts) {
    const identifierBucket = byIdentifier.get(c.sourceIdentifier);
    if (identifierBucket) identifierBucket.push(c);
    else byIdentifier.set(c.sourceIdentifier, [c]);

    for (const token of nameIndexTokens(c)) {
      const tokenBucket = byNameToken.get(token);
      if (tokenBucket) tokenBucket.push(c);
      else byNameToken.set(token, [c]);
    }
  }

  const seenPairs = new Set<string>();
  const pairs: [ContactForMatching, ContactForMatching][] = [];

  function addPairsFromBucket(bucket: ContactForMatching[]) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        if (a.personId === b.personId) continue;
        const pairKey =
          a.contactId < b.contactId
            ? `${a.contactId}:${b.contactId}`
            : `${b.contactId}:${a.contactId}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        pairs.push([a, b]);
      }
    }
  }

  for (const bucket of byIdentifier.values()) {
    if (bucket.length > 1) addPairsFromBucket(bucket);
  }
  for (const bucket of byNameToken.values()) {
    if (bucket.length > 1) addPairsFromBucket(bucket);
  }

  return pairs;
}

// Compares Contacts across different Persons (contacts already on the same
// Person have nothing to suggest) and returns ranked, deduplicated
// Person-level suggestions — the strongest Contact-pair evidence found for
// each candidate Person pair.
export function generateMergeSuggestions(
  contacts: ContactForMatching[],
): MergeSuggestion[] {
  const bestByPersonPair = new Map<string, MergeSuggestion>();

  for (const [a, b] of findCandidatePairs(contacts)) {
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

  return Array.from(bestByPersonPair.values()).sort(
    (x, y) => y.score - x.score,
  );
}
