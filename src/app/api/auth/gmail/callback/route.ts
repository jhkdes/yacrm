import { google } from "googleapis";
import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { oauthAccount } from "@/db/schema";
import { createOAuthClient } from "@/lib/google";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
      new URL(`/?gmail_error=${encodeURIComponent(error)}`, request.url),
    );
  }
  if (!code) {
    return NextResponse.redirect(
      new URL("/?gmail_error=missing_code", request.url),
    );
  }

  const oauthClient = createOAuthClient();
  const { tokens } = await oauthClient.getToken(code);
  oauthClient.setCredentials(tokens);

  if (!tokens.access_token || !tokens.expiry_date) {
    return NextResponse.redirect(
      new URL("/?gmail_error=incomplete_token_response", request.url),
    );
  }

  const oauth2 = google.oauth2({ auth: oauthClient, version: "v2" });
  const { data: userInfo } = await oauth2.userinfo.get();

  if (!userInfo.email) {
    return NextResponse.redirect(
      new URL("/?gmail_error=missing_email", request.url),
    );
  }

  await db
    .insert(oauthAccount)
    .values({
      provider: "gmail",
      emailAddress: userInfo.email,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: new Date(tokens.expiry_date),
    })
    .onConflictDoUpdate({
      target: [oauthAccount.provider, oauthAccount.emailAddress],
      set: {
        accessToken: tokens.access_token,
        // Google only sends a refresh_token on the first consent; keep the
        // existing one on subsequent reconnects unless a new one arrives.
        ...(tokens.refresh_token
          ? { refreshToken: tokens.refresh_token }
          : {}),
        expiresAt: new Date(tokens.expiry_date),
        updatedAt: new Date(),
      },
    });

  return NextResponse.redirect(
    new URL(`/?gmail_connected=${encodeURIComponent(userInfo.email)}`, request.url),
  );
}
