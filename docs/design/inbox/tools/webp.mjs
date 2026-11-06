// Re-encodes PNGs as WebP at quality 0.86 with Chromium's own encoder, beside each file, and removes the PNG.
// usage: node tools/webp.mjs <png>...
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
const browser = await chromium.launch({ executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox", "--headless=new"], env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" } });
const page = await browser.newPage();
for (const f of process.argv.slice(2)) {
  const out = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    const buf = new Uint8Array(await (await c.convertToBlob({ type: "image/webp", quality: 0.86 })).arrayBuffer());
    let s = "";
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, readFileSync(f).toString("base64"));
  writeFileSync(f.replace(/\.png$/, ".webp"), Buffer.from(out, "base64"));
  rmSync(f);
}
await browser.close();
