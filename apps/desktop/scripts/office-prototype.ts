/**
 * PROTOTYPE - serves the 3D office prototype from source and opens it in the
 * default browser: `pnpm office`. The page is
 * src/renderer/specimens/office-prototype/index.html. Stop it with Ctrl-C.
 *
 * Pass `--no-open` to only serve it, as the screenshot tool does.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const port = Number(process.env.OFFICE_PORT ?? 5317);
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.renderer.config.ts", import.meta.url)),
  server: { port, ws: { host: "127.0.0.1", port } },
});
await server.listen();
const url = `http://127.0.0.1:${String(port)}/specimens/office-prototype/index.html`;
console.log(`The office prototype is at ${url}`);
if (!process.argv.includes("--no-open"))
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
