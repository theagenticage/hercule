// PROTOTYPE - serves the design systems at http://localhost:4870 (run `pnpm design-systems`).
// The pages also open straight from disk; the server only makes links and fonts behave like the web.
import { join, normalize } from "node:path";

const root = import.meta.dir;
const port = Number(process.env.PORT ?? 4870);

Bun.serve({
  port,
  async fetch(request) {
    let path = decodeURIComponent(new URL(request.url).pathname);
    if (path.endsWith("/")) path += "index.html";
    const file = Bun.file(join(root, normalize(path)));
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Hercule design systems: http://localhost:${port}/`);
