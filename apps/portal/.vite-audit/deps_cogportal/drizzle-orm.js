import { $ as DrizzleError, A as like, At as Columns, B as or, Bt as ViewBaseConfig, C as exists, Ct as noopDecoder, D as inArray, Dt as placeholder, E as ilike, Et as param, F as notBetween, Ft as Schema, G as getViewSelectedFields, Gt as Column, H as getColumnNameAndConfig, Ht as WithSubquery, I as notExists, It as Table, J as mapResultRow, Jt as is, K as haveSameKeys, Kt as entityKind, L as notIlike, Lt as getTableName, M as lte, Mt as ExtraConfigColumns, N as ne, Nt as IsAlias, O as isNotNull, Ot as sql, P as not, Pt as OriginalName, Q as QueryPromise, R as notInArray, Rt as getTableUniqueName, S as eq, St as name, T as gte, Tt as noopMapper, U as getTableColumns, V as applyMixins, Vt as Subquery, W as getTableLikeName, Wt as ColumnBuilder, X as orderSelectedFields, Y as mapUpdateSet, Z as textDecoder, _ as arrayContained, _t as fillPlaceholders, a as createMany, at as aliasedRelation, b as between, bt as isSQLWrapper, c as extractTablesRelationalConfig, ct as mapColumnsInAliasedSQLToAlias, d as mapRelationalRow, dt as Name, et as DrizzleQueryError, f as normalizeRelation, ft as Param, g as and, gt as View, h as desc, ht as StringChunk, i as Relations, it as TableAliasProxyHandler, j as lt, jt as ExtraConfigBuilder, k as isNull, kt as BaseName, l as getOperators, lt as mapColumnsInSQLToAlias, m as asc, mt as SQL, n as One, nt as ColumnAliasProxyHandler, o as createOne, ot as aliasedTable, p as relations, pt as Placeholder, q as isConfig, qt as hasOwnEntityKind, r as Relation, rt as RelationTableAliasProxyHandler, s as createTableRelationsHelpers, st as aliasedTableColumn, t as Many, tt as TransactionRollbackError, u as getOrderByOperators, ut as FakePrimitiveParam, v as arrayContains, vt as getViewName, w as gt, wt as noopEncoder, x as bindIfParam, xt as isView, y as arrayOverlaps, yt as isDriverValueEncoder, z as notLike, zt as isTable } from "./relations-DcOpytzY.js";
import { n as DefaultLogger, r as NoopLogger, t as ConsoleLogWriter } from "./logger-BHLgLV8A.js";
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/drizzle-orm@0.45.2_@cloudflare+workers-types@5.20260713.1_kysely@0.29.3/node_modules/drizzle-orm/sql/functions/aggregate.js
function count(expression) {
	return sql`count(${expression || sql.raw("*")})`.mapWith(Number);
}
function countDistinct(expression) {
	return sql`count(distinct ${expression})`.mapWith(Number);
}
function avg(expression) {
	return sql`avg(${expression})`.mapWith(String);
}
function avgDistinct(expression) {
	return sql`avg(distinct ${expression})`.mapWith(String);
}
function sum(expression) {
	return sql`sum(${expression})`.mapWith(String);
}
function sumDistinct(expression) {
	return sql`sum(distinct ${expression})`.mapWith(String);
}
function max(expression) {
	return sql`max(${expression})`.mapWith(is(expression, Column) ? expression : String);
}
function min(expression) {
	return sql`min(${expression})`.mapWith(is(expression, Column) ? expression : String);
}
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/drizzle-orm@0.45.2_@cloudflare+workers-types@5.20260713.1_kysely@0.29.3/node_modules/drizzle-orm/sql/functions/vector.js
function toSql(value) {
	return JSON.stringify(value);
}
function l2Distance(column, value) {
	if (Array.isArray(value)) return sql`${column} <-> ${toSql(value)}`;
	return sql`${column} <-> ${value}`;
}
function l1Distance(column, value) {
	if (Array.isArray(value)) return sql`${column} <+> ${toSql(value)}`;
	return sql`${column} <+> ${value}`;
}
function innerProduct(column, value) {
	if (Array.isArray(value)) return sql`${column} <#> ${toSql(value)}`;
	return sql`${column} <#> ${value}`;
}
function cosineDistance(column, value) {
	if (Array.isArray(value)) return sql`${column} <=> ${toSql(value)}`;
	return sql`${column} <=> ${value}`;
}
function hammingDistance(column, value) {
	if (Array.isArray(value)) return sql`${column} <~> ${toSql(value)}`;
	return sql`${column} <~> ${value}`;
}
function jaccardDistance(column, value) {
	if (Array.isArray(value)) return sql`${column} <%> ${toSql(value)}`;
	return sql`${column} <%> ${value}`;
}
//#endregion
export { BaseName, Column, ColumnAliasProxyHandler, ColumnBuilder, Columns, ConsoleLogWriter, DefaultLogger, DrizzleError, DrizzleQueryError, ExtraConfigBuilder, ExtraConfigColumns, FakePrimitiveParam, IsAlias, Many, Name, NoopLogger, One, OriginalName, Param, Placeholder, QueryPromise, Relation, RelationTableAliasProxyHandler, Relations, SQL, Schema, StringChunk, Subquery, Table, TableAliasProxyHandler, TransactionRollbackError, View, ViewBaseConfig, WithSubquery, aliasedRelation, aliasedTable, aliasedTableColumn, and, applyMixins, arrayContained, arrayContains, arrayOverlaps, asc, avg, avgDistinct, between, bindIfParam, cosineDistance, count, countDistinct, createMany, createOne, createTableRelationsHelpers, desc, entityKind, eq, exists, extractTablesRelationalConfig, fillPlaceholders, getColumnNameAndConfig, getOperators, getOrderByOperators, getTableColumns, getTableLikeName, getTableName, getTableUniqueName, getViewName, getViewSelectedFields, gt, gte, hammingDistance, hasOwnEntityKind, haveSameKeys, ilike, inArray, innerProduct, is, isConfig, isDriverValueEncoder, isNotNull, isNull, isSQLWrapper, isTable, isView, jaccardDistance, l1Distance, l2Distance, like, lt, lte, mapColumnsInAliasedSQLToAlias, mapColumnsInSQLToAlias, mapRelationalRow, mapResultRow, mapUpdateSet, max, min, name, ne, noopDecoder, noopEncoder, noopMapper, normalizeRelation, not, notBetween, notExists, notIlike, notInArray, notLike, or, orderSelectedFields, param, placeholder, relations, sql, sum, sumDistinct, textDecoder };
