import { describe, expect, it } from "vitest";

import { inferCompanyDomains } from "./company-signal";

describe("inferCompanyDomains", () => {
  it("returns the domain for a non-free-mail email address", () => {
    expect(
      inferCompanyDomains([
        { source: "gmail", sourceIdentifier: "nadia@acmecorp.com" },
      ]),
    ).toEqual(["acmecorp.com"]);
  });

  it("excludes common free/personal email providers", () => {
    expect(
      inferCompanyDomains([
        { source: "gmail", sourceIdentifier: "nadia@gmail.com" },
        { source: "gmail", sourceIdentifier: "nadia@yahoo.com" },
        { source: "gmail", sourceIdentifier: "nadia@outlook.com" },
      ]),
    ).toEqual([]);
  });

  it("returns multiple distinct work domains, sorted", () => {
    expect(
      inferCompanyDomains([
        { source: "gmail", sourceIdentifier: "nadia@zetacorp.com" },
        { source: "gmail", sourceIdentifier: "nadia@acmecorp.com" },
      ]),
    ).toEqual(["acmecorp.com", "zetacorp.com"]);
  });

  it("deduplicates the same domain across multiple contacts", () => {
    expect(
      inferCompanyDomains([
        { source: "gmail", sourceIdentifier: "nadia@acmecorp.com" },
        { source: "gmail", sourceIdentifier: "n.kowalski@acmecorp.com" },
      ]),
    ).toEqual(["acmecorp.com"]);
  });

  it("ignores non-email sources like linkedin/sms identifiers", () => {
    expect(
      inferCompanyDomains([
        { source: "linkedin", sourceIdentifier: "nadia-kowalski-123" },
        { source: "sms", sourceIdentifier: "+15551234567" },
      ]),
    ).toEqual([]);
  });

  it("mixes a personal and a work address correctly", () => {
    expect(
      inferCompanyDomains([
        { source: "gmail", sourceIdentifier: "nadia@gmail.com" },
        { source: "gmail", sourceIdentifier: "nadia@acmecorp.com" },
      ]),
    ).toEqual(["acmecorp.com"]);
  });

  it("returns an empty array for an empty contact list", () => {
    expect(inferCompanyDomains([])).toEqual([]);
  });
});
