import { describe, expect, it } from "vitest";

import { namesAreNicknameEquivalent } from "@/lib/nickname-equivalence";

describe("namesAreNicknameEquivalent", () => {
  it.each([
    ["rob", "robert"],
    ["bob", "robert"],
    ["nick", "nicholas"],
    ["bill", "william"],
    ["liam", "william"],
    ["mike", "michael"],
    ["liz", "elizabeth"],
    ["kate", "katherine"],
  ])("treats %s and %s as equivalent", (a, b) => {
    expect(namesAreNicknameEquivalent(a, b)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(namesAreNicknameEquivalent("Rob", "ROBERT")).toBe(true);
  });

  it("does not match unrelated names", () => {
    expect(namesAreNicknameEquivalent("rob", "ron")).toBe(false);
    expect(namesAreNicknameEquivalent("nick", "mike")).toBe(false);
  });

  it("does not match a name against itself as a false positive when it's not in any group", () => {
    expect(namesAreNicknameEquivalent("xyzabc", "xyzabc")).toBe(false);
  });

  it("does not cross-match names from different groups that happen to share a nickname collision risk (ted/theodore vs ted/edward)", () => {
    // "ted" only maps to the theodore group in this table — edward's group
    // deliberately excludes it to avoid an ambiguous double-mapping.
    expect(namesAreNicknameEquivalent("ted", "theodore")).toBe(true);
    expect(namesAreNicknameEquivalent("ted", "edward")).toBe(false);
  });
});
