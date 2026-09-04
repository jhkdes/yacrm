import { NextResponse } from "next/server";

import { pglite } from "@/db/client";

export async function GET() {
  const result = await pglite.query<{ ok: number }>("SELECT 1 AS ok");
  const row = result.rows[0];

  return NextResponse.json({
    status: "ok",
    db: row?.ok === 1 ? "connected" : "unexpected_result",
  });
}
