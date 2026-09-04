import { gmail_v1 } from "googleapis";

export interface ParsedAddress {
  name: string | null;
  email: string;
}

export function getHeader(
  message: gmail_v1.Schema$Message,
  name: string,
): string | undefined {
  return (
    message.payload?.headers?.find(
      (header) => header.name?.toLowerCase() === name.toLowerCase(),
    )?.value ?? undefined
  );
}

// Parses "Ada Lovelace <ada@example.com>" or a bare "ada@example.com" from
// the *start* of a header that may contain multiple comma-separated
// addresses. Only the first address is used — good enough for raw/unfiltered
// import. Deliberately does not split the header on "," first: a quoted
// display name can itself contain a comma (e.g. `"Smith, John"
// <john@example.com>`), which would misparse as two garbage fragments.
export function parseFirstAddress(
  headerValue: string | undefined,
): ParsedAddress | null {
  if (!headerValue) return null;

  const angleMatch = headerValue.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
  if (angleMatch) {
    const name = angleMatch[1].trim();
    const email = angleMatch[2].trim().toLowerCase();
    return { name: name || null, email };
  }

  const bareMatch = headerValue.match(/[^\s,<>]+@[^\s,<>]+/);
  if (bareMatch) {
    return { name: null, email: bareMatch[0].trim().toLowerCase() };
  }

  return null;
}

export function extractPlainTextBody(
  part: gmail_v1.Schema$MessagePart | undefined,
): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf-8");
  }
  if (part.parts) {
    for (const child of part.parts) {
      const found = extractPlainTextBody(child);
      if (found) return found;
    }
  }
  return null;
}

export function toGmailDateQuery(startDate: string): string {
  // Gmail search syntax wants YYYY/MM/DD.
  return `after:${startDate.replaceAll("-", "/")}`;
}

export function isRateLimitError(err: unknown): boolean {
  const status =
    (err as { code?: number; response?: { status?: number } })?.code ??
    (err as { response?: { status?: number } })?.response?.status;
  const message = err instanceof Error ? err.message : String(err);
  return (
    status === 429 ||
    message.includes("Quota exceeded") ||
    message.includes("rateLimitExceeded") ||
    message.includes("userRateLimitExceeded")
  );
}
