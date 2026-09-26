import { J as mapResultRow, Kt as entityKind, Ot as sql, _t as fillPlaceholders, c as extractTablesRelationalConfig, s as createTableRelationsHelpers } from "./relations-DcOpytzY.js";
import { n as DefaultLogger, r as NoopLogger } from "./logger-BHLgLV8A.js";
import { D as SQLiteAsyncDialect, c as SQLitePreparedQuery, f as NoopCache, l as SQLiteSession, p as BaseSQLiteDatabase, u as SQLiteTransaction } from "./sqlite-core-LZ_U9UyW.js";
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/drizzle-orm@0.45.2_@cloudflare+workers-types@5.20260713.1_kysely@0.29.3/node_modules/drizzle-orm/d1/session.js
var SQLiteD1Session = class extends SQLiteSession {
	constructor(client, dialect, schema, options = {}) {
		super(dialect);
		this.client = client;
		this.schema = schema;
		this.options = options;
		this.logger = options.logger ?? new NoopLogger();
		this.cache = options.cache ?? new NoopCache();
	}
	static [entityKind] = "SQLiteD1Session";
	logger;
	cache;
	prepareQuery(query, fields, executeMethod, isResponseInArrayMode, customResultMapper, queryMetadata, cacheConfig) {
		return new D1PreparedQuery(this.client.prepare(query.sql), query, this.logger, this.cache, queryMetadata, cacheConfig, fields, executeMethod, isResponseInArrayMode, customResultMapper);
	}
	async batch(queries) {
		const preparedQueries = [];
		const builtQueries = [];
		for (const query of queries) {
			const preparedQuery = query._prepare();
			const builtQuery = preparedQuery.getQuery();
			preparedQueries.push(preparedQuery);
			if (builtQuery.params.length > 0) builtQueries.push(preparedQuery.stmt.bind(...builtQuery.params));
			else {
				const builtQuery2 = preparedQuery.getQuery();
				builtQueries.push(this.client.prepare(builtQuery2.sql).bind(...builtQuery2.params));
			}
		}
		return (await this.client.batch(builtQueries)).map((result, i) => preparedQueries[i].mapResult(result, true));
	}
	extractRawAllValueFromBatchResult(result) {
		return result.results;
	}
	extractRawGetValueFromBatchResult(result) {
		return result.results[0];
	}
	extractRawValuesValueFromBatchResult(result) {
		return d1ToRawMapping(result.results);
	}
	async transaction(transaction, config) {
		const tx = new D1Transaction("async", this.dialect, this, this.schema);
		await this.run(sql.raw(`begin${config?.behavior ? " " + config.behavior : ""}`));
		try {
			const result = await transaction(tx);
			await this.run(sql`commit`);
			return result;
		} catch (err) {
			await this.run(sql`rollback`);
			throw err;
		}
	}
};
var D1Transaction = class D1Transaction extends SQLiteTransaction {
	static [entityKind] = "D1Transaction";
	async transaction(transaction) {
		const savepointName = `sp${this.nestedIndex}`;
		const tx = new D1Transaction("async", this.dialect, this.session, this.schema, this.nestedIndex + 1);
		await this.session.run(sql.raw(`savepoint ${savepointName}`));
		try {
			const result = await transaction(tx);
			await this.session.run(sql.raw(`release savepoint ${savepointName}`));
			return result;
		} catch (err) {
			await this.session.run(sql.raw(`rollback to savepoint ${savepointName}`));
			throw err;
		}
	}
};
function d1ToRawMapping(results) {
	const rows = [];
	for (const row of results) {
		const entry = Object.keys(row).map((k) => row[k]);
		rows.push(entry);
	}
	return rows;
}
var D1PreparedQuery = class extends SQLitePreparedQuery {
	constructor(stmt, query, logger, cache, queryMetadata, cacheConfig, fields, executeMethod, _isResponseInArrayMode, customResultMapper) {
		super("async", executeMethod, query, cache, queryMetadata, cacheConfig);
		this.logger = logger;
		this._isResponseInArrayMode = _isResponseInArrayMode;
		this.customResultMapper = customResultMapper;
		this.fields = fields;
		this.stmt = stmt;
	}
	static [entityKind] = "D1PreparedQuery";
	/** @internal */
	customResultMapper;
	/** @internal */
	fields;
	/** @internal */
	stmt;
	async run(placeholderValues) {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		return await this.queryWithCache(this.query.sql, params, async () => {
			return this.stmt.bind(...params).run();
		});
	}
	async all(placeholderValues) {
		const { fields, query, logger, stmt, customResultMapper } = this;
		if (!fields && !customResultMapper) {
			const params = fillPlaceholders(query.params, placeholderValues ?? {});
			logger.logQuery(query.sql, params);
			return await this.queryWithCache(query.sql, params, async () => {
				return stmt.bind(...params).all().then(({ results }) => this.mapAllResult(results));
			});
		}
		const rows = await this.values(placeholderValues);
		return this.mapAllResult(rows);
	}
	mapAllResult(rows, isFromBatch) {
		if (isFromBatch) rows = d1ToRawMapping(rows.results);
		if (!this.fields && !this.customResultMapper) return rows;
		if (this.customResultMapper) return this.customResultMapper(rows);
		return rows.map((row) => mapResultRow(this.fields, row, this.joinsNotNullableMap));
	}
	async get(placeholderValues) {
		const { fields, joinsNotNullableMap, query, logger, stmt, customResultMapper } = this;
		if (!fields && !customResultMapper) {
			const params = fillPlaceholders(query.params, placeholderValues ?? {});
			logger.logQuery(query.sql, params);
			return await this.queryWithCache(query.sql, params, async () => {
				return stmt.bind(...params).all().then(({ results }) => results[0]);
			});
		}
		const rows = await this.values(placeholderValues);
		if (!rows[0]) return;
		if (customResultMapper) return customResultMapper(rows);
		return mapResultRow(fields, rows[0], joinsNotNullableMap);
	}
	mapGetResult(result, isFromBatch) {
		if (isFromBatch) result = d1ToRawMapping(result.results)[0];
		if (!this.fields && !this.customResultMapper) return result;
		if (this.customResultMapper) return this.customResultMapper([result]);
		return mapResultRow(this.fields, result, this.joinsNotNullableMap);
	}
	async values(placeholderValues) {
		const params = fillPlaceholders(this.query.params, placeholderValues ?? {});
		this.logger.logQuery(this.query.sql, params);
		return await this.queryWithCache(this.query.sql, params, async () => {
			return this.stmt.bind(...params).raw();
		});
	}
	/** @internal */
	isResponseInArrayMode() {
		return this._isResponseInArrayMode;
	}
};
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/drizzle-orm@0.45.2_@cloudflare+workers-types@5.20260713.1_kysely@0.29.3/node_modules/drizzle-orm/d1/driver.js
var DrizzleD1Database = class extends BaseSQLiteDatabase {
	static [entityKind] = "D1Database";
	async batch(batch) {
		return this.session.batch(batch);
	}
};
function drizzle(client, config = {}) {
	const dialect = new SQLiteAsyncDialect({ casing: config.casing });
	let logger;
	if (config.logger === true) logger = new DefaultLogger();
	else if (config.logger !== false) logger = config.logger;
	let schema;
	if (config.schema) {
		const tablesConfig = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
		schema = {
			fullSchema: config.schema,
			schema: tablesConfig.tables,
			tableNamesMap: tablesConfig.tableNamesMap
		};
	}
	const db = new DrizzleD1Database("async", dialect, new SQLiteD1Session(client, dialect, schema, {
		logger,
		cache: config.cache
	}), schema);
	db.$client = client;
	db.$cache = config.cache;
	if (db.$cache) db.$cache["invalidate"] = config.cache?.onMutate;
	return db;
}
//#endregion
export { D1PreparedQuery, D1Transaction, DrizzleD1Database, SQLiteD1Session, drizzle };
