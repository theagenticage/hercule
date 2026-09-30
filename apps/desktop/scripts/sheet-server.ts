/**
 * Serves the specimen sheets and runs an Electron capture script against
 * them: what `pnpm compare:bureau` (scripts/compare-bureau.ts) and
 * scripts/capture-sidebar-states.ts share. It needs no build: the sheets are
 * served from source.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Plugin } from "vite";
import { buildAppEnv, exitCodeForSignal, findFreePort } from "./processes.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * The folder of every design. The book's pages load files from outside the
 * book's own folder: session-active.html loads ../../shared/page.js.
 */
export const designDir = fileURLToPath(new URL("../../../docs/design", import.meta.url));

/** The content type of each kind of file the designs serve. Anything else is not served. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".woff2": "font/woff2",
};

/**
 * Returns a Vite plugin that serves the designs' pages, stylesheets, scripts
 * and fonts from docs/design under /design/. Its middleware runs before
 * Vite's own, so Vite never transforms the designs' files: the reference
 * sheets load them exactly as the book does.
 */
function serveDesigns(): Plugin {
  return {
    name: "serve-designs",
    configureServer(server) {
      server.middlewares.use("/design", (request, response, next) => {
        // The URL parser drops any `..` segment, so the path stays inside docs/design.
        const { pathname } = new URL(request.url ?? "/", "http://design");
        const contentType = CONTENT_TYPES[extname(pathname)];
        if (contentType === undefined) return next();
        readFile(join(designDir, pathname)).then(
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
 * Runs Electron with `captureScript` as its main file, which loads the sheets
 * from `sheetsUrl` and keeps its settings in `userDataDir`. Returns
 * Electron's exit code, or 128 plus the signal's number when a signal ended
 * it, as a shell reports it. A signal that stops this script is passed on to
 * Electron.
 */
async function runElectron(
  captureScript: URL,
  sheetsUrl: string,
  userDataDir: string,
): Promise<number> {
  // The `electron` package's main module is the path to the Electron binary.
  const electronPath = createRequire(import.meta.url)("electron") as string;
  const electron = spawn(
    electronPath,
    [
      fileURLToPath(captureScript),
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
      // The app's scroll bars are the system's overlay scroll bars, which
      // macOS draws only while a page scrolls (spec 17). A captured window
      // draws its scroll bars all the time, and the book styles its own, so
      // no capture draws any.
      "--hide-scrollbars",
      `--user-data-dir=${userDataDir}`,
    ],
    // The pages draw times in the system time zone, as the app does. UTC
    // makes the fixtures' times read the same on every machine: 09:04 in the
    // fixture is 09:04 on the page.
    { env: { ...buildAppEnv(), TZ: "UTC" }, stdio: "inherit" },
  );
  const passOn = (signal: NodeJS.Signals) => electron.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, passOn);
  const [code, signal] = (await once(electron, "exit")) as [number | null, NodeJS.Signals | null];
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, passOn);
  return signal === null ? (code ?? 1) : exitCodeForSignal(signal);
}

/**
 * Runs a capture: starts the renderer's Vite dev server on a free loopback
 * port, serving the specimen sheets under /specimens/ and docs/design under
 * /design/, then runs Electron with `captureScript` as its main file (see
 * scripts/sheet-window.ts). Once Electron exits, it stops the server and
 * deletes the temporary folder Electron kept its settings in. Returns
 * Electron's exit code. Fails when the server cannot start.
 */
export async function runSheetCapture(captureScript: URL): Promise<number> {
  const userDataDir = await mkdtemp(join(tmpdir(), "sheet-capture-user-data-"));
  try {
    const port = await findFreePort();
    const server = await createServer({
      configFile: `${packageDir}/vite.renderer.config.ts`,
      // No file watching: nothing is edited while the sheets are captured,
      // and a change made elsewhere during the run must not reload a sheet.
      server: { port, watch: null },
      plugins: [serveDesigns()],
      logLevel: "warn",
    });
    await server.listen();
    try {
      return await runElectron(
        captureScript,
        `http://127.0.0.1:${String(port)}/specimens/`,
        userDataDir,
      );
    } finally {
      await server.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
}
