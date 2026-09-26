import { d as tryDecode, n as decodeURIComponent_ } from "./url-DqZZhS7I.js";
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/hono@4.12.30/node_modules/hono/dist/utils/cookie.js
var algorithm = {
	name: "HMAC",
	hash: "SHA-256"
};
var getCryptoKey = async (secret) => {
	const secretBuf = typeof secret === "string" ? new TextEncoder().encode(secret) : secret;
	return await crypto.subtle.importKey("raw", secretBuf, algorithm, false, ["sign", "verify"]);
};
var makeSignature = async (value, secret) => {
	const key = await getCryptoKey(secret);
	const signature = await crypto.subtle.sign(algorithm.name, key, new TextEncoder().encode(value));
	return btoa(String.fromCharCode(...new Uint8Array(signature)));
};
var verifySignature = async (base64Signature, value, secret) => {
	try {
		const signatureBinStr = atob(base64Signature);
		const signature = new Uint8Array(signatureBinStr.length);
		for (let i = 0, len = signatureBinStr.length; i < len; i++) signature[i] = signatureBinStr.charCodeAt(i);
		return await crypto.subtle.verify(algorithm, secret, signature, new TextEncoder().encode(value));
	} catch {
		return false;
	}
};
var validCookieNameRegEx = /^[\w!#$%&'*.^`|~+-]+$/;
var validCookieValueRegEx = /^[ !#-:<-[\]-~]*$/;
var trimCookieWhitespace = (value) => {
	let start = 0;
	let end = value.length;
	while (start < end) {
		const charCode = value.charCodeAt(start);
		if (charCode !== 32 && charCode !== 9) break;
		start++;
	}
	while (end > start) {
		const charCode = value.charCodeAt(end - 1);
		if (charCode !== 32 && charCode !== 9) break;
		end--;
	}
	return start === 0 && end === value.length ? value : value.slice(start, end);
};
var parse = (cookie, name) => {
	if (name && cookie.indexOf(name) === -1) return {};
	const pairs = cookie.split(";");
	const parsedCookie = /* @__PURE__ */ Object.create(null);
	for (const pairStr of pairs) {
		const valueStartPos = pairStr.indexOf("=");
		if (valueStartPos === -1) continue;
		const cookieName = trimCookieWhitespace(pairStr.substring(0, valueStartPos));
		if (name && name !== cookieName || !validCookieNameRegEx.test(cookieName) || cookieName in parsedCookie) continue;
		let cookieValue = trimCookieWhitespace(pairStr.substring(valueStartPos + 1));
		if (cookieValue.startsWith("\"") && cookieValue.endsWith("\"")) cookieValue = cookieValue.slice(1, -1);
		if (validCookieValueRegEx.test(cookieValue)) {
			parsedCookie[cookieName] = cookieValue.indexOf("%") !== -1 ? tryDecode(cookieValue, decodeURIComponent_) : cookieValue;
			if (name) break;
		}
	}
	return parsedCookie;
};
var parseSigned = async (cookie, secret, name) => {
	const parsedCookie = /* @__PURE__ */ Object.create(null);
	const secretKey = await getCryptoKey(secret);
	for (const [key, value] of Object.entries(parse(cookie, name))) {
		const signatureStartPos = value.lastIndexOf(".");
		if (signatureStartPos < 1) continue;
		const signedValue = value.substring(0, signatureStartPos);
		const signature = value.substring(signatureStartPos + 1);
		if (signature.length !== 44 || !signature.endsWith("=")) continue;
		parsedCookie[key] = await verifySignature(signature, signedValue, secretKey) ? signedValue : false;
	}
	return parsedCookie;
};
var _serialize = (name, value, opt = {}) => {
	if (!validCookieNameRegEx.test(name)) throw new Error("Invalid cookie name");
	let cookie = `${name}=${value}`;
	if (name.startsWith("__Secure-") && !opt.secure) throw new Error("__Secure- Cookie must have Secure attributes");
	if (name.startsWith("__Host-")) {
		if (!opt.secure) throw new Error("__Host- Cookie must have Secure attributes");
		if (opt.path !== "/") throw new Error("__Host- Cookie must have Path attributes with \"/\"");
		if (opt.domain) throw new Error("__Host- Cookie must not have Domain attributes");
	}
	for (const key of [
		"domain",
		"path",
		"sameSite",
		"priority"
	]) if (opt[key] && /[;\r\n]/.test(opt[key])) throw new Error(`${key} must not contain ";", "\\r", or "\\n"`);
	if (opt && typeof opt.maxAge === "number" && opt.maxAge >= 0) {
		if (opt.maxAge > 3456e4) throw new Error("Cookies Max-Age SHOULD NOT be greater than 400 days (34560000 seconds) in duration.");
		cookie += `; Max-Age=${opt.maxAge | 0}`;
	}
	if (opt.domain && opt.prefix !== "host") cookie += `; Domain=${opt.domain}`;
	if (opt.path) cookie += `; Path=${opt.path}`;
	if (opt.expires) {
		if (opt.expires.getTime() - Date.now() > 3456e7) throw new Error("Cookies Expires SHOULD NOT be greater than 400 days (34560000 seconds) in the future.");
		cookie += `; Expires=${opt.expires.toUTCString()}`;
	}
	if (opt.httpOnly) cookie += "; HttpOnly";
	if (opt.secure) cookie += "; Secure";
	if (opt.sameSite) cookie += `; SameSite=${opt.sameSite.charAt(0).toUpperCase() + opt.sameSite.slice(1)}`;
	if (opt.priority) cookie += `; Priority=${opt.priority.charAt(0).toUpperCase() + opt.priority.slice(1)}`;
	if (opt.partitioned) {
		if (!opt.secure) throw new Error("Partitioned Cookie must have Secure attributes");
		cookie += "; Partitioned";
	}
	return cookie;
};
var serialize = (name, value, opt) => {
	value = encodeURIComponent(value);
	return _serialize(name, value, opt);
};
var serializeSigned = async (name, value, secret, opt = {}) => {
	const signature = await makeSignature(value, secret);
	value = `${value}.${signature}`;
	value = encodeURIComponent(value);
	return _serialize(name, value, opt);
};
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/hono@4.12.30/node_modules/hono/dist/helper/cookie/index.js
var getCookie = (c, key, prefix) => {
	const cookie = c.req.raw.headers.get("Cookie");
	if (typeof key === "string") {
		if (!cookie) return;
		let finalKey = key;
		if (prefix === "secure") finalKey = "__Secure-" + key;
		else if (prefix === "host") finalKey = "__Host-" + key;
		return parse(cookie, finalKey)[finalKey];
	}
	if (!cookie) return {};
	return parse(cookie);
};
var getSignedCookie = async (c, secret, key, prefix) => {
	const cookie = c.req.raw.headers.get("Cookie");
	if (typeof key === "string") {
		if (!cookie) return;
		let finalKey = key;
		if (prefix === "secure") finalKey = "__Secure-" + key;
		else if (prefix === "host") finalKey = "__Host-" + key;
		return (await parseSigned(cookie, secret, finalKey))[finalKey];
	}
	if (!cookie) return {};
	return await parseSigned(cookie, secret);
};
var generateCookie = (name, value, opt) => {
	let cookie;
	if (opt?.prefix === "secure") cookie = serialize("__Secure-" + name, value, {
		path: "/",
		...opt,
		secure: true
	});
	else if (opt?.prefix === "host") cookie = serialize("__Host-" + name, value, {
		...opt,
		path: "/",
		secure: true,
		domain: void 0
	});
	else cookie = serialize(name, value, {
		path: "/",
		...opt
	});
	return cookie;
};
var setCookie = (c, name, value, opt) => {
	const cookie = generateCookie(name, value, opt);
	c.header("Set-Cookie", cookie, { append: true });
};
var generateSignedCookie = async (name, value, secret, opt) => {
	let cookie;
	if (opt?.prefix === "secure") cookie = await serializeSigned("__Secure-" + name, value, secret, {
		path: "/",
		...opt,
		secure: true
	});
	else if (opt?.prefix === "host") cookie = await serializeSigned("__Host-" + name, value, secret, {
		...opt,
		path: "/",
		secure: true,
		domain: void 0
	});
	else cookie = await serializeSigned(name, value, secret, {
		path: "/",
		...opt
	});
	return cookie;
};
var setSignedCookie = async (c, name, value, secret, opt) => {
	const cookie = await generateSignedCookie(name, value, secret, opt);
	c.header("set-cookie", cookie, { append: true });
};
var deleteCookie = (c, name, opt) => {
	const deletedCookie = getCookie(c, name, opt?.prefix);
	setCookie(c, name, "", {
		...opt,
		maxAge: 0
	});
	return deletedCookie;
};
//#endregion
export { deleteCookie, generateCookie, generateSignedCookie, getCookie, getSignedCookie, setCookie, setSignedCookie };
