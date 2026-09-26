import { Bt as boolean, Fn as object, Jt as date, Pn as number, a as string$1, qn as string } from "./zod-DJgnLRfl.js";
import { $ as JWKSNoMatchingKey, A as findInvalidTrustedProxies, B as isPromise, C as resolveDynamicTrustedProxyHeaders, D as createInternalAdapter, E as defu, F as parseState, G as decodeProtectedHeader, H as createHash, I as generateGenericState, J as JWTClaimsBuilder, K as createLocalJWKSet, L as parseGenericState, N as HIDE_METADATA, P as generateState, Q as JWKSMultipleMatchingKeys, R as createCookieGetter, S as getTrustedProviders, T as runPluginInit, U as base64, V as hasServerSessionStore, W as base64Url, X as JOSEError, Y as validateClaimsSet, Z as JWKSInvalid, _ as generateCodeChallenge, _t as resolveDynamicBaseURL, a as socialProviders, at as encode, b as getInternalPlugins, bt as defineErrorCodes, c as validateAuthorizationCode, ct as getHost, d as refreshAccessToken, dt as getProtocol, et as JWKSTimeout, f as refreshAccessTokenRequest, ft as getProtocolFromSource, g as applyDefaultAccessTokenExpiry, gt as resolveBaseURL, h as createAuthorizationURL, ht as matchesHostPattern, i as checkPassword, it as decode, j as matchesOriginPattern, l as validateToken, lt as getHostFromSource, m as betterFetch, mt as isRequestLike, n as getEndpoints, nt as JWTExpired, o as authorizationCodeRequest, ot as decoder, p as fetchRefusingRedirects, pt as isDynamicBaseURLConfig, q as jwtVerify, r as router, rt as JWTInvalid, s as createAuthorizationCodeRequest, st as getBaseURL, t as checkEndpointConflicts, tt as JWSSignatureVerificationFailed, u as createRefreshAccessTokenRequest, ut as getOrigin, v as getOAuth2Tokens, vt as trimTrailingSlashes, w as resolveRequestContext, x as getTrustedOrigins, y as getPrimaryClientId, yt as BASE_ERROR_CODES, z as getCookies } from "./api-B6O-7oy9.js";
import { A as isProduction, C as shouldPublishLog, D as getBooleanEnvVar, E as env, F as APIError$1, M as nodeENV, N as APIError, O as getEnvVar, P as BetterAuthError, S as logger, T as ENV, _ as generateId, b as createLogger, c as getCurrentAdapter, g as initGetFieldName, h as initGetModelName, j as isTest, k as isDevelopment, m as getBetterAuthVersion, o as safeJSONParse, s as getAuthTables, u as runWithAdapter, v as createRandomStringGenerator, w as getColorDepth, x as levels, y as TTY_COLORS } from "./factory-CQ5NbRks.js";
import { n as getKyselyDatabaseType, t as createKyselyAdapter } from "./dist-BSPS3xCN.js";
import { n as sql } from "./compiled-query-BL-MS9JB.js";
import { randomBytes, scrypt } from "node:crypto";
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/jose@6.2.3/node_modules/jose/dist/webapi/jwt/unsecured.js
var UnsecuredJWT = class {
	#jwt;
	constructor(payload = {}) {
		this.#jwt = new JWTClaimsBuilder(payload);
	}
	encode() {
		return `${encode(JSON.stringify({ alg: "none" }))}.${encode(this.#jwt.data())}.`;
	}
	setIssuer(issuer) {
		this.#jwt.iss = issuer;
		return this;
	}
	setSubject(subject) {
		this.#jwt.sub = subject;
		return this;
	}
	setAudience(audience) {
		this.#jwt.aud = audience;
		return this;
	}
	setJti(jwtId) {
		this.#jwt.jti = jwtId;
		return this;
	}
	setNotBefore(input) {
		this.#jwt.nbf = input;
		return this;
	}
	setExpirationTime(input) {
		this.#jwt.exp = input;
		return this;
	}
	setIssuedAt(input) {
		this.#jwt.iat = input;
		return this;
	}
	static decode(jwt, options) {
		if (typeof jwt !== "string") throw new JWTInvalid("Unsecured JWT must be a string");
		const { 0: encodedHeader, 1: encodedPayload, 2: signature, length } = jwt.split(".");
		if (length !== 3 || signature !== "") throw new JWTInvalid("Invalid Unsecured JWT");
		let header;
		try {
			header = JSON.parse(decoder.decode(decode(encodedHeader)));
			if (header.alg !== "none") throw new Error();
		} catch {
			throw new JWTInvalid("Invalid Unsecured JWT");
		}
		return {
			payload: validateClaimsSet(header, decode(encodedPayload), options),
			header
		};
	}
};
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/@better-auth+utils@0.4.2/node_modules/@better-auth/utils/dist/password.node.mjs
var config = {
	N: 16384,
	r: 16,
	p: 1,
	dkLen: 64
};
function generateKey(password, salt) {
	return new Promise((resolve, reject) => {
		scrypt(password.normalize("NFKC"), salt, config.dkLen, {
			N: config.N,
			r: config.r,
			p: config.p,
			maxmem: 128 * config.N * config.r * 2
		}, (err, key) => {
			if (err) reject(err);
			else resolve(key);
		});
	});
}
async function hashPassword(password) {
	const salt = randomBytes(16).toString("hex");
	return `${salt}:${(await generateKey(password, salt)).toString("hex")}`;
}
async function verifyPassword(hash, password) {
	const [salt, key] = hash.split(":");
	if (!salt || !key) throw new Error("Invalid password hash");
	return (await generateKey(password, salt)).toString("hex") === key;
}
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth@1.6.23_@cloudflare+workers-types@5.20260713.1_drizzle-kit@0.31.10_drizzle-o_30acf09c0f00c22f758df1843171fed3/node_modules/better-auth/dist/crypto/password.mjs
/**
* `@better-auth/utils/password` uses the "node" export condition in package.json
* to automatically pick the right implementation:
*   - Node.js / Bun / Deno → `node:crypto scrypt` (libuv thread pool, non-blocking)
*   - Unsupported runtimes → `@noble/hashes scrypt` (pure JS fallback)
*/
var hashPassword$1 = hashPassword;
var verifyPassword$1 = async ({ hash, password }) => {
	return verifyPassword(hash, password);
};
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/@better-auth+core@1.6.23_@better-auth+utils@0.4.2_@better-fetch+fetch@1.3.1_@cloudflare_9af17ac30fdf35bdd7823fbd3f2ce972/node_modules/@better-auth/core/dist/db/schema/shared.mjs
var coreSchema = object({
	id: string(),
	createdAt: date().default(() => /* @__PURE__ */ new Date()),
	updatedAt: date().default(() => /* @__PURE__ */ new Date())
});
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/@better-auth+core@1.6.23_@better-auth+utils@0.4.2_@better-fetch+fetch@1.3.1_@cloudflare_9af17ac30fdf35bdd7823fbd3f2ce972/node_modules/@better-auth/core/dist/db/schema/account.mjs
var accountSchema = coreSchema.extend({
	providerId: string(),
	accountId: string(),
	userId: string$1(),
	accessToken: string().nullish(),
	refreshToken: string().nullish(),
	idToken: string().nullish(),
	accessTokenExpiresAt: date().nullish(),
	refreshTokenExpiresAt: date().nullish(),
	scope: string().nullish(),
	password: string().nullish()
});
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/@better-auth+core@1.6.23_@better-auth+utils@0.4.2_@better-fetch+fetch@1.3.1_@cloudflare_9af17ac30fdf35bdd7823fbd3f2ce972/node_modules/@better-auth/core/dist/db/schema/rate-limit.mjs
var rateLimitSchema = object({
	key: string(),
	count: number(),
	lastRequest: number()
});
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/@better-auth+core@1.6.23_@better-auth+utils@0.4.2_@better-fetch+fetch@1.3.1_@cloudflare_9af17ac30fdf35bdd7823fbd3f2ce972/node_modules/@better-auth/core/dist/db/schema/session.mjs
var sessionSchema = coreSchema.extend({
	userId: string$1(),
	expiresAt: date(),
	token: string(),
	ipAddress: string().nullish(),
	userAgent: string().nullish()
});
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/@better-auth+core@1.6.23_@better-auth+utils@0.4.2_@better-fetch+fetch@1.3.1_@cloudflare_9af17ac30fdf35bdd7823fbd3f2ce972/node_modules/@better-auth/core/dist/db/schema/user.mjs
var userSchema = coreSchema.extend({
	email: string().transform((val) => val.toLowerCase()),
	emailVerified: boolean().default(false),
	name: string(),
	image: string().nullish()
});
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/@better-auth+core@1.6.23_@better-auth+utils@0.4.2_@better-fetch+fetch@1.3.1_@cloudflare_9af17ac30fdf35bdd7823fbd3f2ce972/node_modules/@better-auth/core/dist/db/schema/verification.mjs
var verificationSchema = coreSchema.extend({
	value: string(),
	expiresAt: date(),
	identifier: string()
});
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth@1.6.23_@cloudflare+workers-types@5.20260713.1_drizzle-kit@0.31.10_drizzle-o_30acf09c0f00c22f758df1843171fed3/node_modules/better-auth/dist/db/adapter-base.mjs
async function getBaseAdapter(options, handleDirectDatabase) {
	let adapter;
	if (!options.database) {
		const tables = getAuthTables(options);
		const memoryDB = Object.keys(tables).reduce((acc, key) => {
			acc[key] = [];
			return acc;
		}, {});
		const { memoryAdapter } = await import("./dist-DlL3nj7L.js");
		adapter = memoryAdapter(memoryDB)(options);
	} else if (typeof options.database === "function") adapter = options.database(options);
	else adapter = await handleDirectDatabase(options);
	if (!adapter.transaction) {
		logger.warn("Adapter does not correctly implement transaction function, patching it automatically. Please update your adapter implementation.");
		adapter.transaction = async (cb) => {
			return cb(adapter);
		};
	}
	return adapter;
}
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth@1.6.23_@cloudflare+workers-types@5.20260713.1_drizzle-kit@0.31.10_drizzle-o_30acf09c0f00c22f758df1843171fed3/node_modules/better-auth/dist/db/adapter-kysely.mjs
async function getAdapter(options) {
	return getBaseAdapter(options, async (opts) => {
		const { createKyselyAdapter } = await import("./kysely-adapter-CwPTyc9L.js");
		const { kysely, databaseType, transaction } = await createKyselyAdapter(opts);
		if (!kysely) throw new BetterAuthError("Failed to initialize database adapter");
		const { kyselyAdapter } = await import("./kysely-adapter-CwPTyc9L.js");
		return kyselyAdapter(kysely, {
			type: databaseType || "sqlite",
			debugLogs: opts.database && "debugLogs" in opts.database ? opts.database.debugLogs : false,
			transaction
		})(opts);
	});
}
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth@1.6.23_@cloudflare+workers-types@5.20260713.1_drizzle-kit@0.31.10_drizzle-o_30acf09c0f00c22f758df1843171fed3/node_modules/better-auth/dist/db/get-schema.mjs
function getSchema(config) {
	const tables = getAuthTables(config);
	const schema = {};
	for (const key in tables) {
		const table = tables[key];
		const fields = table.fields;
		const actualFields = {};
		Object.entries(fields).forEach(([key, field]) => {
			actualFields[field.fieldName || key] = field;
			if (field.references) {
				const refTable = tables[field.references.model];
				if (refTable) actualFields[field.fieldName || key].references = {
					...field.references,
					model: refTable.modelName,
					field: field.references.field
				};
			}
		});
		if (schema[table.modelName]) {
			schema[table.modelName].fields = {
				...schema[table.modelName].fields,
				...actualFields
			};
			if (table.disableMigrations) schema[table.modelName].disableMigrations = true;
			continue;
		}
		schema[table.modelName] = {
			fields: actualFields,
			order: table.order || Infinity,
			disableMigrations: table.disableMigrations
		};
	}
	return schema;
}
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth@1.6.23_@cloudflare+workers-types@5.20260713.1_drizzle-kit@0.31.10_drizzle-o_30acf09c0f00c22f758df1843171fed3/node_modules/better-auth/dist/db/get-migration.mjs
var map = {
	postgres: {
		string: [
			"character varying",
			"varchar",
			"text",
			"uuid"
		],
		number: [
			"int4",
			"integer",
			"bigint",
			"smallint",
			"numeric",
			"real",
			"double precision"
		],
		boolean: ["bool", "boolean"],
		date: [
			"timestamptz",
			"timestamp",
			"date"
		],
		json: ["json", "jsonb"]
	},
	mysql: {
		string: [
			"varchar",
			"text",
			"uuid"
		],
		number: [
			"integer",
			"int",
			"bigint",
			"smallint",
			"decimal",
			"float",
			"double"
		],
		boolean: ["boolean", "tinyint"],
		date: [
			"timestamp",
			"datetime",
			"date"
		],
		json: ["json"]
	},
	sqlite: {
		string: ["TEXT"],
		number: ["INTEGER", "REAL"],
		boolean: ["INTEGER", "BOOLEAN"],
		date: ["DATE", "INTEGER"],
		json: ["TEXT"]
	},
	mssql: {
		string: [
			"varchar",
			"nvarchar",
			"uniqueidentifier"
		],
		number: [
			"int",
			"bigint",
			"smallint",
			"decimal",
			"float",
			"double"
		],
		boolean: ["bit", "smallint"],
		date: [
			"datetime2",
			"date",
			"datetime"
		],
		json: ["varchar", "nvarchar"]
	}
};
function matchType(columnDataType, fieldType, dbType) {
	function normalize(type) {
		return type.toLowerCase().split("(")[0].trim();
	}
	if (fieldType === "string[]" || fieldType === "number[]") return columnDataType.toLowerCase().includes("json");
	const types = map[dbType];
	return (Array.isArray(fieldType) ? types["string"].map((t) => t.toLowerCase()) : types[fieldType].map((t) => t.toLowerCase())).includes(normalize(columnDataType));
}
/**
* Get the current PostgreSQL schema (search_path) for the database connection
* Returns the first schema in the search_path, defaulting to 'public' if not found
*/
async function getPostgresSchema(db) {
	try {
		const result = await sql`SHOW search_path`.execute(db);
		const searchPath = result.rows[0]?.search_path ?? result.rows[0]?.searchPath;
		if (searchPath) return searchPath.split(",").map((s) => s.trim()).map((s) => s.replace(/^["']|["']$/g, "")).filter((s) => !s.startsWith("$") && !s.startsWith("\\$"))[0] || "public";
	} catch {}
	return "public";
}
async function getMigrations(config) {
	const betterAuthSchema = getSchema(config);
	const logger = createLogger(config.logger);
	let { kysely: db, databaseType: dbType } = await createKyselyAdapter(config);
	if (!dbType) {
		logger.warn("Could not determine database type, defaulting to sqlite. Please provide a type in the database options to avoid this.");
		dbType = "sqlite";
	}
	if (!db) {
		logger.error("Only kysely adapter is supported for migrations. You can use `generate` command to generate the schema, if you're using a different adapter.");
		process.exit(1);
	}
	let currentSchema = "public";
	if (dbType === "postgres") {
		currentSchema = await getPostgresSchema(db);
		logger.debug(`PostgreSQL migration: Using schema '${currentSchema}' (from search_path)`);
		try {
			const schemaCheck = await sql`
				SELECT schema_name
				FROM information_schema.schemata
				WHERE schema_name = ${currentSchema}
			`.execute(db);
			if (!(schemaCheck.rows[0]?.schema_name ?? schemaCheck.rows[0]?.schemaName)) logger.warn(`Schema '${currentSchema}' does not exist. Tables will be inspected from available schemas. Consider creating the schema first or checking your database configuration.`);
		} catch (error) {
			logger.debug(`Could not verify schema existence: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const allTableMetadata = await db.introspection.getTables();
	let tableMetadata = allTableMetadata;
	if (dbType === "postgres") try {
		const tablesInSchema = await sql`
				SELECT table_name
				FROM information_schema.tables
				WHERE table_schema = ${currentSchema}
				AND table_type = 'BASE TABLE'
			`.execute(db);
		const tableNamesInSchema = new Set(tablesInSchema.rows.map((row) => row.table_name ?? row.tableName));
		tableMetadata = allTableMetadata.filter((table) => table.schema === currentSchema && tableNamesInSchema.has(table.name));
		logger.debug(`Found ${tableMetadata.length} table(s) in schema '${currentSchema}': ${tableMetadata.map((t) => t.name).join(", ") || "(none)"}`);
	} catch (error) {
		logger.warn(`Could not filter tables by schema. Using all discovered tables. Error: ${error instanceof Error ? error.message : String(error)}`);
	}
	const toBeCreated = [];
	const toBeAdded = [];
	for (const [key, value] of Object.entries(betterAuthSchema)) {
		if (value.disableMigrations) continue;
		const table = tableMetadata.find((t) => t.name === key);
		if (!table) {
			const tIndex = toBeCreated.findIndex((t) => t.table === key);
			const tableData = {
				table: key,
				fields: value.fields,
				order: value.order || Infinity
			};
			const insertIndex = toBeCreated.findIndex((t) => (t.order || Infinity) > tableData.order);
			if (insertIndex === -1) if (tIndex === -1) toBeCreated.push(tableData);
			else toBeCreated[tIndex].fields = {
				...toBeCreated[tIndex].fields,
				...value.fields
			};
			else toBeCreated.splice(insertIndex, 0, tableData);
			continue;
		}
		const toBeAddedFields = {};
		for (const [fieldName, field] of Object.entries(value.fields)) {
			const column = table.columns.find((c) => c.name === fieldName);
			if (!column) {
				toBeAddedFields[fieldName] = field;
				continue;
			}
			if (matchType(column.dataType, field.type, dbType)) continue;
			else logger.warn(`Field ${fieldName} in table ${key} has a different type in the database. Expected ${field.type} but got ${column.dataType}.`);
		}
		if (Object.keys(toBeAddedFields).length > 0) toBeAdded.push({
			table: key,
			fields: toBeAddedFields,
			order: value.order || Infinity
		});
	}
	const migrations = [];
	const useUUIDs = config.advanced?.database?.generateId === "uuid";
	const useNumberId = config.advanced?.database?.generateId === "serial";
	function getType(field, fieldName) {
		const type = field.type;
		const provider = dbType || "sqlite";
		const typeMap = {
			string: {
				sqlite: "text",
				postgres: "text",
				mysql: field.unique ? "varchar(255)" : field.references ? "varchar(36)" : field.sortable ? "varchar(255)" : field.index ? "varchar(255)" : "text",
				mssql: field.unique || field.sortable ? "varchar(255)" : field.references ? "varchar(36)" : "varchar(8000)"
			},
			boolean: {
				sqlite: "integer",
				postgres: "boolean",
				mysql: "boolean",
				mssql: "smallint"
			},
			number: {
				sqlite: field.bigint ? "bigint" : "integer",
				postgres: field.bigint ? "bigint" : "integer",
				mysql: field.bigint ? "bigint" : "integer",
				mssql: field.bigint ? "bigint" : "integer"
			},
			date: {
				sqlite: "date",
				postgres: "timestamptz",
				mysql: "timestamp(3)",
				mssql: sql`datetime2(3)`
			},
			json: {
				sqlite: "text",
				postgres: "jsonb",
				mysql: "json",
				mssql: "varchar(8000)"
			},
			id: {
				postgres: useNumberId ? sql`integer GENERATED BY DEFAULT AS IDENTITY` : useUUIDs ? "uuid" : "text",
				mysql: useNumberId ? "integer" : useUUIDs ? "varchar(36)" : "varchar(36)",
				mssql: useNumberId ? "integer" : useUUIDs ? "varchar(36)" : "varchar(36)",
				sqlite: useNumberId ? "integer" : "text"
			},
			foreignKeyId: {
				postgres: useNumberId ? "integer" : useUUIDs ? "uuid" : "text",
				mysql: useNumberId ? "integer" : useUUIDs ? "varchar(36)" : "varchar(36)",
				mssql: useNumberId ? "integer" : useUUIDs ? "varchar(36)" : "varchar(36)",
				sqlite: useNumberId ? "integer" : "text"
			},
			"string[]": {
				sqlite: "text",
				postgres: "jsonb",
				mysql: "json",
				mssql: "varchar(8000)"
			},
			"number[]": {
				sqlite: "text",
				postgres: "jsonb",
				mysql: "json",
				mssql: "varchar(8000)"
			}
		};
		if (fieldName === "id" || field.references?.field === "id") {
			if (fieldName === "id") return typeMap.id[provider];
			return typeMap.foreignKeyId[provider];
		}
		if (Array.isArray(type)) return "text";
		if (!(type in typeMap)) throw new Error(`Unsupported field type '${String(type)}' for field '${fieldName}'. Allowed types are: string, number, boolean, date, string[], number[]. If you need to store structured data, store it as a JSON string (type: "string") or split it into primitive fields. See https://better-auth.com/docs/advanced/schema#additional-fields`);
		return typeMap[type][provider];
	}
	const getModelName = initGetModelName({
		schema: getAuthTables(config),
		usePlural: false
	});
	const getFieldName = initGetFieldName({
		schema: getAuthTables(config),
		usePlural: false
	});
	function getReferencePath(model, field) {
		try {
			return `${getModelName(model)}.${getFieldName({
				model,
				field
			})}`;
		} catch {
			return `${model}.${field}`;
		}
	}
	const deferredIndexes = [];
	if (toBeAdded.length) for (const table of toBeAdded) for (const [fieldName, field] of Object.entries(table.fields)) {
		const type = getType(field, fieldName);
		const builder = db.schema.alterTable(table.table);
		if (field.index) {
			const indexName = `${table.table}_${fieldName}_${field.unique ? "uidx" : "idx"}`;
			const indexBuilder = db.schema.createIndex(indexName).on(table.table).columns([fieldName]);
			deferredIndexes.push(field.unique ? indexBuilder.unique() : indexBuilder);
		}
		const built = builder.addColumn(fieldName, type, (col) => {
			col = field.required !== false ? col.notNull() : col;
			if (field.references) col = col.references(getReferencePath(field.references.model, field.references.field)).onDelete(field.references.onDelete || "cascade");
			if (field.unique) col = col.unique();
			if (field.type === "date" && typeof field.defaultValue === "function" && (dbType === "postgres" || dbType === "mysql" || dbType === "mssql")) if (dbType === "mysql") col = col.defaultTo(sql`CURRENT_TIMESTAMP(3)`);
			else col = col.defaultTo(sql`CURRENT_TIMESTAMP`);
			return col;
		});
		migrations.push(built);
	}
	if (toBeCreated.length) for (const table of toBeCreated) {
		const idType = getType({ type: useNumberId ? "number" : "string" }, "id");
		let dbT = db.schema.createTable(table.table).addColumn("id", idType, (col) => {
			if (useNumberId) {
				if (dbType === "postgres") return col.primaryKey().notNull();
				else if (dbType === "sqlite") return col.primaryKey().notNull();
				else if (dbType === "mssql") return col.identity().primaryKey().notNull();
				return col.autoIncrement().primaryKey().notNull();
			}
			if (useUUIDs) {
				if (dbType === "postgres") return col.primaryKey().defaultTo(sql`pg_catalog.gen_random_uuid()`).notNull();
				return col.primaryKey().notNull();
			}
			return col.primaryKey().notNull();
		});
		for (const [fieldName, field] of Object.entries(table.fields)) {
			const type = getType(field, fieldName);
			dbT = dbT.addColumn(fieldName, type, (col) => {
				col = field.required !== false ? col.notNull() : col;
				if (field.references) col = col.references(getReferencePath(field.references.model, field.references.field)).onDelete(field.references.onDelete || "cascade");
				if (field.unique) col = col.unique();
				if (field.type === "date" && typeof field.defaultValue === "function" && (dbType === "postgres" || dbType === "mysql" || dbType === "mssql")) if (dbType === "mysql") col = col.defaultTo(sql`CURRENT_TIMESTAMP(3)`);
				else col = col.defaultTo(sql`CURRENT_TIMESTAMP`);
				return col;
			});
			if (field.index) {
				const builder = db.schema.createIndex(`${table.table}_${fieldName}_${field.unique ? "uidx" : "idx"}`).on(table.table).columns([fieldName]);
				deferredIndexes.push(field.unique ? builder.unique() : builder);
			}
		}
		migrations.push(dbT);
	}
	for (const index of deferredIndexes) migrations.push(index);
	async function runMigrations() {
		for (const migration of migrations) await migration.execute();
	}
	async function compileMigrations() {
		return migrations.map((m) => m.compile().sql).join(";\n\n") + ";";
	}
	return {
		toBeCreated,
		toBeAdded,
		runMigrations,
		compileMigrations
	};
}
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth@1.6.23_@cloudflare+workers-types@5.20260713.1_drizzle-kit@0.31.10_drizzle-o_30acf09c0f00c22f758df1843171fed3/node_modules/better-auth/dist/utils/constants.mjs
var DEFAULT_SECRET = "better-auth-secret-12345678901234567890";
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth@1.6.23_@cloudflare+workers-types@5.20260713.1_drizzle-kit@0.31.10_drizzle-o_30acf09c0f00c22f758df1843171fed3/node_modules/better-auth/dist/context/secret-utils.mjs
/**
* Estimates the entropy of a string in bits.
* This is a simple approximation that helps detect low-entropy secrets.
*/
function estimateEntropy$1(str) {
	const unique = new Set(str).size;
	if (unique === 0) return 0;
	return Math.log2(Math.pow(unique, str.length));
}
function parseSecretsEnv(envValue) {
	if (!envValue) return null;
	return envValue.split(",").map((entry) => {
		entry = entry.trim();
		const colonIdx = entry.indexOf(":");
		if (colonIdx === -1) throw new BetterAuthError(`Invalid BETTER_AUTH_SECRETS entry: "${entry}". Expected format: "<version>:<secret>"`);
		const version = parseInt(entry.slice(0, colonIdx), 10);
		if (!Number.isInteger(version) || version < 0) throw new BetterAuthError(`Invalid version in BETTER_AUTH_SECRETS: "${entry.slice(0, colonIdx)}". Version must be a non-negative integer.`);
		const value = entry.slice(colonIdx + 1).trim();
		if (!value) throw new BetterAuthError(`Empty secret value for version ${version} in BETTER_AUTH_SECRETS.`);
		return {
			version,
			value
		};
	});
}
function validateSecretsArray(secrets, logger) {
	if (secrets.length === 0) throw new BetterAuthError("`secrets` array must contain at least one entry.");
	const seen = /* @__PURE__ */ new Set();
	for (const s of secrets) {
		const version = parseInt(String(s.version), 10);
		if (!Number.isInteger(version) || version < 0 || String(version) !== String(s.version).trim()) throw new BetterAuthError(`Invalid version ${s.version} in \`secrets\`. Version must be a non-negative integer.`);
		if (!s.value) throw new BetterAuthError(`Empty secret value for version ${version} in \`secrets\`.`);
		if (seen.has(version)) throw new BetterAuthError(`Duplicate version ${version} in \`secrets\`. Each version must be unique.`);
		seen.add(version);
	}
	const current = secrets[0];
	if (current.value.length < 32) logger.warn(`[better-auth] Warning: the current secret (version ${current.version}) should be at least 32 characters long for adequate security.`);
	if (estimateEntropy$1(current.value) < 120) logger.warn("[better-auth] Warning: the current secret appears low-entropy. Use a randomly generated secret for production.");
}
function buildSecretConfig(secrets, legacySecret) {
	const keys = /* @__PURE__ */ new Map();
	for (const s of secrets) keys.set(parseInt(String(s.version), 10), s.value);
	return {
		keys,
		currentVersion: parseInt(String(secrets[0].version), 10),
		legacySecret: legacySecret && legacySecret !== "better-auth-secret-12345678901234567890" ? legacySecret : void 0
	};
}
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/@better-auth+telemetry@1.6.23_@better-auth+core@1.6.23_@better-auth+utils@0.4.2_@better_cfc3a6ded842cfc1566ad40f8abfb045/node_modules/@better-auth/telemetry/dist/index.mjs
async function getTelemetryAuthConfig(options, context) {
	return {
		database: context?.database,
		adapter: context?.adapter,
		emailVerification: {
			sendVerificationEmail: !!options.emailVerification?.sendVerificationEmail,
			sendOnSignUp: !!options.emailVerification?.sendOnSignUp,
			sendOnSignIn: !!options.emailVerification?.sendOnSignIn,
			autoSignInAfterVerification: !!options.emailVerification?.autoSignInAfterVerification,
			expiresIn: options.emailVerification?.expiresIn,
			beforeEmailVerification: !!options.emailVerification?.beforeEmailVerification,
			afterEmailVerification: !!options.emailVerification?.afterEmailVerification
		},
		emailAndPassword: {
			enabled: !!options.emailAndPassword?.enabled,
			disableSignUp: !!options.emailAndPassword?.disableSignUp,
			requireEmailVerification: !!options.emailAndPassword?.requireEmailVerification,
			maxPasswordLength: options.emailAndPassword?.maxPasswordLength,
			minPasswordLength: options.emailAndPassword?.minPasswordLength,
			sendResetPassword: !!options.emailAndPassword?.sendResetPassword,
			resetPasswordTokenExpiresIn: options.emailAndPassword?.resetPasswordTokenExpiresIn,
			onPasswordReset: !!options.emailAndPassword?.onPasswordReset,
			password: {
				hash: !!options.emailAndPassword?.password?.hash,
				verify: !!options.emailAndPassword?.password?.verify
			},
			autoSignIn: !!options.emailAndPassword?.autoSignIn,
			revokeSessionsOnPasswordReset: !!options.emailAndPassword?.revokeSessionsOnPasswordReset
		},
		socialProviders: await Promise.all(Object.keys(options.socialProviders || {}).map(async (key) => {
			const p = options.socialProviders?.[key];
			if (!p) return {};
			const provider = typeof p === "function" ? await p() : p;
			return {
				id: key,
				mapProfileToUser: !!provider.mapProfileToUser,
				disableDefaultScope: !!provider.disableDefaultScope,
				disableIdTokenSignIn: !!provider.disableIdTokenSignIn,
				disableImplicitSignUp: provider.disableImplicitSignUp,
				disableSignUp: provider.disableSignUp,
				getUserInfo: !!provider.getUserInfo,
				overrideUserInfoOnSignIn: !!provider.overrideUserInfoOnSignIn,
				prompt: provider.prompt,
				verifyIdToken: !!provider.verifyIdToken,
				scope: provider.scope,
				refreshAccessToken: !!provider.refreshAccessToken
			};
		})),
		plugins: options.plugins?.map((p) => p.id.toString()),
		user: {
			modelName: options.user?.modelName,
			fields: options.user?.fields,
			additionalFields: options.user?.additionalFields,
			changeEmail: {
				enabled: options.user?.changeEmail?.enabled,
				sendChangeEmailConfirmation: !!options.user?.changeEmail?.sendChangeEmailConfirmation
			}
		},
		verification: {
			modelName: options.verification?.modelName,
			disableCleanup: options.verification?.disableCleanup,
			fields: options.verification?.fields
		},
		session: {
			modelName: options.session?.modelName,
			additionalFields: options.session?.additionalFields,
			cookieCache: {
				enabled: options.session?.cookieCache?.enabled,
				maxAge: options.session?.cookieCache?.maxAge,
				strategy: options.session?.cookieCache?.strategy
			},
			disableSessionRefresh: options.session?.disableSessionRefresh,
			expiresIn: options.session?.expiresIn,
			fields: options.session?.fields,
			freshAge: options.session?.freshAge,
			preserveSessionInDatabase: options.session?.preserveSessionInDatabase,
			storeSessionInDatabase: options.session?.storeSessionInDatabase,
			updateAge: options.session?.updateAge
		},
		account: {
			modelName: options.account?.modelName,
			fields: options.account?.fields,
			encryptOAuthTokens: options.account?.encryptOAuthTokens,
			updateAccountOnSignIn: options.account?.updateAccountOnSignIn,
			accountLinking: {
				enabled: options.account?.accountLinking?.enabled,
				trustedProviders: options.account?.accountLinking?.trustedProviders,
				updateUserInfoOnLink: options.account?.accountLinking?.updateUserInfoOnLink,
				allowUnlinkingAll: options.account?.accountLinking?.allowUnlinkingAll
			}
		},
		hooks: {
			after: !!options.hooks?.after,
			before: !!options.hooks?.before
		},
		secondaryStorage: !!options.secondaryStorage,
		advanced: {
			cookiePrefix: !!options.advanced?.cookiePrefix,
			cookies: !!options.advanced?.cookies,
			crossSubDomainCookies: {
				domain: !!options.advanced?.crossSubDomainCookies?.domain,
				enabled: options.advanced?.crossSubDomainCookies?.enabled,
				additionalCookies: options.advanced?.crossSubDomainCookies?.additionalCookies
			},
			database: {
				generateId: options.advanced?.database?.generateId,
				defaultFindManyLimit: options.advanced?.database?.defaultFindManyLimit
			},
			useSecureCookies: options.advanced?.useSecureCookies,
			ipAddress: {
				disableIpTracking: options.advanced?.ipAddress?.disableIpTracking,
				ipAddressHeaders: options.advanced?.ipAddress?.ipAddressHeaders
			},
			disableCSRFCheck: options.advanced?.disableCSRFCheck,
			cookieAttributes: {
				expires: options.advanced?.defaultCookieAttributes?.expires,
				secure: options.advanced?.defaultCookieAttributes?.secure,
				sameSite: options.advanced?.defaultCookieAttributes?.sameSite,
				domain: !!options.advanced?.defaultCookieAttributes?.domain,
				path: options.advanced?.defaultCookieAttributes?.path,
				httpOnly: options.advanced?.defaultCookieAttributes?.httpOnly
			}
		},
		trustedOrigins: options.trustedOrigins?.length,
		rateLimit: {
			storage: options.rateLimit?.storage,
			modelName: options.rateLimit?.modelName,
			window: options.rateLimit?.window,
			customStorage: !!options.rateLimit?.customStorage,
			enabled: options.rateLimit?.enabled,
			max: options.rateLimit?.max
		},
		onAPIError: {
			errorURL: options.onAPIError?.errorURL,
			onError: !!options.onAPIError?.onError,
			throw: options.onAPIError?.throw
		},
		logger: {
			disabled: options.logger?.disabled,
			level: options.logger?.level,
			log: !!options.logger?.log
		},
		databaseHooks: {
			user: {
				create: {
					after: !!options.databaseHooks?.user?.create?.after,
					before: !!options.databaseHooks?.user?.create?.before
				},
				update: {
					after: !!options.databaseHooks?.user?.update?.after,
					before: !!options.databaseHooks?.user?.update?.before
				}
			},
			session: {
				create: {
					after: !!options.databaseHooks?.session?.create?.after,
					before: !!options.databaseHooks?.session?.create?.before
				},
				update: {
					after: !!options.databaseHooks?.session?.update?.after,
					before: !!options.databaseHooks?.session?.update?.before
				}
			},
			account: {
				create: {
					after: !!options.databaseHooks?.account?.create?.after,
					before: !!options.databaseHooks?.account?.create?.before
				},
				update: {
					after: !!options.databaseHooks?.account?.update?.after,
					before: !!options.databaseHooks?.account?.update?.before
				}
			},
			verification: {
				create: {
					after: !!options.databaseHooks?.verification?.create?.after,
					before: !!options.databaseHooks?.verification?.create?.before
				},
				update: {
					after: !!options.databaseHooks?.verification?.update?.after,
					before: !!options.databaseHooks?.verification?.update?.before
				}
			}
		}
	};
}
async function getPackageVersion(_pkg) {}
async function getNameFromLocalPackageJson() {}
var DATABASES = {
	pg: "postgresql",
	mysql: "mysql",
	mariadb: "mariadb",
	sqlite3: "sqlite",
	"better-sqlite3": "sqlite",
	"@prisma/client": "prisma",
	mongoose: "mongodb",
	mongodb: "mongodb",
	"drizzle-orm": "drizzle"
};
async function detectDatabase() {
	for (const [pkg, name] of Object.entries(DATABASES)) {
		const version = await getPackageVersion(pkg);
		if (version) return {
			name,
			version
		};
	}
}
var FRAMEWORKS = {
	next: "next",
	nuxt: "nuxt",
	"react-router": "react-router",
	astro: "astro",
	"@sveltejs/kit": "sveltekit",
	"solid-start": "solid-start",
	"tanstack-start": "tanstack-start",
	hono: "hono",
	express: "express",
	elysia: "elysia",
	expo: "expo"
};
async function detectFramework() {
	for (const [pkg, name] of Object.entries(FRAMEWORKS)) {
		const version = await getPackageVersion(pkg);
		if (version) return {
			name,
			version
		};
	}
}
function detectPackageManager() {
	const userAgent = env.npm_config_user_agent;
	if (!userAgent) return;
	const pmSpec = userAgent.split(" ")[0];
	const separatorPos = pmSpec.lastIndexOf("/");
	const name = pmSpec.substring(0, separatorPos);
	return {
		name: name === "npminstall" ? "cnpm" : name,
		version: pmSpec.substring(separatorPos + 1)
	};
}
function getVendor() {
	const hasAny = (...keys) => keys.some((k) => Boolean(env[k]));
	if (hasAny("CF_PAGES", "CF_PAGES_URL", "CF_ACCOUNT_ID") || typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") return "cloudflare";
	if (hasAny("VERCEL", "VERCEL_URL", "VERCEL_ENV")) return "vercel";
	if (hasAny("NETLIFY", "NETLIFY_URL")) return "netlify";
	if (hasAny("RENDER", "RENDER_URL", "RENDER_INTERNAL_HOSTNAME", "RENDER_SERVICE_ID")) return "render";
	if (hasAny("AWS_LAMBDA_FUNCTION_NAME", "AWS_EXECUTION_ENV", "LAMBDA_TASK_ROOT")) return "aws";
	if (hasAny("GOOGLE_CLOUD_FUNCTION_NAME", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "K_SERVICE")) return "gcp";
	if (hasAny("AZURE_FUNCTION_NAME", "FUNCTIONS_WORKER_RUNTIME", "WEBSITE_INSTANCE_ID", "WEBSITE_SITE_NAME")) return "azure";
	if (hasAny("DENO_DEPLOYMENT_ID", "DENO_REGION")) return "deno-deploy";
	if (hasAny("FLY_APP_NAME", "FLY_REGION", "FLY_ALLOC_ID")) return "fly-io";
	if (hasAny("RAILWAY_STATIC_URL", "RAILWAY_ENVIRONMENT_NAME")) return "railway";
	if (hasAny("DYNO", "HEROKU_APP_NAME")) return "heroku";
	if (hasAny("DO_DEPLOYMENT_ID", "DO_APP_NAME", "DIGITALOCEAN")) return "digitalocean";
	if (hasAny("KOYEB", "KOYEB_DEPLOYMENT_ID", "KOYEB_APP_NAME")) return "koyeb";
	return null;
}
async function detectSystemInfo() {
	return {
		deploymentVendor: getVendor(),
		systemPlatform: null,
		systemRelease: null,
		systemArchitecture: null,
		cpuCount: null,
		cpuModel: null,
		cpuSpeed: null,
		memory: null,
		isWSL: null,
		isDocker: null,
		isTTY: null
	};
}
function isCI() {
	return env.CI !== "false" && ("BUILD_ID" in env || "BUILD_NUMBER" in env || "CI" in env || "CI_APP_ID" in env || "CI_BUILD_ID" in env || "CI_BUILD_NUMBER" in env || "CI_NAME" in env || "CONTINUOUS_INTEGRATION" in env || "RUN_ID" in env);
}
function detectRuntime() {
	if (typeof Deno !== "undefined") return {
		name: "deno",
		version: Deno?.version?.deno ?? null
	};
	if (typeof Bun !== "undefined") return {
		name: "bun",
		version: Bun?.version ?? null
	};
	if (typeof process !== "undefined" && process?.versions?.node) return {
		name: "node",
		version: process.versions.node ?? null
	};
	return {
		name: "edge",
		version: null
	};
}
function detectEnvironment() {
	return getEnvVar("NODE_ENV") === "production" ? "production" : isCI() ? "ci" : isTest() ? "test" : "development";
}
async function hashToBase64(data) {
	const buffer = await createHash("SHA-256").digest(data);
	return base64.encode(buffer);
}
var generateId$1 = (size) => {
	return createRandomStringGenerator("a-z", "A-Z", "0-9")(size || 32);
};
var projectIdCached = null;
async function getProjectId(baseUrl) {
	if (projectIdCached) return projectIdCached;
	const projectName = await getNameFromLocalPackageJson();
	if (projectName) {
		projectIdCached = await hashToBase64(baseUrl ? baseUrl + projectName : projectName);
		return projectIdCached;
	}
	if (baseUrl) {
		projectIdCached = await hashToBase64(baseUrl);
		return projectIdCached;
	}
	projectIdCached = generateId$1(32);
	return projectIdCached;
}
var noop = async function noop() {};
async function createTelemetry(options, context) {
	const debugEnabled = options.telemetry?.debug || getBooleanEnvVar("BETTER_AUTH_TELEMETRY_DEBUG", false);
	const telemetryEndpoint = ENV.BETTER_AUTH_TELEMETRY_ENDPOINT;
	if (!telemetryEndpoint && !context?.customTrack) return { publish: noop };
	const track = async (event) => {
		if (context?.customTrack) await context.customTrack(event).catch(logger.error);
		else if (telemetryEndpoint) if (debugEnabled) logger.info("telemetry event", JSON.stringify(event, null, 2));
		else await betterFetch(telemetryEndpoint, {
			method: "POST",
			body: event
		}).catch(logger.error);
	};
	const isEnabled = async () => {
		const telemetryEnabled = options.telemetry?.enabled !== void 0 ? options.telemetry.enabled : false;
		return (getBooleanEnvVar("BETTER_AUTH_TELEMETRY", false) || telemetryEnabled) && (context?.skipTestCheck || !isTest());
	};
	const enabled = await isEnabled();
	let anonymousId;
	if (enabled) {
		anonymousId = await getProjectId(typeof options.baseURL === "string" ? options.baseURL : void 0);
		track({
			type: "init",
			payload: {
				config: await getTelemetryAuthConfig(options, context),
				runtime: detectRuntime(),
				database: await detectDatabase(),
				framework: await detectFramework(),
				environment: detectEnvironment(),
				systemInfo: await detectSystemInfo(),
				packageManager: detectPackageManager()
			},
			anonymousId
		});
	}
	return { publish: async (event) => {
		if (!enabled) return;
		if (!anonymousId) anonymousId = await getProjectId(typeof options.baseURL === "string" ? options.baseURL : void 0);
		await track({
			type: event.type,
			payload: event.payload,
			anonymousId
		});
	} };
}
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth@1.6.23_@cloudflare+workers-types@5.20260713.1_drizzle-kit@0.31.10_drizzle-o_30acf09c0f00c22f758df1843171fed3/node_modules/better-auth/dist/context/create-context.mjs
/**
* Estimates the entropy of a string in bits.
* This is a simple approximation that helps detect low-entropy secrets.
*/
function estimateEntropy(str) {
	const unique = new Set(str).size;
	if (unique === 0) return 0;
	return Math.log2(Math.pow(unique, str.length));
}
/**
* Validates that the secret meets minimum security requirements.
* Throws BetterAuthError if the secret is invalid.
* Skips validation for DEFAULT_SECRET in test environments only.
* Only throws for DEFAULT_SECRET in production environment.
*/
function validateSecret(secret, logger) {
	const isDefaultSecret = secret === DEFAULT_SECRET;
	if (isTest()) return;
	if (isDefaultSecret && isProduction) throw new BetterAuthError("You are using the default secret. Please set `BETTER_AUTH_SECRET` in your environment variables or pass `secret` in your auth config.");
	if (!secret) throw new BetterAuthError("BETTER_AUTH_SECRET is missing. Set it in your environment or pass `secret` to betterAuth({ secret }).");
	if (secret.length < 32) logger.warn(`[better-auth] Warning: your BETTER_AUTH_SECRET should be at least 32 characters long for adequate security. Generate one with \`npx auth secret\` or \`openssl rand -base64 32\`.`);
	if (estimateEntropy(secret) < 120) logger.warn("[better-auth] Warning: your BETTER_AUTH_SECRET appears low-entropy. Use a randomly generated secret for production.");
}
async function createAuthContext(adapter, options, getDatabaseType) {
	const isStateful = hasServerSessionStore(options);
	if (!isStateful) options = defu(options, { session: { cookieCache: {
		enabled: true,
		strategy: "jwe",
		refreshCache: true,
		maxAge: options.session?.expiresIn || 3600 * 24 * 7
	} } });
	if (!options.database) options = defu(options, { account: { storeAccountCookie: true } });
	const plugins = options.plugins || [];
	const internalPlugins = getInternalPlugins(options);
	const logger = createLogger(options.logger);
	const isDynamicConfig = isDynamicBaseURLConfig(options.baseURL);
	if (isDynamicBaseURLConfig(options.baseURL)) {
		const { allowedHosts } = options.baseURL;
		if (!allowedHosts || allowedHosts.length === 0) throw new BetterAuthError("baseURL.allowedHosts cannot be empty. Provide at least one allowed host pattern (e.g., [\"myapp.com\", \"*.vercel.app\"]).");
	}
	const baseURL = isDynamicConfig ? void 0 : getBaseURL(typeof options.baseURL === "string" ? options.baseURL : void 0, options.basePath);
	if (!baseURL && !isDynamicConfig) logger.warn(`[better-auth] Base URL is not set. Set the baseURL option or BETTER_AUTH_URL env, or use a dynamic baseURL with allowedHosts for multi-host setups. Without it the origin is derived from the incoming request, and callbacks and redirects may not work correctly.`);
	if (adapter.id === "memory" && options.advanced?.database?.generateId === false) logger.error(`[better-auth] Misconfiguration detected.
You are using the memory DB with generateId: false.
This will cause no id to be generated for any model.
Most of the features of Better Auth will not work correctly.`);
	const secretsArray = options.secrets ?? parseSecretsEnv(env.BETTER_AUTH_SECRETS);
	const legacySecret = options.secret || env.BETTER_AUTH_SECRET || env.AUTH_SECRET || "";
	let secret;
	let secretConfig;
	if (secretsArray) {
		validateSecretsArray(secretsArray, logger);
		secret = secretsArray[0].value;
		secretConfig = buildSecretConfig(secretsArray, legacySecret);
	} else {
		secret = legacySecret || "better-auth-secret-12345678901234567890";
		validateSecret(secret, logger);
		secretConfig = secret;
	}
	options = {
		...options,
		secret,
		baseURL: isDynamicConfig ? options.baseURL : baseURL ? new URL(baseURL).origin : "",
		basePath: options.basePath || "/api/auth",
		plugins: plugins.concat(internalPlugins)
	};
	checkEndpointConflicts(options, logger);
	const trustedProxies = options.advanced?.ipAddress?.trustedProxies;
	if (trustedProxies && trustedProxies.length > 0) {
		const invalid = findInvalidTrustedProxies(trustedProxies);
		if (invalid.length > 0) logger.warn(`Ignoring invalid \`advanced.ipAddress.trustedProxies\` entries: ${invalid.join(", ")}. Each entry must be an IP address or CIDR range.`);
	}
	const cookies = getCookies(options);
	const tables = getAuthTables(options);
	const providers = (await Promise.all(Object.entries(options.socialProviders || {}).map(async ([key, originalConfig]) => {
		const config = typeof originalConfig === "function" ? await originalConfig() : originalConfig;
		if (config == null) return null;
		if (config.enabled === false) return null;
		if (!config.clientId) logger.warn(`Social provider ${key} is missing clientId or clientSecret`);
		const provider = socialProviders[key](config);
		provider.disableImplicitSignUp = config.disableImplicitSignUp;
		return provider;
	}))).filter((x) => x !== null);
	const generateIdFunc = ({ model, size }) => {
		if (typeof options.advanced?.generateId === "function") return options.advanced.generateId({
			model,
			size
		});
		const dbGenerateId = options?.advanced?.database?.generateId;
		if (typeof dbGenerateId === "function") return dbGenerateId({
			model,
			size
		});
		if (dbGenerateId === "uuid") return crypto.randomUUID();
		if (dbGenerateId === "serial" || dbGenerateId === false) return false;
		return generateId(size);
	};
	const { publish } = await createTelemetry(options, {
		adapter: adapter.id,
		database: typeof options.database === "function" ? "adapter" : getDatabaseType(options.database)
	});
	const pluginIds = new Set(options.plugins.map((p) => p.id));
	const getPluginFn = (id) => options.plugins.find((p) => p.id === id) ?? null;
	const hasPluginFn = (id) => pluginIds.has(id);
	const trustedOrigins = await getTrustedOrigins(options);
	const trustedProviders = await getTrustedProviders(options);
	const ctx = {
		appName: options.appName || "Better Auth",
		baseURL: baseURL || "",
		version: getBetterAuthVersion(),
		socialProviders: providers,
		options,
		oauthConfig: {
			storeStateStrategy: options.account?.storeStateStrategy || (isStateful ? "database" : "cookie"),
			skipStateCookieCheck: !!options.account?.skipStateCookieCheck
		},
		tables,
		trustedOrigins,
		trustedProviders,
		isTrustedOrigin(url, settings) {
			return this.trustedOrigins.some((origin) => matchesOriginPattern(url, origin, settings));
		},
		sessionConfig: {
			updateAge: options.session?.updateAge !== void 0 ? options.session.updateAge : 1440 * 60,
			expiresIn: options.session?.expiresIn || 3600 * 24 * 7,
			freshAge: options.session?.freshAge === void 0 ? 3600 * 24 : options.session.freshAge,
			cookieRefreshCache: (() => {
				const refreshCache = options.session?.cookieCache?.refreshCache;
				const maxAge = options.session?.cookieCache?.maxAge || 300;
				if (isStateful && refreshCache) {
					logger.warn("[better-auth] `session.cookieCache.refreshCache` is enabled while `database` or `secondaryStorage` is configured. `refreshCache` is meant for stateless (DB-less) setups. Disabling `refreshCache` — remove it from your config to silence this warning.");
					return false;
				}
				if (refreshCache === false || refreshCache === void 0) return false;
				if (refreshCache === true) return {
					enabled: true,
					updateAge: Math.floor(maxAge * .2)
				};
				return {
					enabled: true,
					updateAge: refreshCache.updateAge !== void 0 ? refreshCache.updateAge : Math.floor(maxAge * .2)
				};
			})()
		},
		secret,
		secretConfig,
		rateLimit: {
			...options.rateLimit,
			enabled: options.rateLimit?.enabled ?? isProduction,
			window: options.rateLimit?.window || 10,
			max: options.rateLimit?.max || 100,
			storage: options.rateLimit?.storage || (options.secondaryStorage ? "secondary-storage" : "memory")
		},
		authCookies: cookies,
		logger,
		generateId: generateIdFunc,
		session: null,
		secondaryStorage: options.secondaryStorage,
		password: {
			hash: options.emailAndPassword?.password?.hash || hashPassword$1,
			verify: options.emailAndPassword?.password?.verify || verifyPassword$1,
			config: {
				minPasswordLength: options.emailAndPassword?.minPasswordLength || 8,
				maxPasswordLength: options.emailAndPassword?.maxPasswordLength || 128
			},
			checkPassword
		},
		setNewSession(session) {
			this.newSession = session;
		},
		newSession: null,
		adapter,
		internalAdapter: createInternalAdapter(adapter, {
			options,
			logger,
			hooks: options.databaseHooks ? [{
				source: "user",
				hooks: options.databaseHooks
			}] : [],
			generateId: generateIdFunc
		}),
		createAuthCookie: createCookieGetter(options),
		async runMigrations() {
			throw new BetterAuthError("runMigrations will be set by the specific init implementation");
		},
		publishTelemetry: publish,
		skipCSRFCheck: !!options.advanced?.disableCSRFCheck,
		skipOriginCheck: options.advanced?.disableOriginCheck !== void 0 ? options.advanced.disableOriginCheck : isTest() ? true : false,
		runInBackground: options.advanced?.backgroundTasks?.handler ?? ((p) => {
			p.catch(() => {});
		}),
		async runInBackgroundOrAwait(promise) {
			try {
				if (options.advanced?.backgroundTasks?.handler) {
					if (promise instanceof Promise) options.advanced.backgroundTasks.handler(promise.catch((e) => {
						logger.error("Failed to run background task:", e);
					}));
				} else await promise;
			} catch (e) {
				logger.error("Failed to run background task:", e);
			}
		},
		getPlugin: getPluginFn,
		hasPlugin: hasPluginFn
	};
	const initOrPromise = runPluginInit(ctx);
	if (isPromise(initOrPromise)) await initOrPromise;
	return ctx;
}
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth@1.6.23_@cloudflare+workers-types@5.20260713.1_drizzle-kit@0.31.10_drizzle-o_30acf09c0f00c22f758df1843171fed3/node_modules/better-auth/dist/context/init.mjs
var init = async (options) => {
	const adapter = await getAdapter(options);
	const getDatabaseType = (database) => getKyselyDatabaseType(database) || "unknown";
	const ctx = await createAuthContext(adapter, options, getDatabaseType);
	ctx.runMigrations = async function() {
		if (!options.database || "updateMany" in options.database) throw new BetterAuthError("Database is not provided or it's an adapter. Migrations are only supported with a database instance.");
		const { runMigrations } = await getMigrations(options);
		await runMigrations();
	};
	return ctx;
};
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth@1.6.23_@cloudflare+workers-types@5.20260713.1_drizzle-kit@0.31.10_drizzle-o_30acf09c0f00c22f758df1843171fed3/node_modules/better-auth/dist/auth/base.mjs
var createBetterAuth = (options, initFn) => {
	const authContext = initFn(options);
	const { api } = getEndpoints(authContext, options);
	return {
		handler: async (request) => {
			const ctx = await authContext;
			const basePath = ctx.options.basePath || "/api/auth";
			let handlerCtx;
			if (isDynamicBaseURLConfig(options.baseURL)) handlerCtx = await resolveRequestContext(ctx, request, resolveDynamicTrustedProxyHeaders(ctx.options));
			else {
				handlerCtx = Object.create(Object.getPrototypeOf(ctx), Object.getOwnPropertyDescriptors(ctx));
				let trustOptions = ctx.options;
				if (!ctx.options.baseURL) {
					const baseURL = getBaseURL(void 0, basePath, request, void 0, ctx.options.advanced?.trustedProxyHeaders);
					if (!baseURL) throw new BetterAuthError("Could not get base URL from request. Please provide a valid base URL.");
					handlerCtx.baseURL = baseURL;
					handlerCtx.options = {
						...ctx.options,
						baseURL: getOrigin(baseURL) || void 0
					};
					trustOptions = handlerCtx.options;
				}
				handlerCtx.trustedOrigins = await getTrustedOrigins(trustOptions, request);
				handlerCtx.trustedProviders = await getTrustedProviders(trustOptions, request);
			}
			const { handler } = router(handlerCtx, options);
			return runWithAdapter(handlerCtx.adapter, () => handler(request));
		},
		api,
		options,
		$context: authContext,
		$ERROR_CODES: {
			...options.plugins?.reduce((acc, plugin) => {
				if (plugin.$ERROR_CODES) return {
					...acc,
					...plugin.$ERROR_CODES
				};
				return acc;
			}, {}),
			...BASE_ERROR_CODES
		}
	};
};
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth@1.6.23_@cloudflare+workers-types@5.20260713.1_drizzle-kit@0.31.10_drizzle-o_30acf09c0f00c22f758df1843171fed3/node_modules/better-auth/dist/auth/full.mjs
/**
* Better Auth initializer for full mode (with Kysely)
*
* @example
* ```ts
* import { betterAuth } from "better-auth";
*
* const auth = betterAuth({
* 	database: new PostgresDialect({ connection: process.env.DATABASE_URL }),
* });
* ```
*
* For minimal mode (without Kysely), import from `better-auth/minimal` instead
* @example
* ```ts
* import { betterAuth } from "better-auth/minimal";
*
* const auth = betterAuth({
*	  database: drizzleAdapter(db, { provider: "pg" }),
* });
*/
var betterAuth = (options) => {
	return createBetterAuth(options, init);
};
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/@better-auth+core@1.6.23_@better-auth+utils@0.4.2_@better-fetch+fetch@1.3.1_@cloudflare_9af17ac30fdf35bdd7823fbd3f2ce972/node_modules/@better-auth/core/dist/oauth2/client-credentials-token.mjs
async function clientCredentialsTokenRequest({ options, scope, authentication, resource }) {
	options = typeof options === "function" ? await options() : options;
	return createClientCredentialsTokenRequest({
		options,
		scope,
		authentication,
		resource
	});
}
/**
* @deprecated use async'd clientCredentialsTokenRequest instead
*/
function createClientCredentialsTokenRequest({ options, scope, authentication, resource }) {
	const body = new URLSearchParams();
	const headers = {
		"content-type": "application/x-www-form-urlencoded",
		accept: "application/json"
	};
	body.set("grant_type", "client_credentials");
	scope && body.set("scope", scope);
	if (resource) if (typeof resource === "string") body.append("resource", resource);
	else for (const _resource of resource) body.append("resource", _resource);
	if (authentication === "basic") {
		const primaryClientId = Array.isArray(options.clientId) ? options.clientId[0] : options.clientId;
		headers["authorization"] = `Basic ${base64Url.encode(`${primaryClientId}:${options.clientSecret}`)}`;
	} else {
		const primaryClientId = Array.isArray(options.clientId) ? options.clientId[0] : options.clientId;
		body.set("client_id", primaryClientId);
		body.set("client_secret", options.clientSecret);
	}
	return {
		body,
		headers
	};
}
async function clientCredentialsToken({ options, tokenEndpoint, scope, authentication, resource }) {
	const { body, headers } = await clientCredentialsTokenRequest({
		options,
		scope,
		authentication,
		resource
	});
	const { data, error } = await fetchRefusingRedirects(tokenEndpoint, {
		method: "POST",
		body,
		headers
	});
	if (error) throw error;
	const tokens = {
		accessToken: data.access_token,
		tokenType: data.token_type,
		scopes: data.scope?.split(" ")
	};
	if (data.expires_in) tokens.accessTokenExpiresAt = new Date((/* @__PURE__ */ new Date()).getTime() + data.expires_in * 1e3);
	return tokens;
}
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/@better-auth+core@1.6.23_@better-auth+utils@0.4.2_@better-fetch+fetch@1.3.1_@cloudflare_9af17ac30fdf35bdd7823fbd3f2ce972/node_modules/@better-auth/core/dist/oauth2/verify.mjs
var joseInfrastructureErrorCodes = /* @__PURE__ */ new Set([
	JWKSTimeout.code,
	JWKSInvalid.code,
	JWKSMultipleMatchingKeys.code
]);
function isJoseInfrastructureError(error) {
	return joseInfrastructureErrorCodes.has(error.code);
}
/**
* @internal
*/
var jwksCache = /* @__PURE__ */ new Map();
/**
* Cache for function jwks sources, keyed by a caller-provided stable object.
* Entries are released with their key, so per-request keys cannot accumulate.
*/
var functionJwksCache = /* @__PURE__ */ new WeakMap();
/**
* How long a cached JWKS is trusted before it is refetched
*
* @internal
*/
var JWKS_CACHE_TTL_MS = 300 * 1e3;
var JWKS_NO_KID_REFETCH_COOLDOWN_MS = 30 * 1e3;
/**
* Returns the cached key set when it is within the TTL. When the token carries
* `kid`, the cached set must contain that key id; without `kid`, key selection
* is deferred to JOSE because RFC 7515 makes the header parameter optional.
*/
function getFreshJwksWithKid(cached, kid) {
	if (!cached) return void 0;
	if (Date.now() - cached.fetchedAt >= JWKS_CACHE_TTL_MS) return void 0;
	if (kid && !cached.jwks.keys.some((jwk) => jwk.kid === kid)) return;
	return cached.jwks;
}
function shouldRefetchCachedJwksWithoutKid(error, resolved) {
	if (!(resolved.fromCache && !resolved.kid && (error instanceof JWKSNoMatchingKey || error instanceof JWSSignatureVerificationFailed))) return false;
	if (!resolved.noKidRefetchedAt) return true;
	return Date.now() - resolved.noKidRefetchedAt >= JWKS_NO_KID_REFETCH_COOLDOWN_MS;
}
async function fetchJwks(jwksFetch) {
	const jwks = typeof jwksFetch === "string" ? await fetchRefusingRedirects(jwksFetch, { headers: { Accept: "application/json" } }).then(async (res) => {
		if (res.error) throw new Error(`Jwks failed: ${res.error.message ?? res.error.statusText}`);
		return res.data;
	}) : await jwksFetch();
	if (!jwks) throw new Error("No jwks found");
	return jwks;
}
/**
* Performs local verification of an access token for your APIs.
*
* Can also be configured for remote verification.
*/
async function verifyJwsAccessToken(token, opts) {
	try {
		const resolved = await getJwksForVerification(token, opts);
		let jwt;
		try {
			jwt = await jwtVerify(token, createLocalJWKSet(resolved.jwks), opts.verifyOptions);
		} catch (error) {
			if (shouldRefetchCachedJwksWithoutKid(error, resolved)) jwt = await jwtVerify(token, createLocalJWKSet((await getJwksForVerification(token, {
				...opts,
				forceRefresh: true
			})).jwks), opts.verifyOptions);
			else throw error;
		}
		if (jwt.payload.azp) jwt.payload.client_id = jwt.payload.azp;
		return jwt.payload;
	} catch (error) {
		if (error instanceof Error) throw error;
		throw new Error(error);
	}
}
async function getJwks(token, opts) {
	return (await getJwksForVerification(token, opts)).jwks;
}
async function getJwksForVerification(token, opts) {
	let jwtHeaders;
	try {
		jwtHeaders = decodeProtectedHeader(token);
	} catch (error) {
		if (error instanceof Error) throw error;
		throw new Error(error);
	}
	const kid = jwtHeaders.kid;
	if (typeof opts.jwksFetch !== "string") {
		const cacheKey = opts.jwksCacheKey;
		if (!cacheKey) {
			const jwks = await opts.jwksFetch();
			if (!jwks) throw new Error("No jwks found");
			return {
				jwks,
				fromCache: false,
				kid
			};
		}
		const cached = functionJwksCache.get(cacheKey);
		const cachedJwks = opts.forceRefresh ? void 0 : getFreshJwksWithKid(cached, kid);
		if (cachedJwks) return {
			jwks: cachedJwks,
			fromCache: true,
			kid,
			noKidRefetchedAt: cached?.noKidRefetchedAt
		};
		const jwks = await opts.jwksFetch();
		if (!jwks) throw new Error("No jwks found");
		const fetchedAt = Date.now();
		functionJwksCache.set(cacheKey, {
			jwks,
			fetchedAt,
			...opts.forceRefresh && !kid ? { noKidRefetchedAt: fetchedAt } : {}
		});
		return {
			jwks,
			fromCache: false,
			kid
		};
	}
	const cacheKey = opts.jwksFetch;
	const cached = jwksCache.get(cacheKey);
	const cachedJwks = opts.forceRefresh ? void 0 : getFreshJwksWithKid(cached, kid);
	if (!cachedJwks) {
		const jwks = await fetchJwks(opts.jwksFetch);
		const fetchedAt = Date.now();
		jwksCache.set(cacheKey, {
			jwks,
			fetchedAt,
			...opts.forceRefresh && !kid ? { noKidRefetchedAt: fetchedAt } : {}
		});
		return {
			jwks,
			fromCache: false,
			kid
		};
	}
	return {
		jwks: cachedJwks,
		fromCache: true,
		kid,
		noKidRefetchedAt: cached?.noKidRefetchedAt
	};
}
/**
* Performs local verification of an access token for your API.
*
* Can also be configured for remote verification.
*/
async function verifyAccessToken(token, opts) {
	let payload;
	if (opts.jwksUrl && !opts?.remoteVerify?.force) try {
		payload = await verifyJwsAccessToken(token, {
			jwksFetch: opts.jwksUrl,
			verifyOptions: opts.verifyOptions
		});
	} catch (error) {
		if (error instanceof Error) if (error.name === "TypeError" || error.name === "JWSInvalid") {} else if (error instanceof JWTExpired) throw new APIError$1("UNAUTHORIZED", { message: "token expired" });
		else if (error instanceof JOSEError) {
			if (isJoseInfrastructureError(error)) throw error;
			throw new APIError$1("UNAUTHORIZED", { message: "invalid access token" });
		} else throw error;
		else throw new Error(error);
	}
	if (opts?.remoteVerify) {
		const { data: introspect, error: introspectError } = await fetchRefusingRedirects(opts.remoteVerify.introspectUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded"
			},
			body: new URLSearchParams({
				client_id: opts.remoteVerify.clientId,
				client_secret: opts.remoteVerify.clientSecret,
				token,
				token_type_hint: "access_token"
			}).toString()
		});
		if (introspectError) logger.error(`Introspection failed: ${introspectError.message ?? introspectError.statusText}`);
		if (!introspect) throw new APIError$1("INTERNAL_SERVER_ERROR", { message: "introspection failed" });
		if (!introspect.active) throw new APIError$1("UNAUTHORIZED", { message: "token inactive" });
		try {
			const unsecuredJwt = new UnsecuredJWT(introspect).encode();
			const { audience: _audience, ...verifyOptionsNoAudience } = opts.verifyOptions;
			const skipAudience = !introspect.aud && opts.remoteVerify.allowMissingAudience === true;
			payload = UnsecuredJWT.decode(unsecuredJwt, skipAudience ? verifyOptionsNoAudience : opts.verifyOptions).payload;
		} catch (error) {
			throw new Error(error);
		}
	}
	if (!payload) throw new APIError$1("UNAUTHORIZED", { message: `no token payload` });
	if (opts.scopes) {
		const validScopes = new Set(payload.scope?.split(" "));
		for (const sc of opts.scopes) if (!validScopes.has(sc)) throw new APIError$1("FORBIDDEN", { message: `invalid scope ${sc}` });
	}
	return payload;
}
//#endregion
export { APIError, BASE_ERROR_CODES, BetterAuthError, ENV, HIDE_METADATA, TTY_COLORS, accountSchema, applyDefaultAccessTokenExpiry, authorizationCodeRequest, betterAuth, clientCredentialsToken, clientCredentialsTokenRequest, coreSchema, createAuthorizationCodeRequest, createAuthorizationURL, createClientCredentialsTokenRequest, createLogger, createRefreshAccessTokenRequest, createTelemetry, defineErrorCodes, env, generateCodeChallenge, generateGenericState, generateId, generateState, getAuthTables, getBaseURL, getBooleanEnvVar, getColorDepth, getCurrentAdapter, getEnvVar, getHost, getHostFromSource, getJwks, getOAuth2Tokens, getOrigin, getPrimaryClientId, getProtocol, getProtocolFromSource, getTelemetryAuthConfig, isDevelopment, isDynamicBaseURLConfig, isProduction, isRequestLike, isTest, levels, logger, matchesHostPattern, nodeENV, parseGenericState, parseState, rateLimitSchema, refreshAccessToken, refreshAccessTokenRequest, resolveBaseURL, resolveDynamicBaseURL, safeJSONParse, sessionSchema, shouldPublishLog, trimTrailingSlashes, userSchema, validateAuthorizationCode, validateToken, verificationSchema, verifyAccessToken, verifyJwsAccessToken };
