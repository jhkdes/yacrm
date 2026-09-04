import { NextResponse } from "next/server";

import { GMAIL_SCOPES, createOAuthClient } from "@/lib/google";

export async function GET() {
  const oauthClient = createOAuthClient();

  const url = oauthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES,
  });

  return NextResponse.redirect(url);
}
