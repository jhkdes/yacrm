import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db/client";
import { oauthAccount } from "@/db/schema";

export async function GET() {
  const accounts = await db
    .select({
      emailAddress: oauthAccount.emailAddress,
      expiresAt: oauthAccount.expiresAt,
      hasRefreshToken: oauthAccount.refreshToken,
    })
    .from(oauthAccount)
    .where(eq(oauthAccount.provider, "gmail"));

  return NextResponse.json({
    accounts: accounts.map((account) => ({
      emailAddress: account.emailAddress,
      expiresAt: account.expiresAt,
      hasRefreshToken: account.hasRefreshToken !== null,
    })),
  });
}
