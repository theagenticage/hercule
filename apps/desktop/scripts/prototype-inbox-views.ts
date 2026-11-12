/**
 * PROTOTYPE, throwaway. Serves the Inbox views prototype
 * (src/renderer/specimens/prototype-inbox-views/) from source and prints its
 * address: `pnpm --filter @hercule/desktop prototype:inbox-views`. Needs no
 * controller and no build. Stop it with Ctrl-C.
 *
 * It listens on 127.0.0.1 only, on `PROTOTYPE_PORT` (60780 by default), and
 * accepts requests addressed to a Tailscale name (`*.ts.net`), so the page can
 * be shared on the tailnet with:
 *
 *     tailscale serve --bg --https=8443 http://127.0.0.1:60780
 *
 * Vite refuses a request for a host it does not know, which is why the
 * shared specimen server cannot be used for this.
 */
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PROTOTYPE_PORT ?? 60780);

const server = await createServer({
  configFile: `${packageDir}/vite.renderer.config.ts`,
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    watch: null,
    // Nothing reloads the page, and the socket would point at 127.0.0.1, which a tailnet browser cannot reach.
    hmr: false,
    allowedHosts: [".ts.net"],
  },
  optimizeDeps: {
    entries: ["specimens/prototype-inbox-views/index.html"],
  },
  logLevel: "warn",
});
await server.listen();
// Tailscale's proxy reuses idle connections; Node's default of 5 seconds closes them under it, and the proxy answers 502.
if (server.httpServer && "keepAliveTimeout" in server.httpServer) {
  server.httpServer.keepAliveTimeout = 120_000;
  server.httpServer.headersTimeout = 125_000;
}
const path = "specimens/prototype-inbox-views/index.html";
process.stdout.write(`\nInbox prototype: http://127.0.0.1:${String(port)}/${path}?variant=inbox\n`);
process.stdout.write(
  "Variants: inbox, work, dashboard. Loads: ?load=light|heavy|extreme. Themes: ?theme=orient-express (or nile, styles, end-house, blue-train)\n\n",
);
const stop = (): void => void server.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
