import { google } from "googleapis";

// Renamed from GMAIL_SCOPES (M24) — one Google OAuth connection now covers
// both Gmail and Calendar access, so "Gmail scopes" stopped being accurate.
// An account connected before calendar.readonly was added must reconnect
// via "Reconnect Gmail" on the homepage to grant it; the old access/refresh
// token won't cover it, and the calendar import will fail with a scope
// error until then.
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  // Required to send approved drafts (M14) — an account connected before
  // this scope was added must reconnect via "Reconnect Gmail" to grant it;
  // the old access/refresh token won't cover gmail.send.
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  // M24: read-only calendar access, for meeting import.
  "https://www.googleapis.com/auth/calendar.readonly",
];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.local.example.`,
    );
  }
  return value;
}

export function createOAuthClient() {
  return new google.auth.OAuth2(
    requiredEnv("GOOGLE_CLIENT_ID"),
    requiredEnv("GOOGLE_CLIENT_SECRET"),
    requiredEnv("GOOGLE_REDIRECT_URI"),
  );
}
