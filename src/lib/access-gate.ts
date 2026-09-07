// A minimal password gate for the whole app, independent of Vercel's own
// Deployment Protection — needed because Vercel Authentication on the free
// Hobby plan explicitly excludes production custom domains from
// protection (confirmed directly against the live deployment: the
// per-deployment URL was gated, the production alias was not). This app
// holds live Gmail access and can trigger real sends, so it can't be left
// reachable with no auth at all while on a domain Vercel's own protection
// won't cover.
//
// Deliberately simple for a single-user tool: one shared password (
// APP_PASSWORD), not a real multi-user auth system. Uses Web Crypto
// (available in both the Node and Edge runtimes) rather than node:crypto,
// so the same function works from middleware.ts (which may run on the Edge
// runtime) and from a Server Action.
export const ACCESS_GATE_COOKIE_NAME = "yacrm_auth";

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The cookie never stores the raw password — just a fixed token derived
// from it, so a leaked cookie doesn't directly reveal the password.
export async function computeAccessToken(password: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(password),
  );
  return toHex(digest);
}

// Fails closed: with no APP_PASSWORD configured, this returns null and
// every request gets locked out (including the owner) rather than the gate
// silently passing everyone through because there was nothing to compare
// against.
export async function expectedAccessToken(): Promise<string | null> {
  const password = process.env.APP_PASSWORD;
  if (!password) return null;
  return computeAccessToken(password);
}
