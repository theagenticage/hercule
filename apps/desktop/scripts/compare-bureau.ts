/**
 * Compares the app's faces, icons and marks with the Bureau book's, pixel for
 * pixel, in both themes: `pnpm compare:bureau`. The book is the copy in
 * docs/design/crew-bureau, which is kept byte for byte as the design
 * prototype made it (spec 17).
 *
 * It runs in two processes. This script, on Node:
 * - checks that the book's tokens.css and font files are byte-identical to
 *   the app's copies, because a drift there would show as a flood of pixel
 *   differences with no clear cause;
 * - starts the renderer's Vite dev server on a free loopback port, serving the
 *   book's files under /bureau/;
 * - runs Electron with scripts/bureau-capture.ts as its main file, which
 *   draws, captures and compares the two sheets and prints the report;
 * - stops the dev server, deletes the temporary folder Electron kept its
 *   settings in, and exits with Electron's exit code.
 *
 * It needs no build: the sheets are served from source.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";
import { buildAppEnv, exitCodeForSignal, findFreePort } from "./processes.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/** The folder of the Bureau book the app is compared with. */
const bookDir = fileURLToPath(new URL("../../../docs/design/crew-bureau", import.meta.url));

/** The content type of each kind of file the book serves. Anything else is not served. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".woff2": "font/woff2",
};

/**
 * Checks that the app's tokens.css and font files are byte-identical to the
 * book's. Fails and names the first file that differs or is missing.
 */
function assertSharedFilesMatch(): void {
  const fonts = readdirSync(join(bookDir, "fonts")).filter((file) => file.endsWith(".woff2"));
  const shared = ["tokens.css", ...fonts.map((font) => `fonts/${font}`)];
  for (const file of shared) {
    const appFile = join(packageDir, "src/renderer/styles", file);
    const bookFile = join(bookDir, file);
    let appBytes: Buffer;
    try {
      appBytes = readFileSync(appFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(
        `The app has no ${appFile}, which the Bureau book has as ${bookFile}. Copy the book's file unchanged.`,
        { cause: error },
      );
    }
    if (!appBytes.equals(readFileSync(bookFile))) {
      throw new Error(
        `${appFile} differs from the Bureau book's ${bookFile}. The app keeps the book's copy unchanged, ` +
          "so every pixel difference would have this one cause. Copy the book's file again.",
      );
    }
  }
}

/**
 * Returns a Vite plugin that serves the book's stylesheets, scripts and fonts
 * under /bureau/. Its middleware runs before Vite's own, so Vite never
 * transforms the book's files: the reference sheet loads them exactly as the
 * book does.
 */
function serveBook(): Plugin {
  return {
    name: "serve-bureau-book",
    configureServer(server) {
      server.middlewares.use("/bureau", (request, response, next) => {
        // The URL parser drops any `..` segment, so the path stays inside the book.
        const { pathname } = new URL(request.url ?? "/", "http://book");
        const contentType = CONTENT_TYPES[extname(pathname)];
        if (contentType === undefined) return next();
        readFile(join(bookDir, pathname)).then(
          (contents) => {
            response.setHeader("Content-Type", contentType);
            response.end(contents);
          },
          () => next(),
        );
      });
    },
  };
}

/**
 * Runs Electron with the capture script, which loads the sheets from
 * `sheetsUrl` and keeps its settings in `userDataDir`. Returns Electron's exit
 * code, or 128 plus the signal's number when a signal ended it, as a shell
 * reports it. A signal that stops this script is passed on to Electron.
 */
async function runCapture(sheetsUrl: string, userDataDir: string): Promise<number> {
  // The `electron` package's main module is the path to the Electron binary.
  const electronPath = createRequire(import.meta.url)("electron") as string;
  const electron = spawn(
    electronPath,
    [
      fileURLToPath(new URL("bureau-capture.ts", import.meta.url)),
      `--sheets-url=${sheetsUrl}`,
      // Every supported Mac's built-in display shows DPR 2, and one colour
      // profile makes the captures independent of the display they run on.
      "--force-device-scale-factor=2",
      "--force-color-profile=srgb",
      // The CPU draws the pages, not the GPU. With the GPU, a change in one
      // piece also shifts a few edge pixels in its neighbours: a face moved
      // by 1 px failed its own cell and 11 others, each by 1 to 4 pixels.
      // The CPU keeps each difference in its own cell, and draws the same
      // pixels on any machine, including CI's virtual Macs.
      "--disable-gpu-rasterization",
      `--user-data-dir=${userDataDir}`,
    ],
    { env: buildAppEnv(), stdio: "inherit" },
  );
  const passOn = (signal: NodeJS.Signals) => electron.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, passOn);
  const [code, signal] = (await once(electron, "exit")) as [number | null, NodeJS.Signals | null];
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, passOn);
  return signal === null ? (code ?? 1) : exitCodeForSignal(signal);
}

const userDataDir = await mkdtemp(join(tmpdir(), "bureau-compare-user-data-"));
let exitCode = 1;
try {
  assertSharedFilesMatch();
  const port = await findFreePort();
  const server = await createServer({
    configFile: `${packageDir}/vite.renderer.config.ts`,
    // No file watching: nothing is edited while the sheets are captured, and
    // a change made elsewhere during the run must not reload a sheet.
    server: { port, watch: null },
    plugins: [serveBook()],
    logLevel: "warn",
  });
  await server.listen();
  try {
    exitCode = await runCapture(`http://127.0.0.1:${String(port)}/specimens/`, userDataDir);
  } finally {
    await server.close();
  }
} catch (error) {
  process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  await rm(userDataDir, { recursive: true, force: true });
}
process.exitCode = exitCode;
