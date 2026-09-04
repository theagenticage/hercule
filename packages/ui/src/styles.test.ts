import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = import.meta.dirname;
const css = readFileSync(join(here, "styles.css"), "utf8");

/** The declarations inside the first rule whose selector list matches exactly. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated rule for ${selector}`);
}

function value(selector: string, custom: string): string {
  const match = new RegExp(`${custom}\\s*:\\s*([^;]+);`).exec(block(selector));
  expect(match, `${custom} is not set in ${selector}`).not.toBeNull();
  return match![1]!.replace(/\s+/g, " ").trim();
}

const light = {
  "--bg": "oklch(94.5% 0.0156 265)",
  "--surface": "oklch(96.7% 0.0125 265)",
  "--raised": "oklch(100% 0.0078 265)",
  "--ink": "oklch(23% 0.01 265)",
  "--muted": "oklch(48% 0.0156 265)",
  "--faint": "oklch(66% 0.0156 265)",
  "--line": "oklch(23% 0.01 265 / 0.1)",
  "--line-soft": "oklch(23% 0.01 265 / 0.055)",
  "--attn": "#8a6116",
  "--fail": "#a34e46",
  "--live": "#48717f",
  "--ok": "#48745a",
  "--attn-soft": "rgba(138, 97, 22, 0.09)",
  "--project-hydra": "#7d7ab0",
  "--project-ops": "#a67f92",
};

const dark = {
  "--bg": "oklch(20% 0.0288 265)",
  "--surface": "oklch(22.2% 0.0288 265)",
  "--raised": "oklch(25.5% 0.0259 265)",
  "--ink": "oklch(90% 0.008 265)",
  "--muted": "oklch(68% 0.0288 265)",
  "--faint": "oklch(50% 0.0288 265)",
  "--line": "oklch(90% 0.0288 265 / 0.1)",
  "--line-soft": "oklch(90% 0.0288 265 / 0.06)",
  "--attn": "#d0a147",
  "--fail": "#cf7b71",
  "--live": "#7fa8b8",
  "--ok": "#7fae8e",
  "--attn-soft": "rgba(208, 161, 71, 0.12)",
  "--project-hydra": "#9490c9",
  "--project-ops": "#bd93a8",
};

describe("Midnight tokens", () => {
  it.each(Object.entries(light))("light %s is %s", (custom, expected) => {
    expect(value(":root", custom)).toBe(expected);
  });

  it.each(Object.entries(dark))("dark %s is %s", (custom, expected) => {
    expect(value(':root[data-theme="dark"]', custom)).toBe(expected);
  });

  it("gives the same dark values to the system preference, unless light is chosen", () => {
    const media = block("@media (prefers-color-scheme: dark)");
    expect(media).toContain(':root:not([data-theme="light"])');
    for (const [custom, expected] of Object.entries(dark)) {
      expect(media.replace(/\s+/g, " ")).toContain(`${custom}: ${expected};`);
    }
  });

  it("pins the emphasis weights and the two faces", () => {
    expect(value(":root", "--w-emph")).toBe("500");
    expect(value(":root", "--w-urgent")).toBe("600");
    expect(value(":root", "--sans")).toContain('"Onest"');
    expect(value(":root", "--mono")).toContain('"IBM Plex Mono"');
  });

  it("pins the type scale and radii", () => {
    expect(value("@theme", "--text-body")).toBe("14px");
    expect(value("@theme", "--text-row")).toBe("13.5px");
    expect(value("@theme", "--text-meta")).toBe("12.5px");
    expect(value("@theme", "--text-fine")).toBe("12px");
    expect(value("@theme", "--text-label")).toBe("10.5px");
    expect(value("@theme", "--radius-card")).toBe("10px");
    expect(value("@theme", "--radius-control")).toBe("6px");
  });

  it("reads the tokens into Tailwind's theme rather than restating their values", () => {
    const theme = block("@theme inline");
    expect(theme).toContain("--color-ink: var(--ink)");
    expect(theme).toContain("--color-attn: var(--attn)");
    expect(theme).toContain("--font-sans: var(--sans)");
    expect(theme).toContain("--shadow-lift: var(--lift-shadow)");
    expect(/oklch\(|#[0-9a-f]{6}/.test(theme)).toBe(false);
  });
});

describe("self-hosted faces", () => {
  it("serves every face from a file beside the stylesheet, never from a CDN", () => {
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(urls).toHaveLength(6);
    for (const url of urls) {
      expect(url.startsWith("./fonts/")).toBe(true);
      expect(existsSync(join(here, url)), url).toBe(true);
    }
    expect(css).not.toContain("fonts.googleapis.com");
    expect(css).not.toContain("fonts.gstatic.com");
  });

  it("covers the three Onest weights with one variable face", () => {
    expect(css).toContain("font-weight: 400 600;");
  });
});
