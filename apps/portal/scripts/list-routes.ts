// Prints the Worker's registered HTTP routes as JSON, one `{ method, path }`
// per route, read from the Hono app itself (worker/app.ts). The real-journeys
// authorization matrix (tools/portal-real-journeys) runs this so its route
// list cannot drift from the Worker.
//
//   TSX_TSCONFIG_PATH=tsconfig.app.json tsx scripts/list-routes.ts
import { registeredRoutes } from "../worker/app.ts";

const routes = registeredRoutes().map((key) => {
  const space = key.indexOf(" ");
  return { method: key.slice(0, space), path: key.slice(space + 1) };
});
process.stdout.write(`${JSON.stringify(routes, null, 2)}\n`);
