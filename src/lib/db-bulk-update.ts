import { sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/types";

// Drizzle has no native "different value per row" bulk update — this
// builds `UPDATE <table> AS t SET ... FROM (VALUES ...) AS v(...) WHERE
// t.<key> = v.<key>` via the sql tag, turning what would otherwise be N
// sequential per-row UPDATE round-trips into one. Extracted once so
// title-extraction.ts, linkedin-import.ts, and future callers don't each
// hand-build VALUES-list SQL. See docs/technical-design-and-milestones.md
// (M29) for the real-world timing this was added to fix: a batch's
// sequential writes were the dominant cost of a large import, not LLM
// latency or any single request's timeout.
//
// Every current caller targets `person`, which always has `updated_at` —
// hardcoding `updated_at = now()` into the SET clause keeps the option
// surface small rather than adding a flag nothing yet needs.
export interface BulkUpdateColumn {
  column: string; // unquoted snake_case column name
  sqlType: string; // Postgres cast type, e.g. "text", "integer", "person_seniority"
}

export interface BulkUpdateOptions {
  table: string; // unquoted table name, e.g. "person"
  keyColumn: string; // unquoted, e.g. "id" or "normalized_company_name"
  keyType: string; // cast type for the key, e.g. "integer" or "text"
  setColumns: BulkUpdateColumn[];
  rows: Record<string, unknown>[]; // each row keyed by keyColumn + every setColumns[].column
  // Raw SQL fragment ANDed into the WHERE clause, e.g. `t."industry" IS
  // NULL` — must qualify any column with `t.` (the target table's alias),
  // since an unqualified column name that also appears in the VALUES list
  // v(...) is ambiguous to Postgres between the two. Used by the industry
  // backfill to only touch rows still unset.
  extraWhere?: string;
}

function quoteIdent(name: string): string {
  return `"${name}"`;
}

export async function bulkUpdateByKey(db: DrizzleDb, opts: BulkUpdateOptions): Promise<void> {
  const { table, keyColumn, keyType, setColumns, rows, extraWhere } = opts;
  if (rows.length === 0) return;

  const valueTuples = rows.map((row) => {
    const castValues = [
      sql`${row[keyColumn]}::${sql.raw(keyType)}`,
      ...setColumns.map((c) => sql`${row[c.column]}::${sql.raw(c.sqlType)}`),
    ];
    return sql`(${sql.join(castValues, sql`, `)})`;
  });

  const valuesColumnList = [keyColumn, ...setColumns.map((c) => c.column)]
    .map(quoteIdent)
    .join(", ");

  const setClause = sql.join(
    setColumns.map((c) => sql.raw(`${quoteIdent(c.column)} = v.${quoteIdent(c.column)}`)),
    sql`, `,
  );

  const keyJoin = `t.${quoteIdent(keyColumn)} = v.${quoteIdent(keyColumn)}`;
  const whereClause = extraWhere ? `${keyJoin} AND ${extraWhere}` : keyJoin;

  await db.execute(sql`
    UPDATE ${sql.raw(quoteIdent(table))} AS t
    SET ${setClause}, updated_at = now()
    FROM (VALUES ${sql.join(valueTuples, sql`, `)}) AS v(${sql.raw(valuesColumnList)})
    WHERE ${sql.raw(whereClause)}
  `);
}
