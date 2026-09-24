/**
 * Tests what the stylesheet must contain, whatever its token values are: every
 * font face is served from a file beside it, and the one Onest file covers
 * every weight the app uses. The token values are not tested; the stylesheet
 * is their only source.
 *
 * The test reads the stylesheet and the font files through the bundler, not
 * the filesystem, because that is how the app reads them. A font face that the
 * stylesheet names but the package does not ship fails here, just as it would
 * fail to load in a browser.
 */
import { describe, expect, it } from "vitest";
import css from "./styles.css?raw";

const faces = new Set(Object.keys(import.meta.glob("./fonts/*.woff2", { eager: true })));

describe("self-hosted faces", () => {
  it("serves every face from a file beside the stylesheet, never from a CDN", () => {
    const urls = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(urls).toHaveLength(6);
    for (const url of urls) {
      expect(url.startsWith("./fonts/")).toBe(true);
      expect(faces.has(url), url).toBe(true);
    }
    expect(css).not.toContain("fonts.googleapis.com");
    expect(css).not.toContain("fonts.gstatic.com");
  });

  it("covers the three Onest weights with one variable face", () => {
    expect(css).toContain("font-weight: 400 600;");
  });
});
