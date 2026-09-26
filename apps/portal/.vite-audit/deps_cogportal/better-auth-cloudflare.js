import { Bt as boolean, Fn as object, Ft as any, It as array, Jt as date, Pn as number, Un as record, jt as _instanceof, qn as string } from "./zod-DJgnLRfl.js";
import { M as createAuthEndpoint, O as getSessionFromCtx, k as sessionMiddleware } from "./api-B6O-7oy9.js";
import { drizzleAdapter } from "./@better-auth_drizzle-adapter.js";
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth-cloudflare@0.3.0_@better-auth+drizzle-adapter@1.6.23_@better-auth+core@1.6._ccc1e0386c2c691447ec088d98816cbf/node_modules/better-auth-cloudflare/dist/schema.mjs
var geolocationFields = {
	timezone: {
		type: "string",
		required: false,
		input: false
	},
	city: {
		type: "string",
		required: false,
		input: false
	},
	country: {
		type: "string",
		required: false,
		input: false
	},
	region: {
		type: "string",
		required: false,
		input: false
	},
	regionCode: {
		type: "string",
		required: false,
		input: false
	},
	colo: {
		type: "string",
		required: false,
		input: false
	},
	latitude: {
		type: "string",
		required: false,
		input: false
	},
	longitude: {
		type: "string",
		required: false,
		input: false
	}
};
var coreFileFields = {
	userId: {
		type: "string",
		required: true,
		input: false,
		references: {
			model: "user",
			field: "id"
		}
	},
	filename: {
		type: "string",
		required: true,
		input: false
	},
	originalName: {
		type: "string",
		required: true,
		input: false
	},
	contentType: {
		type: "string",
		required: true,
		input: false
	},
	size: {
		type: "number",
		required: true,
		input: false
	},
	r2Key: {
		type: "string",
		required: true,
		input: false
	},
	uploadedAt: {
		type: "date",
		required: true,
		input: false
	}
};
function generateFileFields(additionalFields) {
	const fields = { ...coreFileFields };
	if (additionalFields) for (const [fieldName, fieldConfig] of Object.entries(additionalFields)) fields[fieldName] = fieldConfig;
	return fields;
}
var schema = (options) => {
	const authSchema = { session: { fields: options.geolocationTracking === void 0 || options.geolocationTracking === true ? geolocationFields : {} } };
	if (options.r2) authSchema.userFile = { fields: generateFileFields(options.r2.additionalFields) };
	return authSchema;
};
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/mime@4.1.0/node_modules/mime/dist/types/standard.js
var types = {
	"application/andrew-inset": ["ez"],
	"application/appinstaller": ["appinstaller"],
	"application/applixware": ["aw"],
	"application/appx": ["appx"],
	"application/appxbundle": ["appxbundle"],
	"application/atom+xml": ["atom"],
	"application/atomcat+xml": ["atomcat"],
	"application/atomdeleted+xml": ["atomdeleted"],
	"application/atomsvc+xml": ["atomsvc"],
	"application/atsc-dwd+xml": ["dwd"],
	"application/atsc-held+xml": ["held"],
	"application/atsc-rsat+xml": ["rsat"],
	"application/automationml-aml+xml": ["aml"],
	"application/automationml-amlx+zip": ["amlx"],
	"application/bdoc": ["bdoc"],
	"application/calendar+xml": ["xcs"],
	"application/ccxml+xml": ["ccxml"],
	"application/cdfx+xml": ["cdfx"],
	"application/cdmi-capability": ["cdmia"],
	"application/cdmi-container": ["cdmic"],
	"application/cdmi-domain": ["cdmid"],
	"application/cdmi-object": ["cdmio"],
	"application/cdmi-queue": ["cdmiq"],
	"application/cpl+xml": ["cpl"],
	"application/cu-seeme": ["cu"],
	"application/cwl": ["cwl"],
	"application/dash+xml": ["mpd"],
	"application/dash-patch+xml": ["mpp"],
	"application/davmount+xml": ["davmount"],
	"application/dicom": ["dcm"],
	"application/docbook+xml": ["dbk"],
	"application/dssc+der": ["dssc"],
	"application/dssc+xml": ["xdssc"],
	"application/ecmascript": ["ecma"],
	"application/emma+xml": ["emma"],
	"application/emotionml+xml": ["emotionml"],
	"application/epub+zip": ["epub"],
	"application/exi": ["exi"],
	"application/express": ["exp"],
	"application/fdf": ["fdf"],
	"application/fdt+xml": ["fdt"],
	"application/font-tdpfr": ["pfr"],
	"application/geo+json": ["geojson"],
	"application/gml+xml": ["gml"],
	"application/gpx+xml": ["gpx"],
	"application/gxf": ["gxf"],
	"application/gzip": ["gz"],
	"application/hjson": ["hjson"],
	"application/hyperstudio": ["stk"],
	"application/inkml+xml": ["ink", "inkml"],
	"application/ipfix": ["ipfix"],
	"application/its+xml": ["its"],
	"application/java-archive": [
		"jar",
		"war",
		"ear"
	],
	"application/java-serialized-object": ["ser"],
	"application/java-vm": ["class"],
	"application/javascript": ["*js"],
	"application/json": ["json", "map"],
	"application/json5": ["json5"],
	"application/jsonml+json": ["jsonml"],
	"application/ld+json": ["jsonld"],
	"application/lgr+xml": ["lgr"],
	"application/lost+xml": ["lostxml"],
	"application/mac-binhex40": ["hqx"],
	"application/mac-compactpro": ["cpt"],
	"application/mads+xml": ["mads"],
	"application/manifest+json": ["webmanifest"],
	"application/marc": ["mrc"],
	"application/marcxml+xml": ["mrcx"],
	"application/mathematica": [
		"ma",
		"nb",
		"mb"
	],
	"application/mathml+xml": ["mathml"],
	"application/mbox": ["mbox"],
	"application/media-policy-dataset+xml": ["mpf"],
	"application/mediaservercontrol+xml": ["mscml"],
	"application/metalink+xml": ["metalink"],
	"application/metalink4+xml": ["meta4"],
	"application/mets+xml": ["mets"],
	"application/mmt-aei+xml": ["maei"],
	"application/mmt-usd+xml": ["musd"],
	"application/mods+xml": ["mods"],
	"application/mp21": ["m21", "mp21"],
	"application/mp4": [
		"*mp4",
		"*mpg4",
		"mp4s",
		"m4p"
	],
	"application/msix": ["msix"],
	"application/msixbundle": ["msixbundle"],
	"application/msword": ["doc", "dot"],
	"application/mxf": ["mxf"],
	"application/n-quads": ["nq"],
	"application/n-triples": ["nt"],
	"application/node": ["cjs"],
	"application/octet-stream": [
		"bin",
		"dms",
		"lrf",
		"mar",
		"so",
		"dist",
		"distz",
		"pkg",
		"bpk",
		"dump",
		"elc",
		"deploy",
		"exe",
		"dll",
		"deb",
		"dmg",
		"iso",
		"img",
		"msi",
		"msp",
		"msm",
		"buffer"
	],
	"application/oda": ["oda"],
	"application/oebps-package+xml": ["opf"],
	"application/ogg": ["ogx"],
	"application/omdoc+xml": ["omdoc"],
	"application/onenote": [
		"onetoc",
		"onetoc2",
		"onetmp",
		"onepkg",
		"one",
		"onea"
	],
	"application/oxps": ["oxps"],
	"application/p2p-overlay+xml": ["relo"],
	"application/patch-ops-error+xml": ["xer"],
	"application/pdf": ["pdf"],
	"application/pgp-encrypted": ["pgp"],
	"application/pgp-keys": ["asc"],
	"application/pgp-signature": ["sig", "*asc"],
	"application/pics-rules": ["prf"],
	"application/pkcs10": ["p10"],
	"application/pkcs7-mime": ["p7m", "p7c"],
	"application/pkcs7-signature": ["p7s"],
	"application/pkcs8": ["p8"],
	"application/pkix-attr-cert": ["ac"],
	"application/pkix-cert": ["cer"],
	"application/pkix-crl": ["crl"],
	"application/pkix-pkipath": ["pkipath"],
	"application/pkixcmp": ["pki"],
	"application/pls+xml": ["pls"],
	"application/postscript": [
		"ai",
		"eps",
		"ps"
	],
	"application/provenance+xml": ["provx"],
	"application/pskc+xml": ["pskcxml"],
	"application/raml+yaml": ["raml"],
	"application/rdf+xml": ["rdf", "owl"],
	"application/reginfo+xml": ["rif"],
	"application/relax-ng-compact-syntax": ["rnc"],
	"application/resource-lists+xml": ["rl"],
	"application/resource-lists-diff+xml": ["rld"],
	"application/rls-services+xml": ["rs"],
	"application/route-apd+xml": ["rapd"],
	"application/route-s-tsid+xml": ["sls"],
	"application/route-usd+xml": ["rusd"],
	"application/rpki-ghostbusters": ["gbr"],
	"application/rpki-manifest": ["mft"],
	"application/rpki-roa": ["roa"],
	"application/rsd+xml": ["rsd"],
	"application/rss+xml": ["rss"],
	"application/rtf": ["rtf"],
	"application/sbml+xml": ["sbml"],
	"application/scvp-cv-request": ["scq"],
	"application/scvp-cv-response": ["scs"],
	"application/scvp-vp-request": ["spq"],
	"application/scvp-vp-response": ["spp"],
	"application/sdp": ["sdp"],
	"application/senml+xml": ["senmlx"],
	"application/sensml+xml": ["sensmlx"],
	"application/set-payment-initiation": ["setpay"],
	"application/set-registration-initiation": ["setreg"],
	"application/shf+xml": ["shf"],
	"application/sieve": ["siv", "sieve"],
	"application/smil+xml": ["smi", "smil"],
	"application/sparql-query": ["rq"],
	"application/sparql-results+xml": ["srx"],
	"application/sql": ["sql"],
	"application/srgs": ["gram"],
	"application/srgs+xml": ["grxml"],
	"application/sru+xml": ["sru"],
	"application/ssdl+xml": ["ssdl"],
	"application/ssml+xml": ["ssml"],
	"application/swid+xml": ["swidtag"],
	"application/tei+xml": ["tei", "teicorpus"],
	"application/thraud+xml": ["tfi"],
	"application/timestamped-data": ["tsd"],
	"application/toml": ["toml"],
	"application/trig": ["trig"],
	"application/ttml+xml": ["ttml"],
	"application/ubjson": ["ubj"],
	"application/urc-ressheet+xml": ["rsheet"],
	"application/urc-targetdesc+xml": ["td"],
	"application/voicexml+xml": ["vxml"],
	"application/wasm": ["wasm"],
	"application/watcherinfo+xml": ["wif"],
	"application/widget": ["wgt"],
	"application/winhlp": ["hlp"],
	"application/wsdl+xml": ["wsdl"],
	"application/wspolicy+xml": ["wspolicy"],
	"application/xaml+xml": ["xaml"],
	"application/xcap-att+xml": ["xav"],
	"application/xcap-caps+xml": ["xca"],
	"application/xcap-diff+xml": ["xdf"],
	"application/xcap-el+xml": ["xel"],
	"application/xcap-ns+xml": ["xns"],
	"application/xenc+xml": ["xenc"],
	"application/xfdf": ["xfdf"],
	"application/xhtml+xml": ["xhtml", "xht"],
	"application/xliff+xml": ["xlf"],
	"application/xml": [
		"xml",
		"xsl",
		"xsd",
		"rng"
	],
	"application/xml-dtd": ["dtd"],
	"application/xop+xml": ["xop"],
	"application/xproc+xml": ["xpl"],
	"application/xslt+xml": ["*xsl", "xslt"],
	"application/xspf+xml": ["xspf"],
	"application/xv+xml": [
		"mxml",
		"xhvml",
		"xvml",
		"xvm"
	],
	"application/yang": ["yang"],
	"application/yin+xml": ["yin"],
	"application/zip": ["zip"],
	"application/zip+dotlottie": ["lottie"],
	"audio/3gpp": ["*3gpp"],
	"audio/aac": ["adts", "aac"],
	"audio/adpcm": ["adp"],
	"audio/amr": ["amr"],
	"audio/basic": ["au", "snd"],
	"audio/midi": [
		"mid",
		"midi",
		"kar",
		"rmi"
	],
	"audio/mobile-xmf": ["mxmf"],
	"audio/mp3": ["*mp3"],
	"audio/mp4": [
		"m4a",
		"mp4a",
		"m4b"
	],
	"audio/mpeg": [
		"mpga",
		"mp2",
		"mp2a",
		"mp3",
		"m2a",
		"m3a"
	],
	"audio/ogg": [
		"oga",
		"ogg",
		"spx",
		"opus"
	],
	"audio/s3m": ["s3m"],
	"audio/silk": ["sil"],
	"audio/wav": ["wav"],
	"audio/wave": ["*wav"],
	"audio/webm": ["weba"],
	"audio/xm": ["xm"],
	"font/collection": ["ttc"],
	"font/otf": ["otf"],
	"font/ttf": ["ttf"],
	"font/woff": ["woff"],
	"font/woff2": ["woff2"],
	"image/aces": ["exr"],
	"image/apng": ["apng"],
	"image/avci": ["avci"],
	"image/avcs": ["avcs"],
	"image/avif": ["avif"],
	"image/bmp": ["bmp", "dib"],
	"image/cgm": ["cgm"],
	"image/dicom-rle": ["drle"],
	"image/dpx": ["dpx"],
	"image/emf": ["emf"],
	"image/fits": ["fits"],
	"image/g3fax": ["g3"],
	"image/gif": ["gif"],
	"image/heic": ["heic"],
	"image/heic-sequence": ["heics"],
	"image/heif": ["heif"],
	"image/heif-sequence": ["heifs"],
	"image/hej2k": ["hej2"],
	"image/ief": ["ief"],
	"image/jaii": ["jaii"],
	"image/jais": ["jais"],
	"image/jls": ["jls"],
	"image/jp2": ["jp2", "jpg2"],
	"image/jpeg": [
		"jpg",
		"jpeg",
		"jpe"
	],
	"image/jph": ["jph"],
	"image/jphc": ["jhc"],
	"image/jpm": ["jpm", "jpgm"],
	"image/jpx": ["jpx", "jpf"],
	"image/jxl": ["jxl"],
	"image/jxr": ["jxr"],
	"image/jxra": ["jxra"],
	"image/jxrs": ["jxrs"],
	"image/jxs": ["jxs"],
	"image/jxsc": ["jxsc"],
	"image/jxsi": ["jxsi"],
	"image/jxss": ["jxss"],
	"image/ktx": ["ktx"],
	"image/ktx2": ["ktx2"],
	"image/pjpeg": ["jfif"],
	"image/png": ["png"],
	"image/sgi": ["sgi"],
	"image/svg+xml": ["svg", "svgz"],
	"image/t38": ["t38"],
	"image/tiff": ["tif", "tiff"],
	"image/tiff-fx": ["tfx"],
	"image/webp": ["webp"],
	"image/wmf": ["wmf"],
	"message/disposition-notification": ["disposition-notification"],
	"message/global": ["u8msg"],
	"message/global-delivery-status": ["u8dsn"],
	"message/global-disposition-notification": ["u8mdn"],
	"message/global-headers": ["u8hdr"],
	"message/rfc822": [
		"eml",
		"mime",
		"mht",
		"mhtml"
	],
	"model/3mf": ["3mf"],
	"model/gltf+json": ["gltf"],
	"model/gltf-binary": ["glb"],
	"model/iges": ["igs", "iges"],
	"model/jt": ["jt"],
	"model/mesh": [
		"msh",
		"mesh",
		"silo"
	],
	"model/mtl": ["mtl"],
	"model/obj": ["obj"],
	"model/prc": ["prc"],
	"model/step": [
		"step",
		"stp",
		"stpnc",
		"p21",
		"210"
	],
	"model/step+xml": ["stpx"],
	"model/step+zip": ["stpz"],
	"model/step-xml+zip": ["stpxz"],
	"model/stl": ["stl"],
	"model/u3d": ["u3d"],
	"model/vrml": ["wrl", "vrml"],
	"model/x3d+binary": ["*x3db", "x3dbz"],
	"model/x3d+fastinfoset": ["x3db"],
	"model/x3d+vrml": ["*x3dv", "x3dvz"],
	"model/x3d+xml": ["x3d", "x3dz"],
	"model/x3d-vrml": ["x3dv"],
	"text/cache-manifest": ["appcache", "manifest"],
	"text/calendar": ["ics", "ifb"],
	"text/coffeescript": ["coffee", "litcoffee"],
	"text/css": ["css"],
	"text/csv": ["csv"],
	"text/html": [
		"html",
		"htm",
		"shtml"
	],
	"text/jade": ["jade"],
	"text/javascript": ["js", "mjs"],
	"text/jsx": ["jsx"],
	"text/less": ["less"],
	"text/markdown": ["md", "markdown"],
	"text/mathml": ["mml"],
	"text/mdx": ["mdx"],
	"text/n3": ["n3"],
	"text/plain": [
		"txt",
		"text",
		"conf",
		"def",
		"list",
		"log",
		"in",
		"ini"
	],
	"text/richtext": ["rtx"],
	"text/rtf": ["*rtf"],
	"text/sgml": ["sgml", "sgm"],
	"text/shex": ["shex"],
	"text/slim": ["slim", "slm"],
	"text/spdx": ["spdx"],
	"text/stylus": ["stylus", "styl"],
	"text/tab-separated-values": ["tsv"],
	"text/troff": [
		"t",
		"tr",
		"roff",
		"man",
		"me",
		"ms"
	],
	"text/turtle": ["ttl"],
	"text/uri-list": [
		"uri",
		"uris",
		"urls"
	],
	"text/vcard": ["vcard"],
	"text/vtt": ["vtt"],
	"text/wgsl": ["wgsl"],
	"text/xml": ["*xml"],
	"text/yaml": ["yaml", "yml"],
	"video/3gpp": ["3gp", "3gpp"],
	"video/3gpp2": ["3g2"],
	"video/h261": ["h261"],
	"video/h263": ["h263"],
	"video/h264": ["h264"],
	"video/iso.segment": ["m4s"],
	"video/jpeg": ["jpgv"],
	"video/jpm": ["*jpm", "*jpgm"],
	"video/mj2": ["mj2", "mjp2"],
	"video/mp2t": [
		"ts",
		"m2t",
		"m2ts",
		"mts"
	],
	"video/mp4": [
		"mp4",
		"mp4v",
		"mpg4"
	],
	"video/mpeg": [
		"mpeg",
		"mpg",
		"mpe",
		"m1v",
		"m2v"
	],
	"video/ogg": ["ogv"],
	"video/quicktime": ["qt", "mov"],
	"video/webm": ["webm"]
};
Object.freeze(types);
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/mime@4.1.0/node_modules/mime/dist/src/Mime.js
var __classPrivateFieldGet = function(receiver, state, kind, f) {
	if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
	if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
	return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _Mime_extensionToType;
var _Mime_typeToExtension;
var _Mime_typeToExtensions;
var Mime = class {
	constructor(...args) {
		_Mime_extensionToType.set(this, /* @__PURE__ */ new Map());
		_Mime_typeToExtension.set(this, /* @__PURE__ */ new Map());
		_Mime_typeToExtensions.set(this, /* @__PURE__ */ new Map());
		for (const arg of args) this.define(arg);
	}
	define(typeMap, force = false) {
		for (let [type, extensions] of Object.entries(typeMap)) {
			type = type.toLowerCase();
			extensions = extensions.map((ext) => ext.toLowerCase());
			if (!__classPrivateFieldGet(this, _Mime_typeToExtensions, "f").has(type)) __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").set(type, /* @__PURE__ */ new Set());
			const allExtensions = __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").get(type);
			let first = true;
			for (let extension of extensions) {
				const starred = extension.startsWith("*");
				extension = starred ? extension.slice(1) : extension;
				allExtensions?.add(extension);
				if (first) __classPrivateFieldGet(this, _Mime_typeToExtension, "f").set(type, extension);
				first = false;
				if (starred) continue;
				const currentType = __classPrivateFieldGet(this, _Mime_extensionToType, "f").get(extension);
				if (currentType && currentType != type && !force) throw new Error(`"${type} -> ${extension}" conflicts with "${currentType} -> ${extension}". Pass \`force=true\` to override this definition.`);
				__classPrivateFieldGet(this, _Mime_extensionToType, "f").set(extension, type);
			}
		}
		return this;
	}
	getType(path) {
		if (typeof path !== "string") return null;
		const last = path.replace(/^.*[/\\]/s, "").toLowerCase();
		const ext = last.replace(/^.*\./s, "").toLowerCase();
		const hasPath = last.length < path.length;
		if (!(ext.length < last.length - 1) && hasPath) return null;
		return __classPrivateFieldGet(this, _Mime_extensionToType, "f").get(ext) ?? null;
	}
	getExtension(type) {
		if (typeof type !== "string") return null;
		type = type?.split?.(";")[0];
		return (type && __classPrivateFieldGet(this, _Mime_typeToExtension, "f").get(type.trim().toLowerCase())) ?? null;
	}
	getAllExtensions(type) {
		if (typeof type !== "string") return null;
		return __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").get(type.toLowerCase()) ?? null;
	}
	_freeze() {
		this.define = () => {
			throw new Error("define() not allowed for built-in Mime objects. See https://github.com/broofa/mime/blob/main/README.md#custom-mime-instances");
		};
		Object.freeze(this);
		for (const extensions of __classPrivateFieldGet(this, _Mime_typeToExtensions, "f").values()) Object.freeze(extensions);
		return this;
	}
	_getTestState() {
		return {
			types: __classPrivateFieldGet(this, _Mime_extensionToType, "f"),
			extensions: __classPrivateFieldGet(this, _Mime_typeToExtension, "f")
		};
	}
};
_Mime_extensionToType = /* @__PURE__ */ new WeakMap(), _Mime_typeToExtension = /* @__PURE__ */ new WeakMap(), _Mime_typeToExtensions = /* @__PURE__ */ new WeakMap();
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/mime@4.1.0/node_modules/mime/dist/src/index_lite.js
var index_lite_default = new Mime(types)._freeze();
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth-cloudflare@0.3.0_@better-auth+drizzle-adapter@1.6.23_@better-auth+core@1.6._ccc1e0386c2c691447ec088d98816cbf/node_modules/better-auth-cloudflare/dist/r2.mjs
var R2_ERROR_CODES = {
	FILE_TOO_LARGE: "File is too large. Please choose a smaller file",
	INVALID_FILE_TYPE: "File type not supported. Please choose a different file",
	NO_FILE_PROVIDED: "Please select a file to upload",
	INVALID_REQUEST: "Invalid request. Please try again",
	R2_STORAGE_NOT_CONFIGURED: "File storage is temporarily unavailable. Please try again later",
	UPLOAD_FAILED: "Upload failed. Please check your connection and try again",
	FILE_ID_REQUIRED: "File not found",
	LIST_FILES_FAILED: "Unable to load your files. Please refresh the page",
	INVALID_METADATA: "Invalid file information. Please try uploading again",
	UPLOAD_ROLLBACK_FAILED: "Upload failed. Please try again",
	INVALID_FILE_RECORD: "File information is corrupted. Please contact support",
	DB_OPERATION_FAILED: "Service temporarily unavailable. Please try again later"
};
var success = (data) => ({
	success: true,
	data
});
var error = (message, code) => ({
	success: false,
	error: message,
	code
});
function validateFileMetadata(record) {
	if (!record || typeof record !== "object") return false;
	if (typeof record.id !== "string" || typeof record.userId !== "string" || typeof record.filename !== "string" || typeof record.originalName !== "string" || typeof record.contentType !== "string" || typeof record.r2Key !== "string") return false;
	if (typeof record.size !== "number") return false;
	if (record.uploadedAt) {
		const date = record.uploadedAt instanceof Date ? record.uploadedAt : new Date(record.uploadedAt);
		if (isNaN(date.getTime())) return false;
		if (!(record.uploadedAt instanceof Date)) record.uploadedAt = date;
	} else return false;
	return true;
}
function convertFieldAttributesToZodSchema(additionalFields) {
	const zodSchema = {};
	for (const [key, value] of Object.entries(additionalFields)) {
		let fieldSchema;
		if (value.type === "string") fieldSchema = string();
		else if (value.type === "number") fieldSchema = number();
		else if (value.type === "boolean") fieldSchema = boolean();
		else if (value.type === "date") fieldSchema = date();
		else if (value.type === "string[]") fieldSchema = array(string());
		else if (value.type === "number[]") fieldSchema = array(number());
		else throw new Error(`Unsupported field type: ${value.type} for field ${key}`);
		if (!value.required) fieldSchema = fieldSchema.optional();
		zodSchema[key] = fieldSchema;
	}
	return object(zodSchema);
}
var createFileMetadataSchema = (additionalFields) => {
	if (!additionalFields || Object.keys(additionalFields).length === 0) return record(string(), any()).optional();
	return convertFieldAttributesToZodSchema(additionalFields).optional();
};
var fileIdSchema = object({ fileId: string().min(1, "File ID is required") });
var listFilesSchema = object({
	limit: number().min(1).max(100).optional(),
	cursor: string().optional()
}).optional();
var createUploadFileSchema = (additionalFields) => {
	const baseShape = { file: _instanceof(File) };
	if (!additionalFields || Object.keys(additionalFields).length === 0) return object(baseShape);
	for (const [key, value] of Object.entries(additionalFields)) {
		let fieldSchema;
		if (value.type === "string") fieldSchema = string();
		else if (value.type === "number") fieldSchema = number();
		else if (value.type === "boolean") fieldSchema = boolean();
		else if (value.type === "date") fieldSchema = date();
		else if (value.type === "string[]") fieldSchema = array(string());
		else if (value.type === "number[]") fieldSchema = array(number());
		else throw new Error(`Unsupported field type: ${value.type} for field ${key}`);
		if (!value.required) fieldSchema = fieldSchema.optional();
		baseShape[key] = fieldSchema;
	}
	return object(baseShape);
};
var sanitizeFilename = (filename) => {
	return filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 255);
};
var createFileValidator = (config) => {
	const { maxFileSize = 10485760, allowedTypes } = config;
	return {
		validateFile: (file, ctx) => {
			if (file.size > maxFileSize) {
				const maxSizeMB = Math.round(maxFileSize / (1024 * 1024));
				const errorMsg = `${R2_ERROR_CODES.FILE_TOO_LARGE} (max ${maxSizeMB}MB)`;
				ctx?.logger?.error(`[R2]: File size validation failed:`, errorMsg);
				return error(errorMsg, "FILE_TOO_LARGE");
			}
			if (allowedTypes && allowedTypes.length > 0) {
				if (!file.name) {
					const errorMsg = "File must have a name when file type restrictions are enabled";
					ctx?.logger?.error(`[R2]: File name validation failed:`, errorMsg);
					return error(errorMsg, "INVALID_FILE_NAME");
				}
				const getFileExtension = (filename) => {
					const lastDotIndex = filename.lastIndexOf(".");
					return lastDotIndex === -1 ? "" : filename.slice(lastDotIndex + 1).toLowerCase();
				};
				const extension = getFileExtension(file.name);
				if (!extension) {
					const errorMsg = "File must have an extension when file type restrictions are enabled";
					ctx?.logger?.error(`[R2]: File extension validation failed:`, errorMsg);
					return error(errorMsg, "INVALID_FILE_EXTENSION");
				}
				if (!allowedTypes.map((type) => type.startsWith(".") ? type.slice(1).toLowerCase() : type.toLowerCase()).includes(extension)) {
					const allowedTypesFormatted = allowedTypes.map((type) => type.startsWith(".") ? type : `.${type}`).join(", ");
					const errorMsg = `${R2_ERROR_CODES.INVALID_FILE_TYPE}. Supported formats: ${allowedTypesFormatted}`;
					ctx?.logger?.error(`[R2]: File type validation failed:`, errorMsg);
					return error(errorMsg, "INVALID_FILE_TYPE");
				}
			}
			return success(true);
		},
		validateMetadata: (metadata, ctx) => {
			const result = createFileMetadataSchema(config.additionalFields).safeParse(metadata);
			if (!result.success) {
				const detailedError = `Invalid metadata: ${result.error.issues.map((err) => {
					return `${err.path.length > 0 ? `${err.path.join(".")}: ` : ""}${err.message}`;
				}).join(", ")}`;
				ctx?.logger?.error(`[R2]: Metadata validation failed:`, {
					error: detailedError,
					metadata,
					zodErrors: result.error.issues
				});
				return error(detailedError, "INVALID_METADATA");
			}
			return success(result.data);
		}
	};
};
var createR2Storage = (config, generateId) => {
	const { bucket } = config;
	const validator = createFileValidator(config);
	return {
		/**
		* Uploads a file to R2 and returns metadata
		*/
		async uploadFile(file, originalName, userId, ctx, customMetadata, modelName) {
			let r2Key = null;
			try {
				const fileForValidation = file instanceof File ? file : new File([file], originalName, { type: file.type });
				const fileValidation = validator.validateFile(fileForValidation, ctx);
				if (!fileValidation.success) throw new Error(fileValidation.error);
				let validatedMetadata = void 0;
				if (customMetadata) {
					const metadataValidation = validator.validateMetadata(customMetadata, ctx);
					if (!metadataValidation.success) throw new Error(metadataValidation.error);
					validatedMetadata = metadataValidation.data;
				}
				const fileId = generateId({ model: modelName || "userFile" });
				if (!fileId) throw new Error("Failed to generate unique file ID. Please try again.");
				const filename = `${fileId}-${sanitizeFilename(originalName)}`;
				r2Key = `user-files/${userId}/${filename}`;
				const metadata = {
					id: fileId,
					userId,
					filename,
					originalName,
					contentType: file.type,
					size: file.size,
					r2Key,
					uploadedAt: /* @__PURE__ */ new Date(),
					...validatedMetadata
				};
				if (config.hooks?.upload?.before) {
					if (await config.hooks.upload.before(Object.assign(fileForValidation, {
						userId,
						r2Key,
						metadata
					}), ctx) === null) throw new Error("Upload prevented by beforeUpload hook");
				}
				ctx?.logger?.info(`[R2]: Uploading file for user "${userId}": ${filename}`);
				const uploadOptions = {
					httpMetadata: { contentType: file.type },
					...validatedMetadata && { customMetadata: Object.fromEntries(Object.entries(validatedMetadata).map(([k, v]) => [k, v === null || v === void 0 ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)])) }
				};
				if (!await bucket.put(r2Key, file, uploadOptions)) throw new Error(R2_ERROR_CODES.UPLOAD_FAILED);
				ctx?.logger?.info(`[R2]: Successfully uploaded file for user "${userId}": ${filename}`);
				if (config.hooks?.upload?.after) await config.hooks.upload.after(metadata, ctx);
				return metadata;
			} catch (error2) {
				if (r2Key) try {
					await bucket.delete(r2Key);
					ctx?.logger?.info(`[R2]: Cleaned up failed upload: ${r2Key}`);
				} catch (cleanupError) {
					ctx?.logger?.error(`[R2]: Failed to cleanup after upload failure:`, cleanupError);
				}
				ctx?.logger?.error(`[R2]: Upload failed for user "${userId}":`, error2);
				throw error2;
			}
		},
		/**
		* Downloads a file from R2
		*/
		async downloadFile(fileMetadata, ctx) {
			const hookData = fileMetadata;
			if (config.hooks?.download?.before) {
				if (await config.hooks.download.before(hookData, ctx) === null) throw new Error("Download prevented by beforeDownload hook");
			}
			const downloadResult = (await bucket.get(fileMetadata.r2Key))?.body || null;
			if (config.hooks?.download?.after) await config.hooks.download.after(hookData, ctx);
			return downloadResult;
		},
		/**
		* Deletes a file from R2
		*/
		async deleteFile(fileMetadata, ctx) {
			const hookData = fileMetadata;
			if (config.hooks?.delete?.before) {
				if (await config.hooks.delete.before(hookData, ctx) === null) throw new Error("Delete prevented by beforeDelete hook");
			}
			await bucket.delete(fileMetadata.r2Key);
			if (config.hooks?.delete?.after) await config.hooks.delete.after(hookData, ctx);
		},
		/**
		* Gets file metadata from R2
		*/
		async getFileInfo(r2Key) {
			return await bucket.head(r2Key);
		},
		/**
		* Lists files for a user
		*/
		async listUserFiles(userId, ctx) {
			if (config.hooks?.list?.before) {
				if (await config.hooks.list.before(userId, ctx) === null) throw new Error("List prevented by beforeList hook");
			}
			const files = await bucket.list({ prefix: `user-files/${userId}/` });
			if (config.hooks?.list?.after) await config.hooks.list.after(userId, files, ctx);
			return files;
		}
	};
};
var validateAuthContext = (ctx) => {
	if (!ctx) throw new Error("Auth context is not available");
	if (!ctx.adapter) throw new Error("Database adapter is not properly configured");
};
var createR2Endpoints = (getR2Storage, r2Config) => {
	const allowedMediaTypes = r2Config?.allowedTypes?.map((type) => index_lite_default.getType(type)).filter((mimeType) => Boolean(mimeType));
	return {
		upload: createAuthEndpoint("/files/upload-raw", {
			method: "POST",
			metadata: { allowedMediaTypes }
		}, async (ctx) => {
			const session = await getSessionFromCtx(ctx);
			if (!session) throw ctx.error("UNAUTHORIZED", { message: "Please sign in to upload files" });
			try {
				validateAuthContext(ctx.context);
			} catch (error2) {
				ctx.context.logger?.error("[R2]: Auth context validation failed:", error2);
				throw ctx.error("INTERNAL_SERVER_ERROR", { message: R2_ERROR_CODES.DB_OPERATION_FAILED });
			}
			try {
				ctx.context.logger?.info("[R2]: Starting blob file upload");
				const r2Storage = getR2Storage();
				if (!r2Storage) {
					ctx.context.logger?.error("[R2]: R2 storage not configured");
					throw ctx.error("INTERNAL_SERVER_ERROR", { message: R2_ERROR_CODES.R2_STORAGE_NOT_CONFIGURED });
				}
				const maxFileSize = r2Config?.maxFileSize || 10485760;
				const contentLength = ctx.request?.headers?.get("content-length");
				if (contentLength) {
					if (parseInt(contentLength, 10) > maxFileSize) {
						const maxSizeMB = Math.round(maxFileSize / (1024 * 1024));
						throw new Error(`${R2_ERROR_CODES.FILE_TOO_LARGE} (max ${maxSizeMB}MB)`);
					}
				}
				const rawFilename = ctx.request?.headers?.get("x-filename");
				const rawMetadataHeader = ctx.request?.headers?.get("x-file-metadata");
				if (!rawFilename) throw new Error("x-filename header is required");
				const filename = rawFilename.split("").map((char) => {
					return char.charCodeAt(0) <= 127 ? char : "?";
				}).join("");
				const metadataHeader = rawMetadataHeader ? rawMetadataHeader.split("").map((char) => {
					return char.charCodeAt(0) <= 127 ? char : "?";
				}).join("") : void 0;
				let additionalFields = {};
				if (metadataHeader) try {
					additionalFields = JSON.parse(metadataHeader);
				} catch (error2) {
					ctx.context.logger?.warn("[R2]: Failed to parse metadata header:", error2);
					throw new Error("Invalid JSON in x-file-metadata header");
				}
				if (r2Config?.additionalFields && Object.keys(additionalFields).length > 0) {
					const validationResult = createFileMetadataSchema(r2Config.additionalFields).safeParse(additionalFields);
					if (!validationResult.success) throw new Error(`Invalid additional fields: ${validationResult.error.message}`);
					additionalFields = validationResult.data || {};
				}
				const file = ctx.body;
				if (!file) throw new Error(R2_ERROR_CODES.NO_FILE_PROVIDED);
				let fileToUpload;
				if (file instanceof File) fileToUpload = file;
				else fileToUpload = new File([file], filename, { type: file.type || "application/octet-stream" });
				const customMetadata = additionalFields || {};
				const modelName = "userFile";
				const fileMetadata = await r2Storage.uploadFile(fileToUpload, filename, session.session.userId, ctx.context, customMetadata, modelName);
				try {
					await ctx.context.adapter.create({
						model: modelName,
						data: {
							id: fileMetadata.id,
							userId: fileMetadata.userId,
							filename: fileMetadata.filename,
							originalName: fileMetadata.originalName,
							contentType: fileMetadata.contentType,
							size: fileMetadata.size,
							r2Key: fileMetadata.r2Key,
							uploadedAt: fileMetadata.uploadedAt,
							...customMetadata
						}
					});
					ctx.context.logger?.info("[R2]: File metadata saved to database:", fileMetadata.id);
				} catch (dbError) {
					ctx.context.logger?.error("[R2]: Failed to save to database:", dbError);
					try {
						await r2Storage.deleteFile(fileMetadata, ctx.context);
					} catch (cleanupError) {
						ctx.context.logger?.error("[R2]: Failed to cleanup R2 file after DB error:", cleanupError);
					}
					throw ctx.error("INTERNAL_SERVER_ERROR", { message: R2_ERROR_CODES.DB_OPERATION_FAILED });
				}
				return ctx.json({
					success: true,
					data: fileMetadata
				});
			} catch (error2) {
				ctx.context.logger?.error("[R2]: Upload failed:", error2);
				if (error2 instanceof Error) throw ctx.error("INTERNAL_SERVER_ERROR", { message: error2.message });
				throw ctx.error("INTERNAL_SERVER_ERROR", { message: R2_ERROR_CODES.UPLOAD_FAILED });
			}
		}),
		download: createAuthEndpoint("/files/download", {
			method: "POST",
			use: [sessionMiddleware],
			body: fileIdSchema
		}, async (ctx) => {
			const session = ctx.context.session;
			const r2Storage = getR2Storage();
			if (!r2Storage) {
				ctx.context.logger?.error("[R2]: R2 storage not configured");
				throw ctx.error("INTERNAL_SERVER_ERROR", { message: R2_ERROR_CODES.R2_STORAGE_NOT_CONFIGURED });
			}
			const { fileId } = ctx.body;
			const fileRecord = await ctx.context.adapter.findOne({
				model: "userFile",
				where: [{
					field: "id",
					value: fileId
				}, {
					field: "userId",
					value: session.session.userId
				}]
			});
			if (!fileRecord) {
				ctx.context.logger?.warn(`[R2]: File not found or access denied for user "${session.session.userId}": ${fileId}`);
				throw ctx.error("NOT_FOUND", { message: "File not found. It may have been deleted or you don't have permission to access it" });
			}
			if (!validateFileMetadata(fileRecord)) {
				ctx.context.logger?.error(`[R2]: Invalid file record structure for file: ${fileId}`);
				throw ctx.error("INTERNAL_SERVER_ERROR", { message: R2_ERROR_CODES.INVALID_FILE_RECORD });
			}
			const fileData = await r2Storage.downloadFile(fileRecord, ctx.context);
			if (!fileData) {
				ctx.context.logger?.error(`[R2]: File data not found in R2 for file: ${fileId}`);
				throw ctx.error("NOT_FOUND", { message: "File content is temporarily unavailable. Please try again later" });
			}
			ctx.context.logger?.info(`[R2]: File downloaded successfully for user "${session.session.userId}": ${fileId}`);
			return new Response(fileData, { headers: {
				"Content-Type": fileRecord.contentType || "application/octet-stream",
				"Content-Disposition": `attachment; filename="${fileRecord.originalName}"`,
				"Content-Length": fileRecord.size?.toString() || "0"
			} });
		}),
		delete: createAuthEndpoint("/files/delete", {
			method: "POST",
			use: [sessionMiddleware],
			body: fileIdSchema
		}, async (ctx) => {
			const session = ctx.context.session;
			const r2Storage = getR2Storage();
			if (!r2Storage) {
				ctx.context.logger?.error("[R2]: R2 storage not configured");
				throw ctx.error("INTERNAL_SERVER_ERROR", { message: R2_ERROR_CODES.R2_STORAGE_NOT_CONFIGURED });
			}
			const { fileId } = ctx.body;
			const fileRecord = await ctx.context.adapter.findOne({
				model: "userFile",
				where: [{
					field: "id",
					value: fileId
				}, {
					field: "userId",
					value: session.session.userId
				}]
			});
			if (!fileRecord) {
				ctx.context.logger?.warn(`[R2]: File not found or access denied for user "${session.session.userId}": ${fileId}`);
				throw ctx.error("NOT_FOUND", { message: "File not found. It may have been deleted or you don't have permission to delete it" });
			}
			if (!validateFileMetadata(fileRecord)) {
				ctx.context.logger?.error(`[R2]: Invalid file record structure for file: ${fileId}`);
				throw ctx.error("INTERNAL_SERVER_ERROR", { message: R2_ERROR_CODES.INVALID_FILE_RECORD });
			}
			await r2Storage.deleteFile(fileRecord, ctx.context);
			await ctx.context.adapter.delete({
				model: "userFile",
				where: [{
					field: "id",
					value: fileId
				}]
			});
			ctx.context.logger?.info(`[R2]: File deleted successfully for user "${session.session.userId}": ${fileId}`);
			return ctx.json({
				message: "File deleted successfully",
				fileId
			});
		}),
		list: createAuthEndpoint("/files/list", {
			method: "GET",
			use: [sessionMiddleware]
		}, async (ctx) => {
			const session = ctx.context.session;
			try {
				validateAuthContext(ctx.context);
			} catch (error2) {
				ctx.context.logger?.error("[R2]: Auth context validation failed:", error2);
				throw ctx.error("INTERNAL_SERVER_ERROR", { message: R2_ERROR_CODES.DB_OPERATION_FAILED });
			}
			if (!getR2Storage()) {
				ctx.context.logger?.error("[R2]: R2 storage not configured");
				throw ctx.error("INTERNAL_SERVER_ERROR", { message: R2_ERROR_CODES.R2_STORAGE_NOT_CONFIGURED });
			}
			const limit = ctx.query?.limit ? parseInt(ctx.query.limit) : 50;
			const cursor = ctx.query?.cursor;
			try {
				const modelName = "userFile";
				ctx.context.logger?.info(`[R2]: Using model name "${modelName}" for listing files`);
				let fileRecords = [];
				const actualLimit = Math.min(limit, 100) + 1;
				try {
					const whereConditions = [{
						field: "userId",
						value: session.session.userId
					}];
					fileRecords = await ctx.context.adapter.findMany({
						model: modelName,
						where: whereConditions,
						limit: actualLimit,
						sortBy: {
							field: "uploadedAt",
							direction: "desc"
						}
					});
					if (cursor) {
						const cursorIndex = fileRecords.findIndex((file) => file.id === cursor);
						if (cursorIndex !== -1) fileRecords = fileRecords.slice(cursorIndex + 1);
					}
				} catch (dbError) {
					ctx.context.logger?.error(`[R2]: Database query failed for model "${modelName}":`, dbError);
					if (dbError instanceof Error) {
						ctx.context.logger?.error(`[R2]: Error message: ${dbError.message}`);
						ctx.context.logger?.error(`[R2]: Error stack: ${dbError.stack}`);
					}
					throw dbError;
				}
				const validFileRecords = fileRecords.filter((record) => validateFileMetadata(record));
				const hasMore = validFileRecords.length > limit;
				const files = hasMore ? validFileRecords.slice(0, -1) : validFileRecords;
				const nextCursor = hasMore ? files[files.length - 1].id : null;
				ctx.context.logger?.info(`[R2]: Listed ${files.length} files for user "${session.session.userId}" (hasMore: ${hasMore})`);
				return ctx.json({
					files,
					nextCursor,
					hasMore
				});
			} catch (error2) {
				ctx.context.logger?.error("[R2]: Failed to list files:", error2);
				throw ctx.error("INTERNAL_SERVER_ERROR", { message: R2_ERROR_CODES.LIST_FILES_FAILED });
			}
		}),
		get: createAuthEndpoint("/files/get", {
			method: "POST",
			use: [sessionMiddleware],
			body: fileIdSchema
		}, async (ctx) => {
			const session = ctx.context.session;
			const { fileId } = ctx.body;
			const fileRecord = await ctx.context.adapter.findOne({
				model: "userFile",
				where: [{
					field: "id",
					value: fileId
				}, {
					field: "userId",
					value: session.session.userId
				}]
			});
			if (!fileRecord) {
				ctx.context.logger?.warn(`[R2]: File not found or access denied for user "${session.session.userId}": ${fileId}`);
				throw ctx.error("NOT_FOUND", { message: "File not found. It may have been deleted or you don't have permission to access it" });
			}
			return ctx.json({ data: fileRecord });
		})
	};
};
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth-cloudflare@0.3.0_@better-auth+drizzle-adapter@1.6.23_@better-auth+core@1.6._ccc1e0386c2c691447ec088d98816cbf/node_modules/better-auth-cloudflare/dist/client.mjs
function sanitizeHeaderValue(value) {
	return value.split("").map((char) => {
		return char.charCodeAt(0) <= 127 ? char : "?";
	}).join("");
}
var cloudflareClient = () => {
	return {
		id: "cloudflare",
		$InferServerPlugin: {},
		getActions: ($fetch) => {
			return { 
			/**
			* Upload a file by sending it directly as the request body with metadata in headers.
			*/
uploadFile: async (file, metadata) => {
				const headers = { "x-filename": sanitizeHeaderValue(file.name) };
				if (metadata && Object.keys(metadata).length > 0) headers["x-file-metadata"] = sanitizeHeaderValue(JSON.stringify(metadata));
				return $fetch("/files/upload-raw", {
					method: "POST",
					headers,
					body: file
				});
			} };
		}
	};
};
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth-cloudflare@0.3.0_@better-auth+drizzle-adapter@1.6.23_@better-auth+core@1.6._ccc1e0386c2c691447ec088d98816cbf/node_modules/better-auth-cloudflare/dist/types.mjs
function createR2Config(config) {
	return config;
}
//#endregion
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/better-auth-cloudflare@0.3.0_@better-auth+drizzle-adapter@1.6.23_@better-auth+core@1.6._ccc1e0386c2c691447ec088d98816cbf/node_modules/better-auth-cloudflare/dist/index.mjs
var cloudflare = (options) => {
	const opts = options ?? {};
	const geolocationTrackingEnabled = opts.geolocationTracking === void 0 || opts.geolocationTracking;
	let r2Storage = null;
	return {
		id: "cloudflare",
		schema: schema(opts),
		endpoints: {
			getGeolocation: createAuthEndpoint("/cloudflare/geolocation", { method: "GET" }, async (ctx) => {
				if (!await getSessionFromCtx(ctx)) return ctx.json({ error: "Unauthorized" }, { status: 401 });
				const cf = await Promise.resolve(opts.cf);
				if (!cf) return ctx.json({ error: "Cloudflare context is not available" }, { status: 404 });
				const context = extractGeolocationData(cf);
				return ctx.json(context);
			}),
			...opts.r2 ? createR2Endpoints(() => r2Storage, opts.r2) : {}
		},
		init(init_ctx) {
			if (opts.r2) r2Storage = createR2Storage(opts.r2, init_ctx.generateId);
			return { options: { databaseHooks: { session: { create: { before: async (s, _context) => {
				if (!geolocationTrackingEnabled) return;
				const cf = await Promise.resolve(opts.cf);
				if (!cf) return;
				const geoData = extractGeolocationData(cf);
				return { data: {
					...s,
					...geoData
				} };
			} } } } } };
		}
	};
};
function extractGeolocationData(input) {
	if (!input || typeof input !== "object") return {};
	return {
		timezone: input.timezone || void 0,
		city: input.city || void 0,
		country: input.country || void 0,
		region: input.region || void 0,
		regionCode: input.regionCode || void 0,
		colo: input.colo || void 0,
		latitude: input.latitude || void 0,
		longitude: input.longitude || void 0
	};
}
var createKVStorage = (kv) => {
	return {
		get: async (key) => {
			return kv.get(key);
		},
		set: async (key, value, ttl) => {
			if (ttl !== void 0) {
				const minTtl = 60;
				if (ttl < minTtl) {
					console.warn(`[BetterAuthCloudflare] TTL ${ttl}s is less than KV minimum of ${minTtl}s. Using ${minTtl}s instead.`);
					ttl = minTtl;
				}
				return kv.put(key, value, { expirationTtl: ttl });
			}
			return kv.put(key, value);
		},
		delete: async (key) => {
			return kv.delete(key);
		}
	};
};
var withCloudflare = (cloudFlareOptions, options) => {
	const autoDetectIpEnabled = cloudFlareOptions.autoDetectIpAddress === void 0 || cloudFlareOptions.autoDetectIpAddress === true;
	const geolocationTrackingForSession = cloudFlareOptions.geolocationTracking === void 0 || cloudFlareOptions.geolocationTracking === true;
	if (autoDetectIpEnabled || geolocationTrackingForSession) {
		if (!cloudFlareOptions.cf) throw new Error("Cloudflare context is required for geolocation or IP detection features. Be sure to pass the `cf` option to the withCloudflare function.");
	}
	let updatedAdvanced = { ...options.advanced };
	if (autoDetectIpEnabled) updatedAdvanced.ipAddress = {
		...updatedAdvanced.ipAddress ?? {},
		ipAddressHeaders: [
			"cf-connecting-ip",
			"x-real-ip",
			...updatedAdvanced.ipAddress?.ipAddressHeaders ?? []
		]
	};
	else if (updatedAdvanced.ipAddress?.ipAddressHeaders);
	let updatedSession = { ...options.session };
	if (geolocationTrackingForSession) updatedSession.storeSessionInDatabase = true;
	else if (options.session?.storeSessionInDatabase === void 0);
	if ([
		cloudFlareOptions.postgres,
		cloudFlareOptions.mysql,
		cloudFlareOptions.d1,
		cloudFlareOptions.d1Native
	].filter(Boolean).length > 1) throw new Error("Only one database configuration can be provided. Please provide only one of postgres, mysql, d1, or d1Native.");
	let database;
	if (cloudFlareOptions.d1Native) database = cloudFlareOptions.d1Native;
	else if (cloudFlareOptions.postgres) database = drizzleAdapter(cloudFlareOptions.postgres.db, {
		provider: "pg",
		...cloudFlareOptions.postgres.options
	});
	else if (cloudFlareOptions.mysql) database = drizzleAdapter(cloudFlareOptions.mysql.db, {
		provider: "mysql",
		...cloudFlareOptions.mysql.options
	});
	else if (cloudFlareOptions.d1) database = drizzleAdapter(cloudFlareOptions.d1.db, {
		provider: "sqlite",
		...cloudFlareOptions.d1.options
	});
	const plugins = [cloudflare(cloudFlareOptions), ...options.plugins ?? []];
	return {
		...options,
		database,
		secondaryStorage: cloudFlareOptions.kv ? createKVStorage(cloudFlareOptions.kv) : void 0,
		plugins,
		advanced: updatedAdvanced,
		session: updatedSession
	};
};
//#endregion
export { R2_ERROR_CODES, cloudflare, cloudflareClient, createFileMetadataSchema, createFileValidator, createKVStorage, createR2Config, createR2Endpoints, createR2Storage, createUploadFileSchema, error, fileIdSchema, listFilesSchema, schema, success, withCloudflare };
