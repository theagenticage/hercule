/**
 * What the capture scripts that Electron runs share: scripts/bureau-capture.ts
 * for `pnpm compare:bureau`, and scripts/sidebar-states-capture.ts. Each opens
 * sheets in hidden windows, captures them, prints a report and exits.
 *
 * scripts/sheet-server.ts starts Electron with the capture script, the
 * sheets' address as `--sheets-url`, and the switches that fix the capture's
 * scale, its colour profile and how its pixels are drawn.
 *
 * Electron loads this file as TypeScript by stripping its types, so it uses
 * only syntax that stripping can erase: no enums, namespaces or parameter
 * properties.
 */
import { app, BrowserWindow, type NativeImage } from "electron";
import type { Bitmap } from "./compare-bitmaps.ts";

/** The window's content size in CSS pixels: the size of a Bureau page. */
export const WIDTH = 1440;
export const HEIGHT = 900;
/** The device pixel ratio every supported Mac's built-in display shows, forced by a switch. */
export const DPR = 2;
/** The two themes every sheet is captured in: Whitehaven (light) and Orient Express (dark). */
export const THEMES = ["whitehaven", "orient-express"];
/** How long a sheet may take to draw and load its fonts. */
const READY_TIMEOUT_MS = 30_000;

/** A rectangle as the page's `getBoundingClientRect()` returns it, in CSS pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The sidebar's region of the window, in CSS pixels: its 272 px column, the full height. */
export const SIDEBAR_REGION: Rect = { x: 0, y: 0, width: 272, height: HEIGHT };

/**
 * Opens `url` in a hidden window with a 1440 × 900 content area and waits
 * until the page sets `data-ready` on `<html>`. When `moduleUrl` is given,
 * the page imports that module once it has loaded; the module must set
 * `data-ready` itself. Returns the window. Fails when the page does not load,
 * the module fails, or the page does not become ready in time; the window is
 * then closed, and the error lists the page's console errors.
 */
export async function openSheet(url: string, moduleUrl?: string): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    // Hidden, so that the display's size can never shrink the window.
    show: false,
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    // A hidden window would otherwise throttle animation frames, and the
    // page's readiness waits for two of them.
    webPreferences: { backgroundThrottling: false },
  });
  const errors: string[] = [];
  window.webContents.on("console-message", ({ level, message }) => {
    if (level === "error") errors.push(message);
  });
  try {
    await window.loadURL(url);
    if (moduleUrl !== undefined) {
      // A module namespace cannot be sent back to this process, so the
      // script returns nothing once the import has finished.
      await window.webContents.executeJavaScript(
        `import(${JSON.stringify(moduleUrl)}).then(() => undefined)`,
      );
    }
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (
      !(await window.webContents.executeJavaScript(
        `document.documentElement.hasAttribute("data-ready")`,
      ))
    ) {
      if (Date.now() > deadline) {
        throw new Error(
          `${url} did not set data-ready within ${String(READY_TIMEOUT_MS / 1000)} s.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return window;
  } catch (error) {
    window.destroy();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message + (errors.length > 0 ? `\nThe page's console errors:\n${errors.join("\n")}` : ""),
      { cause: error },
    );
  }
}

/**
 * Captures `region` of the hidden window's page, or the whole page when no
 * region is given. Returns the image and its raw pixels. Fails unless the
 * capture is exactly the region's size, or 1440 × 900, at DPR 2.
 */
export async function captureSheet(
  window: BrowserWindow,
  region?: Rect,
): Promise<{ image: NativeImage; bitmap: Bitmap }> {
  const image = await window.webContents.capturePage(region, { stayHidden: true });
  const { width, height } = image.getSize();
  const expected = region ?? { width: WIDTH, height: HEIGHT };
  if (width !== expected.width * DPR || height !== expected.height * DPR) {
    throw new Error(
      `A capture is ${String(width)}x${String(height)} device pixels, not ${String(expected.width * DPR)}x${String(expected.height * DPR)}. ` +
        "Electron must run with --force-device-scale-factor=2; scripts/sheet-server.ts passes it.",
    );
  }
  return { image, bitmap: { width, height, pixels: image.toBitmap() } };
}

/**
 * Writes `text` to `stream` and exits with `code` once the text has been
 * handed to the operating system. Exiting at once could cut the report short,
 * because a pipe on macOS is written asynchronously.
 */
function writeAndExit(stream: NodeJS.WriteStream, text: string, code: number): void {
  stream.write(text, () => app.exit(code));
}

/**
 * Starts the capture app: once Electron is ready, calls `capture` with the
 * sheets' address from `--sheets-url`, prints the report it returns, and
 * exits with 0 when it passed and 1 when it did not. When `capture` fails,
 * or `--sheets-url` is missing, it prints the error and exits with 1.
 */
export function startCaptureApp(
  capture: (sheetsUrl: string) => Promise<{ readonly report: string; readonly passed: boolean }>,
): void {
  // No Dock icon: the tool's windows are never shown.
  app.dock?.hide();
  // A capture closes one set of windows before it opens the next. With no
  // listener for this event, Electron would quit, with exit code 0, as soon
  // as the first set closes.
  app.on("window-all-closed", () => {});
  void app.whenReady().then(async () => {
    try {
      const sheetsUrl = app.commandLine.getSwitchValue("sheets-url");
      if (sheetsUrl === "") {
        throw new Error("Pass the sheets' address as --sheets-url; scripts/sheet-server.ts does.");
      }
      const { report, passed } = await capture(sheetsUrl);
      writeAndExit(process.stdout, report, passed ? 0 : 1);
    } catch (error) {
      writeAndExit(
        process.stderr,
        `FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
        1,
      );
    }
  });
}
