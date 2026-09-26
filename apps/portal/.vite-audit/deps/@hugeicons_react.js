import { r as __toESM } from "./rolldown-runtime-B-1-B7_t.js";
import { t as require_react } from "./react.js";
//#region ../../../CogPortal-verifier-ui-e8aed6e/node_modules/.pnpm/@hugeicons+react@1.1.9_react@19.2.7/node_modules/@hugeicons/react/dist/esm/HugeiconsIcon.js
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
var defaultAttributes = {
	xmlns: "http://www.w3.org/2000/svg",
	width: 24,
	height: 24,
	viewBox: "0 0 24 24",
	fill: "none"
};
var HugeiconsIcon = (0, import_react.forwardRef)(({ color = "currentColor", size = 24, strokeWidth, absoluteStrokeWidth = false, className = "", altIcon, showAlt = false, icon, primaryColor, secondaryColor, disableSecondaryOpacity = false, ...rest }, ref) => {
	const calculatedStrokeWidth = strokeWidth !== void 0 ? absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth : void 0;
	const strokeProps = calculatedStrokeWidth !== void 0 ? {
		strokeWidth: calculatedStrokeWidth,
		stroke: "currentColor"
	} : {};
	return (0, import_react.createElement)("svg", {
		ref,
		...defaultAttributes,
		width: size,
		height: size,
		color: primaryColor || color,
		className,
		...strokeProps,
		...rest
	}, [...showAlt && altIcon ? altIcon : icon].sort(([, a], [, b]) => {
		const hasOpacityA = a.opacity !== void 0;
		return b.opacity !== void 0 ? 1 : hasOpacityA ? -1 : 0;
	}).map(([tag, attrs]) => {
		const isSecondaryPath = attrs.opacity !== void 0;
		const pathOpacity = isSecondaryPath && !disableSecondaryOpacity ? attrs.opacity : void 0;
		const fillProps = secondaryColor ? { ...attrs.stroke !== void 0 ? { stroke: isSecondaryPath ? secondaryColor : primaryColor || color } : { fill: isSecondaryPath ? secondaryColor : primaryColor || color } } : {};
		return (0, import_react.createElement)(tag, {
			...attrs,
			...strokeProps,
			...fillProps,
			opacity: pathOpacity,
			key: attrs.key
		});
	}));
});
HugeiconsIcon.displayName = "HugeiconsIcon";
//#endregion
export { HugeiconsIcon };
