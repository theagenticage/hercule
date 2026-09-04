#!/usr/bin/env bun
/**
 * The web app's first paint, weighed against its budget.
 *
 * The budget is on the JavaScript a browser must have before it can show
 * anything: the entry module plus everything `index.html` preloads beside it.
 * Every route is a chunk of its own and is fetched when it is first visited, so
 * a screen added later costs nothing here - which is the point of measuring the
 * entry rather than the whole directory.
 *
 * CSS and fonts are outside the budget. They are one stylesheet and a fixed set
 * of subsets that no amount of application code moves.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The most the first paint may weigh, gzipped. */
const BUDGET_BYTES = 250 * 1024;

const dist = fileURLToPath(new URL("../apps/web/dist", import.meta.url));

if (!existsSync(dist)) {
  console.error("check-bundle-budget: no apps/web/dist; run `pnpm --filter @hydra/web build`.");
  process.exit(1);
}

const html = readFileSync(`${dist}/index.html`, "utf8");

/** What the page fetches before it can render: the entry module and its preloads. */
const firstPaint = new Set(
  [
    ...html.matchAll(/<script[^>]*\ssrc="([^"]+\.js)"/g),
    ...html.matchAll(/<link[^>]*\srel="modulepreload"[^>]*\shref="([^"]+\.js)"/g),
  ].map((match) => match[1]!),
);

if (firstPaint.size === 0) {
  console.error("check-bundle-budget: index.html names no script; the build produced no entry.");
  process.exit(1);
}

const gzippedSize = (urlPath: string): number =>
  Bun.gzipSync(readFileSync(`${dist}${urlPath}`)).byteLength;

const chunks = readdirSync(`${dist}/assets`)
  .filter((name) => name.endsWith(".js"))
  .map((name) => `/assets/${name}`)
  .map((urlPath) => ({
    urlPath,
    bytes: gzippedSize(urlPath),
    first: firstPaint.has(urlPath),
  }))
  .sort((a, b) => b.bytes - a.bytes);

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`;

const width = Math.max(...chunks.map((chunk) => chunk.urlPath.length));
console.log(`${"chunk".padEnd(width)}  gzipped   first paint`);
for (const chunk of chunks) {
  console.log(
    `${chunk.urlPath.padEnd(width)}  ${kb(chunk.bytes).padStart(8)}  ${chunk.first ? "yes" : ""}`,
  );
}

const total = chunks.reduce((sum, chunk) => sum + (chunk.first ? chunk.bytes : 0), 0);
console.log(
  `\ncheck-bundle-budget: first paint is ${kb(total)} gzipped across ${String(firstPaint.size)} ` +
    `chunks, of ${String(chunks.length)} built; the budget is ${kb(BUDGET_BYTES)}.`,
);

if (total > BUDGET_BYTES) {
  console.error(
    `check-bundle-budget: over budget by ${kb(total - BUDGET_BYTES)}. Move what the first paint ` +
      `does not need behind a route, or raise the budget deliberately and say why in spec 14.`,
  );
  process.exit(1);
}
