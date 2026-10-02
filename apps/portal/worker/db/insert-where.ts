import { getTableColumns, sql, SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Database } from "./client";

/**
 * `INSERT INTO table SELECT <row> WHERE <condition>`: one row, written only if
 * the condition holds when the statement runs. Inside a D1 batch this is how a
 * later statement depends on an earlier one without a read in between.
 *
 * Drizzle's INSERT ... SELECT lists every column in declaration order, so the
 * row supplies each one; an omitted column takes its declared default, encoded
 * by that column like any other value.
 */
export function insertWhere<TTable extends SQLiteTable>(
  db: Database,
  table: TTable,
  row: TTable["$inferInsert"],
  condition: SQL,
) {
  const supplied = row as Record<string, unknown>;
  const values = sql.join(
    Object.entries(getTableColumns(table)).map(([key, column]) => {
      const value = supplied[key] === undefined ? column.default ?? null : supplied[key];
      return value instanceof SQL ? value : sql.param(value, column);
    }),
    sql`, `,
  );
  return db.insert(table).select(sql`select ${values} where ${condition}`);
}
