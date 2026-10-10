/**
 * Measures what images in prompts cost the packaged desktop app (spec 17
 * §What images in prompts cost), and prints one table to copy into spec 17
 * §Measured. Run it after `pnpm build:desktop` and `pnpm build:binary`:
 *
 *     node apps/desktop/scripts/perf-images.ts
 *
 * It starts the perf script's controller with 40 threads (see
 * `perf-fixture.ts`), opens one idle thread once so the app reopens it at
 * every launch, warms the app up, and then starts it as a plain process, as
 * the perf script does. In that one launch it reads each process's memory
 * after each of these steps:
 *
 * 1. the thread open, with ten 4K screenshots held in the page as files and
 *    nothing drawn;
 * 2. the ten files on the thread composer's shelf, uploaded, drawn as the
 *    app draws them: 64 × 64 WebP thumbnails, decoded once at tile size;
 * 3. every tile removed;
 * 4. the same ten files drawn the plain way instead, as ten 64 × 64
 *    `<img>` elements on object URLs of the full files, so the two ways can
 *    be compared in the same launch;
 * 5. those elements removed and their URLs revoked;
 * 6. the ten files attached again and sent: the bubble draws them at
 *    210 × 158 from the bytes `attachment.readContent` returns.
 *
 * Before each reading the script asks the page to collect its garbage and
 * then waits `SETTLE_MS`, so each reading holds what the page keeps, not what
 * it has not freed yet. Between steps nothing stays attached to the page:
 * each step opens the page's DevTools connection and closes it again. With
 * the ten thumbnails on the shelf it also samples each process's CPU and
 * wakeups for 10 s, which should show no timer and no polling.
 *
 * The screenshots are generated here, not read from disk: each one is a PNG
 * of 3840 × 2160 pixels drawn like a screen of text, different from the
 * others, so no two share a cache entry.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { crc32, deflateSync } from "node:zlib";
import {
  connectInspector,
  formatTable,
  launchPlainApp,
  signInOnce,
  stopPlainApp,
  writeSettings,
} from "./packaged-app.ts";
import { runWithThreadFixture } from "./perf-fixture.ts";
import {
  findProcessUse,
  openThreadOnce,
  readProcessMemory,
  sampleIdleUse,
  waitForPageSocketUrl,
  warmUpApp,
  type ProcessMemory,
  type ProcessUse,
} from "./perf-measures.ts";
import { pollUntil } from "./poll.ts";

/** How many screenshots are attached, the most one message takes. */
const IMAGE_COUNT = 10;

/** A 4K screen, in pixels. */
const SCREEN_WIDTH = 3840;
const SCREEN_HEIGHT = 2160;

/** How long the script waits after a step and a garbage collection before it reads memory. */
const SETTLE_MS = 10_000;

/** The PNG file signature. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Builds one PNG chunk: its length, type, data and checksum. */
const buildPngChunk = (type: string, data: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, checksum]);
};

/**
 * Builds a 4K PNG drawn like a screenshot of text: a light background with
 * rows of noisy dark "words", whose lengths and colours vary with `seed`.
 * Returns its bytes, about 2 to 4 MB.
 */
const buildScreenshot = (seed: number): Buffer => {
  const stride = 1 + SCREEN_WIDTH * 3;
  const raw = Buffer.alloc(stride * SCREEN_HEIGHT);
  let state = (seed * 2_654_435_761) >>> 0;
  const random = (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const background = [246 - seed * 3, 244 - seed * 2, 240];
  for (let y = 0; y < SCREEN_HEIGHT; y += 1) {
    const row = y * stride;
    // Filter type 0: the row's bytes as they are.
    raw[row] = 0;
    const line = Math.floor(y / 36);
    const inText = y % 36 < 16;
    const lineEnd = 200 + ((line * 977 + seed * 131) % 3400);
    for (let x = 0; x < SCREEN_WIDTH; x += 1) {
      const at = row + 1 + x * 3;
      const ink = inText && x > 120 && x < lineEnd && x % 90 < 74 && random() < 0.45;
      raw[at] = ink ? 30 + seed * 9 : background[0]!;
      raw[at + 1] = ink ? 36 : background[1]!;
      raw[at + 2] = ink ? 48 : background[2]!;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SCREEN_WIDTH, 0);
  header.writeUInt32BE(SCREEN_HEIGHT, 4);
  // 8 bits per channel, colour type 2 (RGB), default compression, filter and interlace.
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    PNG_SIGNATURE,
    buildPngChunk("IHDR", header),
    buildPngChunk("IDAT", deflateSync(raw)),
    buildPngChunk("IEND", Buffer.alloc(0)),
  ]);
};

/**
 * Evaluates `expression` in the app's page over a connection that lasts only
 * for the call, waits for the promise it returns, and returns its value.
 */
const evaluateAsync = async (pageSocketUrl: string, expression: string): Promise<unknown> => {
  const page = await connectInspector(pageSocketUrl);
  try {
    return await page.evaluate("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
  } finally {
    page.close();
  }
};

/** Polls the page until `condition`, an expression, is true. Fails after 60 s, saying `what`. */
const waitInPage = (pageSocketUrl: string, condition: string, what: string): Promise<true> =>
  pollUntil(
    async () => ((await evaluateAsync(pageSocketUrl, condition)) === true ? true : undefined),
    { timeoutMs: 60_000, intervalMs: 250, timeoutMessage: `the page did not ${what} within 60 s` },
  );

/** Hands `window.perfImages` to the thread composer's file picker, as picking them does. */
const ATTACH_IMAGES = `(() => {
  const picker = document.querySelector('input[type="file"]');
  const files = new DataTransfer();
  for (const file of window.perfImages) files.items.add(file);
  picker.files = files.files;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
})()`;

/** True once every image on the shelf is uploaded and drawn. */
const SHELF_READY = `document.querySelectorAll('.shelf-tile[data-status="uploaded"] img').length === ${String(IMAGE_COUNT)}`;

/** Clicks every remove button on the shelf. */
const REMOVE_ALL = `(() => {
  for (const button of document.querySelectorAll('button[aria-label^="Remove "]')) button.click();
})()`;

/** Draws the files as plain 64 × 64 images on object URLs, and waits for each to decode. */
const DRAW_PLAIN = `(async () => {
  const box = document.createElement("div");
  box.id = "perf-plain";
  box.style.cssText = "position:fixed;left:8px;top:48px;display:flex;gap:8px;z-index:9999";
  const images = window.perfImages.map((file) => {
    const image = new Image();
    image.style.cssText = "width:64px;height:64px;object-fit:cover;border-radius:9px";
    image.src = URL.createObjectURL(file);
    box.append(image);
    return image;
  });
  document.body.append(box);
  await Promise.all(images.map((image) => image.decode()));
})()`;

/** Removes the plain images and revokes their URLs. */
const REMOVE_PLAIN = `(() => {
  const box = document.getElementById("perf-plain");
  for (const image of box.querySelectorAll("img")) URL.revokeObjectURL(image.src);
  box.remove();
})()`;

/** Clicks the composer's Send button. */
const SEND = `document.querySelector('button.send[title="Send"]').click()`;

/** True once the sent message's bubble draws every image and the shelf is empty. */
const BUBBLE_READY = `document.querySelectorAll('.bubble-images .image-tile img').length === ${String(IMAGE_COUNT)} && document.querySelectorAll('.shelf-tile').length === 0`;

/** One reading of the app's memory, after one step. */
interface Reading {
  readonly step: string;
  readonly memory: readonly ProcessMemory[];
}

/** Returns the footprint of the processes whose label starts with `label`, summed, in MB. */
const sumFootprint = (memory: readonly ProcessMemory[], label?: string): number =>
  memory
    .filter((process) => label === undefined || process.label.startsWith(label))
    .reduce((sum, process) => sum + process.footprintMb, 0);

const screenshots = Array.from({ length: IMAGE_COUNT }, (_, index) => buildScreenshot(index + 1));
const imageBytes = screenshots.reduce((sum, bytes) => sum + bytes.length, 0);

const result = await runWithThreadFixture(async (fixture) => {
  const userDataDir = mkdtempSync(join(tmpdir(), "hercule-desktop-perf-images-"));
  try {
    await fixture.growTo(40);
    writeSettings(userDataDir, { controllerUrl: fixture.url });
    await signInOnce(userDataDir);
    const thread = await fixture.growTranscript(4);
    await fixture.prepareLaunch({ twoMinuteRow: false });
    await openThreadOnce(userDataDir, thread.id);
    await warmUpApp(userDataDir);

    const loadAtSpawn = loadavg()[0]!;
    const app = await launchPlainApp(userDataDir);
    try {
      const pid = app.process.pid!;
      const page = await waitForPageSocketUrl(app.endpoint);
      await waitInPage(
        page,
        `document.querySelector('input[type="file"]') !== null`,
        "draw the composer",
      );
      const readings: Reading[] = [];
      const read = async (step: string): Promise<void> => {
        const inspector = await connectInspector(page);
        try {
          await inspector.send("HeapProfiler.collectGarbage");
        } finally {
          inspector.close();
        }
        await sleep(SETTLE_MS);
        readings.push({ step, memory: await readProcessMemory(pid) });
      };

      await evaluateAsync(page, "window.perfImages = []");
      for (const [index, bytes] of screenshots.entries()) {
        await evaluateAsync(
          page,
          // The page's content security policy refuses a fetch of a data URL,
          // so the base64 is decoded by hand.
          `(() => {
            const text = atob("${bytes.toString("base64")}");
            const bytes = new Uint8Array(text.length);
            for (let at = 0; at < text.length; at += 1) bytes[at] = text.charCodeAt(at);
            window.perfImages.push(new File([bytes], "screenshot-${String(index + 1)}.png", { type: "image/png" }));
          })()`,
        );
      }
      await read("Thread open, 10 files held, nothing drawn");

      await evaluateAsync(page, ATTACH_IMAGES);
      await waitInPage(page, SHELF_READY, "upload and draw the 10 images");
      await read("10 on the shelf, WebP thumbnails");
      const idle: ProcessUse[] = await sampleIdleUse(app.inspectorUrl);

      await evaluateAsync(page, REMOVE_ALL);
      await waitInPage(
        page,
        `document.querySelectorAll('.shelf-tile').length === 0`,
        "empty the shelf",
      );
      await read("All 10 removed");

      await evaluateAsync(page, ATTACH_IMAGES);
      await waitInPage(page, SHELF_READY, "upload and draw the 10 images again");
      await evaluateAsync(page, SEND);
      await waitInPage(page, BUBBLE_READY, "send and draw the 10 images in the bubble");
      await read("Sent: 10 in the bubble, 210 × 158");
      // Last, because Chromium keeps the full decodes after the URLs are
      // revoked, which would inflate every reading after this one.
      await evaluateAsync(page, DRAW_PLAIN);
      await read("10 plain <img> on object URLs, 64 × 64");
      await evaluateAsync(page, REMOVE_PLAIN);
      await read("Plain images removed, URLs revoked");
      return { readings, idle, loadAtSpawn, loadAtEnd: loadavg()[0]! };
    } finally {
      await stopPlainApp(app);
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

console.log(
  `\n${String(IMAGE_COUNT)} screenshots of ${String(SCREEN_WIDTH)} × ${String(SCREEN_HEIGHT)}, ` +
    `${(imageBytes / 1024 / 1024).toFixed(1)} MB of PNG in all. ` +
    `Load average ${result.loadAtSpawn.toFixed(1)} at spawn, ${result.loadAtEnd.toFixed(1)} at the end.\n`,
);
console.log(
  formatTable(
    ["Step", "Summed", "Browser", "GPU", "Renderer", "Processes"],
    result.readings.map(({ step, memory }) => [
      step,
      sumFootprint(memory).toFixed(1),
      sumFootprint(memory, "Browser").toFixed(1),
      sumFootprint(memory, "GPU").toFixed(1),
      sumFootprint(memory, "Tab").toFixed(1),
      String(memory.length),
    ]),
  ),
);
const renderer = findProcessUse(result.idle, "Tab");
const gpu = findProcessUse(result.idle, "GPU");
console.log(
  `\nIdle with 10 on the shelf, visible: renderer ${renderer?.cpuPercent.toFixed(1) ?? "?"}% ` +
    `and ${String(renderer?.wakeupsPerSecond ?? "?")} wakeups a second; ` +
    `GPU ${gpu?.cpuPercent.toFixed(1) ?? "?"}% and ${String(gpu?.wakeupsPerSecond ?? "?")}.`,
);
