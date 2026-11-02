// Loads pages, forces every image to load (both themes, phone and desktop), and lists failed requests.
import { chromium } from "/tmp/ovtools/node_modules/playwright-core/index.mjs";
const pages = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  args: ["--no-sandbox", "--headless=new"],
  env: { ...process.env, LD_LIBRARY_PATH: "/tmp/ovtools/root/usr/lib/x86_64-linux-gnu" },
});
for (const url of pages) {
  for (const theme of ["whitehaven", "orient-express"]) {
    for (const vp of [{ width: 412, height: 915, isMobile: true }, { width: 1440, height: 900, isMobile: false }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile });
      const page = await ctx.newPage();
      const bad = new Set(); let imgs = 0, bytes = 0;
      page.on("response", async (r) => {
        const u = r.url();
        if (r.status() >= 400 && !u.endsWith("favicon.ico")) bad.add(r.status() + " " + u.replace("http://100.84.20.56:8471/overview-directions/", ""));
        if (/\.(webp|png|jpg)$/.test(u) && r.status() < 400) { imgs++; const b = await r.body().catch(() => null); if (b) bytes += b.length; }
      });
      const errs = [];
      page.on("pageerror", (e) => errs.push(String(e)));
      await page.goto(url + (url.includes("?") ? "&" : "?") + "theme=" + theme, { waitUntil: "load" });
      await page.evaluate(() => document.querySelectorAll("img").forEach((i) => (i.loading = "eager")));
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 800) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } });
      await page.waitForTimeout(1500);
      const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && i.getAttribute("src") && getComputedStyle(i).display !== "none").map((i) => i.getAttribute("src")));
      console.log(`${url.split("overview-directions/")[1]} ${theme} ${vp.width}: ${imgs} imgs ${(bytes / 1e6).toFixed(1)} MB` + (bad.size ? " BAD: " + [...bad].join(", ") : "") + (broken.length ? " BROKEN: " + broken.join(", ") : "") + (errs.length ? " ERR: " + errs.join(" | ") : ""));
      await ctx.close();
    }
  }
}
await browser.close();
