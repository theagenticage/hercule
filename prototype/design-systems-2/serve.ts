// PROTOTYPE - serves the round-2 design systems at http://localhost:4871 (run `pnpm design-systems-2`).
// The pages also open straight from disk; the server only makes links and fonts behave like the web.
import { join, normalize } from "node:path";

const root = import.meta.dir;
const port = Number(process.env.PORT ?? 4871);

Bun.serve({
  port,
  async fetch(request) {
    let path = decodeURIComponent(new URL(request.url).pathname);
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    if (path.endsWith("/")) path += "index.html";
    const file = Bun.file(join(root, normalize(path)));
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Hercule design systems, round 2: http://localhost:${port}/`);
