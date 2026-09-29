/**
 * Runs the desktop app in development:
 *
 * - starts the renderer's Vite dev server on a free loopback port;
 * - builds main and the preload, and builds them again whenever their source
 *   changes;
 * - starts Electron once both are built, and restarts it after every rebuild.
 *
 * The renderer updates in place through Vite's HMR. Main and the preload
 * cannot, so a change to either restarts Electron.
 *
 * Quitting Electron ends the script with Electron's exit code. A signal that
 * stops the script (Ctrl-C, `kill`) is passed on to Electron, and once
 * Electron has exited the script exits with 128 plus the signal's number, as
 * a shell reports it.
 *
 * Main and the preload are built with source maps here, and Electron runs with
 * Node's `--enable-source-maps`, so a stack trace from main points at the
 * TypeScript source rather than the minified bundle.
 *
 * The script runs on Node rather than Bun because it drives Vite's dev server
 * and Rolldown's watcher through their JavaScript APIs, which are built and
 * tested for Node.
 *
 * Arguments are passed on to Electron, for example
 * `pnpm dev --user-data-dir=/tmp/scratch` to keep the app's settings away from
 * the real ones.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build, createServer, type Rolldown } from "vite";
import { buildAppEnv, exitCodeForSignal, findFreePort } from "./processes.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

const port = await findFreePort();
const renderer = await createServer({
  configFile: `${packageDir}/vite.renderer.config.ts`,
  server: { port, ws: { port } },
});
await renderer.listen();

// The `electron` package's main module is the path to the Electron binary.
const electronPath = createRequire(import.meta.url)("electron") as string;

const env = buildAppEnv();
env.HERCULE_DESKTOP_DEV_SERVER_URL = `http://127.0.0.1:${String(port)}/`;
env.NODE_OPTIONS = [env.NODE_OPTIONS, "--enable-source-maps"].filter(Boolean).join(" ");

let electron: ChildProcess | undefined;
const watchers: Rolldown.RolldownWatcher[] = [];

/**
 * Sends `signal` to Electron if it is running and waits for it to exit, then
 * closes the dev server and the watchers and exits with `exitCode`.
 */
const stop = async (exitCode: number, signal: NodeJS.Signals = "SIGTERM") => {
  if (electron !== undefined && electron.exitCode === null && electron.signalCode === null) {
    electron.removeAllListeners("exit");
    const exited = once(electron, "exit");
    electron.kill(signal);
    await exited;
  }
  await Promise.all([renderer.close(), ...watchers.map((watcher) => watcher.close())]);
  process.exit(exitCode);
};

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => void stop(exitCodeForSignal(signal), signal));
}

const startElectron = () => {
  electron = spawn(electronPath, [packageDir, ...process.argv.slice(2)], {
    env,
    stdio: "inherit",
  });
  // Node reports either the exit code or the signal that killed the process.
  electron.once("exit", (code, signal) => {
    void stop(signal === null ? (code ?? 0) : exitCodeForSignal(signal));
  });
};

/** Starts Electron, or stops the running one by its PID and starts it again. */
const restartElectron = () => {
  if (electron === undefined) return startElectron();
  electron.removeAllListeners("exit");
  // The new Electron waits for the old one to exit, because the app holds a
  // single-instance lock and a second instance would quit at once.
  electron.once("exit", startElectron);
  electron.kill();
};

const built = new Set<string>();

/** Builds one bundle in watch mode, and restarts Electron after each build once both exist. */
const watchBundle = async (configFile: string) => {
  const watcher = (await build({
    configFile: `${packageDir}/${configFile}`,
    build: { watch: {}, sourcemap: true },
  })) as Rolldown.RolldownWatcher;
  watchers.push(watcher);
  watcher.on("event", (event) => {
    if (event.code !== "END") return;
    built.add(configFile);
    if (built.size === 2) restartElectron();
  });
};

await watchBundle("vite.main.config.ts");
await watchBundle("vite.preload.config.ts");
