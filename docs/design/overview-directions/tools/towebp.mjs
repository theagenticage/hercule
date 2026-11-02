// Re-encodes PNGs as WebP using headless Chromium's encoder.
// Usage: node towebp.mjs <quality 0-1> <png>... (writes <name>.webp beside each png; served over http)
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { writeFileSync, statSync } from "node:fs";
const [q, ...files] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  args: ["--no-sandbox", "--headless=new"],
  env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" },
});
const page = await browser.newPage();
await page.goto("http://100.84.20.56:8471/overview-directions/BRIEF.md");
let before = 0, after = 0;
for (const f of files) {
  const at = f.indexOf("/docs/design/");
  const rel = at >= 0 ? f.slice(at + "/docs/design/".length) : null;
  if (!rel) { console.log("skip (not under docs/design):", f); continue; }
  const b64 = await page.evaluate(async ([url, q]) => {
    const r = await fetch(url, { cache: "no-store" });
    const bmp = await createImageBitmap(await r.blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    const blob = await c.convertToBlob({ type: "image/webp", quality: q });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, ["/" + rel, Number(q)]);
  const out = f.replace(/\.png$/, ".webp");
  writeFileSync(out, Buffer.from(b64, "base64"));
  before += statSync(f).size; after += statSync(out).size;
}
console.log(`png ${(before/1e6).toFixed(1)} MB -> webp ${(after/1e6).toFixed(1)} MB`);
await browser.close();
