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
 *
 * The same pass refuses a development build. React ships two builds behind an
 * export condition, the development one is what a stray `NODE_ENV` selects,
 * and it is both slower and far larger - a difference the budget alone would
 * absorb rather than report.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The most the first paint may weigh, gzipped. */
const BUDGET_BYTES = 250 * 1024;

const dist = fileURLToPath(new URL("../apps/web/dist", import.meta.url));

if (!existsSync(dist)) {
  console.error("check-bundle-budget: no apps/web/dist; run `pnpm --filter @hercule/web build`.");
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

const readDistFile = (urlPath: string) => readFileSync(`${dist}${urlPath}`);

/** What only React's development build contains. */
const DEVELOPMENT_MARKERS = ["jsx-dev-runtime", "Invalid hook call"];

const shipped = [...firstPaint];
for (const marker of DEVELOPMENT_MARKERS) {
  const carrier = shipped.find((urlPath) => readDistFile(urlPath).includes(marker));
  if (carrier !== undefined) {
    console.error(
      `check-bundle-budget: ${carrier} carries "${marker}", so this is a development build. ` +
        `Build with NODE_ENV=production, or find what unset it.`,
    );
    process.exit(1);
  }
}

const chunks = readdirSync(`${dist}/assets`)
  .filter((name) => name.endsWith(".js"))
  .map((name) => `/assets/${name}`)
  .map((urlPath) => ({
    urlPath,
    bytes: Bun.gzipSync(readDistFile(urlPath)).byteLength,
    first: firstPaint.has(urlPath),
  }))
  .sort((a, b) => b.bytes - a.bytes);

const formatKilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`;

const width = Math.max(...chunks.map((chunk) => chunk.urlPath.length));
console.log(`${"chunk".padEnd(width)}  gzipped   first paint`);
for (const chunk of chunks) {
  console.log(
    `${chunk.urlPath.padEnd(width)}  ${formatKilobytes(chunk.bytes).padStart(8)}  ${chunk.first ? "yes" : ""}`,
  );
}

// Summed over what the page fetches, not over what the directory holds: a
// first-paint chunk emitted outside `/assets/` still has to be paid for.
const total = shipped.reduce(
  (sum, urlPath) => sum + Bun.gzipSync(readDistFile(urlPath)).byteLength,
  0,
);
console.log(
  `\ncheck-bundle-budget: first paint is ${formatKilobytes(total)} gzipped across ${String(shipped.length)} ` +
    `chunks, of ${String(chunks.length)} built; the budget is ${formatKilobytes(BUDGET_BYTES)}.`,
);

if (total > BUDGET_BYTES) {
  console.error(
    `check-bundle-budget: over budget by ${formatKilobytes(total - BUDGET_BYTES)}. Move what the first paint ` +
      `does not need behind a route, or raise the budget deliberately and say why in spec 14.`,
  );
  process.exit(1);
}
