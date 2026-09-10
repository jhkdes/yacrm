import { describe, expect, it } from "vitest";

import { normalizeCompanyName } from "@/lib/company-normalization";

describe("normalizeCompanyName", () => {
  it.each([
    ["Qlik, Inc.", "Qlik"],
    ["Qlik Inc", "Qlik"],
    ["QLIK INC.", "QLIK"],
    ["Stripe, LLC", "Stripe"],
    ["Acme Corp.", "Acme"],
    ["Acme Corp", "Acme"],
    ["Acme Corporation", "Acme"],
    ["Widgets Co.", "Widgets"],
    ["Widgets Company", "Widgets"],
    ["Globex Ltd.", "Globex"],
    ["Globex Limited", "Globex"],
    ["Muster GmbH", "Muster"],
    ["Beispiel AG", "Beispiel"],
    ["Exemple S.A.", "Exemple"],
    ["Voorbeeld B.V.", "Voorbeeld"],
    ["Example PLC", "Example"],
    ["Partners LLP", "Partners"],
    ["Ventures LP", "Ventures"],
    ["Something Pty Ltd", "Something"],
    ["Something Pte Ltd", "Something"],
  ])("strips the legal suffix from %s -> %s", (raw, expected) => {
    expect(normalizeCompanyName(raw)).toBe(expected);
  });

  it("does not merge Amazon and AWS", () => {
    expect(normalizeCompanyName("Amazon")).not.toBe(normalizeCompanyName("AWS"));
  });

  it("collapses internal whitespace", () => {
    expect(normalizeCompanyName("Acme   Corp")).toBe("Acme");
    expect(normalizeCompanyName("  Acme  ")).toBe("Acme");
  });

  it("returns an empty string for empty/whitespace-only input", () => {
    expect(normalizeCompanyName("")).toBe("");
    expect(normalizeCompanyName("   ")).toBe("");
  });

  it("leaves a name with no suffix unchanged", () => {
    expect(normalizeCompanyName("Qlik")).toBe("Qlik");
    expect(normalizeCompanyName("Salesforce")).toBe("Salesforce");
  });

  it("does not strip a suffix-looking word that isn't trailing", () => {
    expect(normalizeCompanyName("Corp Communications")).toBe("Corp Communications");
  });

  it("preserves casing", () => {
    expect(normalizeCompanyName("qlik inc.")).toBe("qlik");
  });
});
