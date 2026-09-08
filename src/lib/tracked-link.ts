// Centralizes tracked-link URL construction so the two places that need it
// to match byte-for-byte — campaigns.ts (substitutes it into a draft when
// the draft is created) and campaign-send.ts (finds that same substring in
// the already-drafted body to wrap as a clickable <a> at send time) —
// can't silently drift apart and break the wrap-detection.

export function requireRedirectBaseUrl(): string {
  const base = process.env.REDIRECT_BASE_URL;
  if (!base) {
    throw new Error(
      "REDIRECT_BASE_URL must be set — without it, a tracked link baked into a draft would point somewhere a real recipient can't reach.",
    );
  }
  return base.replace(/\/+$/, "");
}

export function buildTrackedLinkUrl(token: string): string {
  return `${requireRedirectBaseUrl()}/${token}`;
}

export function buildTrackingPixelUrl(token: string): string {
  return `${requireRedirectBaseUrl()}/pixel/${token}`;
}
