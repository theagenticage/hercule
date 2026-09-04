import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the stylesheet must hold whatever its values are: the faces are served
 * from beside it, and the one Onest file covers every weight the app asks for.
 * The token values themselves are the stylesheet's to state once.
 */
const here = import.meta.dirname;
const css = readFileSync(join(here, "styles.css"), "utf8");

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
