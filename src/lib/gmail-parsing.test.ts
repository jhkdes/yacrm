import { describe, expect, it } from "vitest";

import {
  extractPlainTextBody,
  getHeader,
  isRateLimitError,
  parseFirstAddress,
  toGmailDateQuery,
} from "./gmail-parsing";

describe("parseFirstAddress", () => {
  it("parses a display name with angle brackets", () => {
    expect(parseFirstAddress("Ada Lovelace <ada@example.com>")).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
  });

  it("parses a bare email address", () => {
    expect(parseFirstAddress("ada@example.com")).toEqual({
      name: null,
      email: "ada@example.com",
    });
  });

  it("handles a display name containing a comma (Last, First)", () => {
    expect(
      parseFirstAddress('"Smith, John" <john.smith@example.com>'),
    ).toEqual({
      name: "Smith, John",
      email: "john.smith@example.com",
    });
  });

  it("returns null for hidden/undisclosed recipients", () => {
    expect(parseFirstAddress("undisclosed-recipients:;")).toBeNull();
  });

  it("returns null for a missing header", () => {
    expect(parseFirstAddress(undefined)).toBeNull();
  });

  it("takes only the first address from a multi-recipient header with names", () => {
    expect(
      parseFirstAddress(
        '"Smith, John" <john@x.com>, "Doe, Jane" <jane@y.com>',
      ),
    ).toEqual({ name: "Smith, John", email: "john@x.com" });
  });

  it("takes only the first address from a multi-recipient bare header", () => {
    expect(parseFirstAddress("john@x.com, jane@y.com")).toEqual({
      name: null,
      email: "john@x.com",
    });
  });

  it("lowercases the parsed email", () => {
    expect(parseFirstAddress("Ada <ADA@Example.COM>")?.email).toBe(
      "ada@example.com",
    );
  });
});

describe("toGmailDateQuery", () => {
  it("converts a YYYY-MM-DD date into Gmail's after: search syntax", () => {
    expect(toGmailDateQuery("2026-01-15")).toBe("after:2026/01/15");
  });
});

describe("isRateLimitError", () => {
  it("recognizes an HTTP 429 status", () => {
    expect(isRateLimitError({ response: { status: 429 } })).toBe(true);
  });

  it("recognizes a quota-exceeded message", () => {
    expect(new Error("Quota exceeded for quota metric")).toSatisfy(
      (err: Error) => isRateLimitError(err),
    );
  });

  it("returns false for an unrelated error", () => {
    expect(isRateLimitError(new Error("Not found"))).toBe(false);
  });
});

describe("extractPlainTextBody", () => {
  it("decodes a base64url-encoded text/plain part", () => {
    const text = "Hello, world!";
    const encoded = Buffer.from(text, "utf-8").toString("base64url");
    expect(
      extractPlainTextBody({
        mimeType: "text/plain",
        body: { data: encoded },
      }),
    ).toBe(text);
  });

  it("recurses into multipart messages to find text/plain", () => {
    const text = "Nested body";
    const encoded = Buffer.from(text, "utf-8").toString("base64url");
    expect(
      extractPlainTextBody({
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: "aWdub3JlZA" } },
          { mimeType: "text/plain", body: { data: encoded } },
        ],
      }),
    ).toBe(text);
  });

  it("returns null when there is no text/plain part", () => {
    expect(
      extractPlainTextBody({
        mimeType: "text/html",
        body: { data: "aGVsbG8" },
      }),
    ).toBeNull();
  });
});

describe("getHeader", () => {
  it("finds a header case-insensitively", () => {
    const message = {
      payload: { headers: [{ name: "Subject", value: "Hello" }] },
    };
    expect(getHeader(message, "subject")).toBe("Hello");
  });

  it("returns undefined when the header is missing", () => {
    const message = { payload: { headers: [] } };
    expect(getHeader(message, "Subject")).toBeUndefined();
  });
});
