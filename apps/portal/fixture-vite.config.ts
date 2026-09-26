import { mergeConfig } from "vite";
import base from "./vite.config";
export default mergeConfig(base, {
  resolve: { alias: { "@cogworks/contracts/schema": "/Users/samgu/Programming Projects/CogPortal-verifier-combined-ec5be80/packages/contracts/src/schema.ts" } },
  server: { fs: { allow: ["/Users/samgu/Programming Projects/CogPortal-verifier-combined-ec5be80", "/Users/samgu/Programming Projects/CogPortal-verifier-ui-e8aed6e"] } }
});
