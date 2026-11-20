/**
 * PROTOTYPE, throwaway. Serves the MCP management screens prototype
 * (src/renderer/specimens/prototype-mcp/) from source and prints its
 * address: `pnpm --filter @hercule/desktop prototype:mcp`. Needs no
 * controller and no build. Stop it with Ctrl-C.
 *
 * It listens on 127.0.0.1 only, on `PROTOTYPE_PORT` (60790 by default). The
 * server does not watch files: reload the page after an edit.
 */
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PROTOTYPE_PORT ?? 60790);

const server = await createServer({
  configFile: `${packageDir}/vite.renderer.config.ts`,
  server: { host: "127.0.0.1", port, strictPort: true, watch: null, hmr: false },
  optimizeDeps: { entries: ["specimens/prototype-mcp/index.html"] },
  logLevel: "warn",
});
await server.listen();
const path = "specimens/prototype-mcp/index.html";
process.stdout.write(`\nMCP prototype: http://127.0.0.1:${String(port)}/${path}\n`);
process.stdout.write(
  "Themes: add ?theme=orient-express (or nile, styles, end-house, blue-train). The bar at the bottom switches scene and variant.\n\n",
);
const stop = (): void => void server.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
