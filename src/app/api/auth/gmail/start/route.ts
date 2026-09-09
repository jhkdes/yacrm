import { NextResponse } from "next/server";

import { GOOGLE_SCOPES, createOAuthClient } from "@/lib/google";

export async function GET() {
  const oauthClient = createOAuthClient();

  const url = oauthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
  });

  return NextResponse.redirect(url);
}
