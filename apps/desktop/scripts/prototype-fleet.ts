/**
 * PROTOTYPE - throwaway. Serves the Fleet page prototype
 * (src/renderer/specimens/fleet-prototype.html) and prints its address.
 * No controller and no Electron: the page runs in any browser.
 *
 * `pnpm prototype:fleet` serves it on this machine only. Pass an address to
 * serve it there instead, such as this machine's tailnet address so another
 * machine can open it: `pnpm prototype:fleet --host 100.84.20.56`.
 */
import { createServer } from "vite";
import { findFreePort } from "./processes.ts";

const packageDir = new URL("..", import.meta.url).pathname;
const hostIndex = process.argv.indexOf("--host");
const host = hostIndex === -1 ? "127.0.0.1" : (process.argv[hostIndex + 1] ?? "127.0.0.1");
const port = await findFreePort();
const server = await createServer({
  configFile: `${packageDir}/vite.renderer.config.ts`,
  server: { host, port, strictPort: true, ws: { host, port } },
});
await server.listen();
console.log(`\n  Fleet prototype: http://${host}:${String(port)}/specimens/fleet-prototype.html\n`);
console.log("  Variants: ?variant=A, B or C, or the arrows in the bar at the bottom.");
console.log("  Themes: the menu in the same bar. Ctrl-C stops the server.\n");
