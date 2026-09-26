import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({plugins:[react(),tailwindcss()],cacheDir:".fixture-cache",resolve:{alias:{"@":fileURLToPath(new URL("./src",import.meta.url))},dedupe:["react","react-dom"]},server:{host:"127.0.0.1",port:5237,strictPort:true,fs:{allow:["/private/var/folders/rq/cbyhqh497_b9xwgmxw3qlq680000gn/T/cogportal-ui-25758f9-v0wdaon8", "/Users/samgu/Programming Projects/CogPortal-demo-readiness/node_modules"]}}});
