import { describe, expect, it } from "vitest";

import { ContactForMatching, generateMergeSuggestions } from "./merge-suggestions";

function contact(
  overrides: Partial<ContactForMatching> & { contactId: number; personId: number },
): ContactForMatching {
  return {
    source: "gmail",
    sourceIdentifier: `contact-${overrides.contactId}@example.com`,
    displayName: null,
    ...overrides,
  };
}

describe("generateMergeSuggestions", () => {
  it("suggests a merge for the same name across different email domains", () => {
    const contacts = [
      contact({
        contactId: 1,
        personId: 1,
        sourceIdentifier: "jane.doe@personalmail.com",
        displayName: "Jane Doe",
      }),
      contact({
        contactId: 2,
        personId: 2,
        sourceIdentifier: "jane.doe@company.com",
        displayName: "Jane Doe",
      }),
    ];

    const suggestions = generateMergeSuggestions(contacts);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ personAId: 1, personBId: 2 });
    // Both signals legitimately fire here: identical names, and each
    // "firstname.lastname" address also happens to spell out that name.
    expect(suggestions[0].reasons).toContain("exact_name_match");
  });

  it("does not suggest a merge for obviously different people", () => {
    const contacts = [
      contact({ contactId: 1, personId: 1, displayName: "John Smith" }),
      contact({ contactId: 2, personId: 2, displayName: "Jane Doe" }),
    ];

    expect(generateMergeSuggestions(contacts)).toHaveLength(0);
  });

  it("mixes obviously-same and obviously-different pairs correctly in one batch", () => {
    const contacts = [
      contact({ contactId: 1, personId: 1, displayName: "Jane Doe" }),
      contact({
        contactId: 2,
        personId: 2,
        sourceIdentifier: "jane@work.com",
        displayName: "Jane Doe",
      }),
      contact({ contactId: 3, personId: 3, displayName: "Bob Builder" }),
    ];

    const suggestions = generateMergeSuggestions(contacts);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].personAId).toBe(1);
    expect(suggestions[0].personBId).toBe(2);
  });

  it("suggests a merge when the same identifier appears under a different source", () => {
    const contacts = [
      contact({
        contactId: 1,
        personId: 1,
        source: "gmail",
        sourceIdentifier: "ada@example.com",
        displayName: "Ada",
      }),
      contact({
        contactId: 2,
        personId: 2,
        source: "linkedin",
        sourceIdentifier: "ada@example.com",
        displayName: null,
      }),
    ];

    const suggestions = generateMergeSuggestions(contacts);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].reasons).toContain(
      "same_identifier_different_source",
    );
  });

  it("does not suggest a merge for contacts already on the same Person", () => {
    const contacts = [
      contact({ contactId: 1, personId: 1, displayName: "Jane Doe" }),
      contact({
        contactId: 2,
        personId: 1,
        sourceIdentifier: "jane@work.com",
        displayName: "Jane Doe",
      }),
    ];

    expect(generateMergeSuggestions(contacts)).toHaveLength(0);
  });

  it("does not suggest a merge for merely similar-but-different short names", () => {
    const contacts = [
      contact({ contactId: 1, personId: 1, displayName: "Mike" }),
      contact({ contactId: 2, personId: 2, displayName: "Mark" }),
    ];

    expect(generateMergeSuggestions(contacts)).toHaveLength(0);
  });

  it("suggests a merge for a close name typo variant above the similarity threshold", () => {
    const contacts = [
      contact({ contactId: 1, personId: 1, displayName: "Rich Theil" }),
      contact({
        contactId: 2,
        personId: 2,
        sourceIdentifier: "rich.t@other.com",
        displayName: "Rich Thiel",
      }),
    ];

    const suggestions = generateMergeSuggestions(contacts);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].reasons).toContain("similar_name");
  });

  it("deduplicates to the single strongest suggestion per Person pair", () => {
    const contacts = [
      contact({
        contactId: 1,
        personId: 1,
        sourceIdentifier: "jane@personal.com",
        displayName: "Jane Doe",
      }),
      contact({
        contactId: 2,
        personId: 1,
        source: "linkedin",
        sourceIdentifier: "jane-linkedin",
        displayName: "Jane Doe",
      }),
      contact({
        contactId: 3,
        personId: 2,
        sourceIdentifier: "jane@work.com",
        displayName: "Jane Doe",
      }),
    ];

    const suggestions = generateMergeSuggestions(contacts);

    // Two Person-1 contacts each match the one Person-2 contact by name —
    // should collapse to one suggestion for the (1, 2) Person pair, not two.
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ personAId: 1, personBId: 2 });
  });

  it("ranks stronger evidence (identifier + name) above name-only matches", () => {
    const contacts = [
      // Person 1 & 2: name-only match.
      contact({ contactId: 1, personId: 1, displayName: "Jane Doe" }),
      contact({
        contactId: 2,
        personId: 2,
        sourceIdentifier: "jane@work.com",
        displayName: "Jane Doe",
      }),
      // Person 3 & 4: same identifier across sources AND matching name.
      contact({
        contactId: 3,
        personId: 3,
        source: "gmail",
        sourceIdentifier: "ada@example.com",
        displayName: "Ada Lovelace",
      }),
      contact({
        contactId: 4,
        personId: 4,
        source: "linkedin",
        sourceIdentifier: "ada@example.com",
        displayName: "Ada Lovelace",
      }),
    ];

    const suggestions = generateMergeSuggestions(contacts);

    expect(suggestions).toHaveLength(2);
    // Highest score first.
    expect(suggestions[0]).toMatchObject({ personAId: 3, personBId: 4 });
    expect(suggestions[0].score).toBeGreaterThan(suggestions[1].score);
  });

  it("suggests a merge when one contact's initials-only name is uninformative but its email spells out the other's full name", () => {
    const contacts = [
      contact({
        contactId: 1,
        personId: 1,
        sourceIdentifier: "nadia.kowalski@gmail.com",
        displayName: "N. K.",
      }),
      contact({
        contactId: 2,
        personId: 2,
        sourceIdentifier: "nkowalski@egnyte.com",
        displayName: "Nadia Kowalski",
      }),
    ];

    const suggestions = generateMergeSuggestions(contacts);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ personAId: 1, personBId: 2 });
    expect(suggestions[0].reasons).toContain("email_matches_other_name");
  });

  it("does not suggest a merge on a bare shared last name in the email alone", () => {
    // "smith@..." matching any "... Smith" would be far too likely to
    // collide with an unrelated person who just shares that last name.
    const contacts = [
      contact({
        contactId: 1,
        personId: 1,
        sourceIdentifier: "smith@company-a.com",
        displayName: null,
      }),
      contact({
        contactId: 2,
        personId: 2,
        sourceIdentifier: "jane.doe@company-b.com",
        displayName: "Jane Smith",
      }),
    ];

    expect(generateMergeSuggestions(contacts)).toHaveLength(0);
  });

  it("suggests a merge when one name's last part is abbreviated to an initial", () => {
    const contacts = [
      contact({
        contactId: 1,
        personId: 1,
        sourceIdentifier: "person1@gmail.com",
        displayName: "Dana W.",
      }),
      contact({
        contactId: 2,
        personId: 2,
        sourceIdentifier: "dana.wilkins@smarsh.com",
        displayName: "Dana Wilkins",
      }),
    ];

    const suggestions = generateMergeSuggestions(contacts);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ personAId: 1, personBId: 2 });
    expect(suggestions[0].reasons).toContain("name_initial_match");
    // Weaker than a full exact name match, per the "not a strong match"
    // intent — but still above the suggestion threshold.
    expect(suggestions[0].score).toBeLessThan(0.6);
  });

  it("suggests a merge when the first name is abbreviated instead of the last", () => {
    const contacts = [
      contact({ contactId: 1, personId: 1, displayName: "D. Wilkins" }),
      contact({
        contactId: 2,
        personId: 2,
        sourceIdentifier: "dana.wilkins@other.com",
        displayName: "Dana Wilkins",
      }),
    ];

    const suggestions = generateMergeSuggestions(contacts);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].reasons).toContain("name_initial_match");
  });

  it("does not credit name_initial_match for two bare-initials names, even when the letters line up", () => {
    // Two contacts both literally named "N. K." still match via
    // exact_name_match (same as any other identical string, e.g. two "Jane
    // Doe"s) — but that's a pre-existing, separate concern. This guards
    // specifically against namesMatchViaSingleInitial treating a pair of
    // bare initials as sufficient evidence on its own: "N. K." could be
    // Nadia Kowalski, Nick Kim, Nora Klein... two initials alone are
    // nowhere near enough.
    const contacts = [
      contact({ contactId: 1, personId: 1, displayName: "N. K." }),
      contact({ contactId: 2, personId: 2, displayName: "N. K." }),
    ];

    const suggestions = generateMergeSuggestions(contacts);
    expect(suggestions[0]?.reasons).not.toContain("name_initial_match");
  });

  it("does not match names with different first names just because the last is abbreviated the same way", () => {
    const contacts = [
      contact({ contactId: 1, personId: 1, displayName: "Dana W." }),
      contact({
        contactId: 2,
        personId: 2,
        sourceIdentifier: "derek.watson@other.com",
        displayName: "Derek Watson",
      }),
    ];

    expect(generateMergeSuggestions(contacts)).toHaveLength(0);
  });
});
