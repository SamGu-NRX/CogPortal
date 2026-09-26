import { Kt as entityKind } from "./relations-DcOpytzY.js";
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/drizzle-orm@0.45.2_@cloudflare+workers-types@5.20260713.1_kysely@0.29.3/node_modules/drizzle-orm/logger.js
var ConsoleLogWriter = class {
	static [entityKind] = "ConsoleLogWriter";
	write(message) {
		console.log(message);
	}
};
var DefaultLogger = class {
	static [entityKind] = "DefaultLogger";
	writer;
	constructor(config) {
		this.writer = config?.writer ?? new ConsoleLogWriter();
	}
	logQuery(query, params) {
		const stringifiedParams = params.map((p) => {
			try {
				return JSON.stringify(p);
			} catch {
				return String(p);
			}
		});
		const paramsStr = stringifiedParams.length ? ` -- params: [${stringifiedParams.join(", ")}]` : "";
		this.writer.write(`Query: ${query}${paramsStr}`);
	}
};
var NoopLogger = class {
	static [entityKind] = "NoopLogger";
	logQuery() {}
};
//#endregion
export { DefaultLogger as n, NoopLogger as r, ConsoleLogWriter as t };
