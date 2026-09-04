/**
 * What the stylesheet must hold whatever its values are: the faces are served
 * from beside it, and the one Onest file covers every weight the app asks for.
 * The token values themselves are the stylesheet's to state once.
 *
 * The stylesheet and the font files are reached through the bundler rather than
 * through the filesystem, which is how the app reaches them: a face the
 * stylesheet names and the package does not ship fails to resolve here for the
 * same reason it would fail to load in a browser.
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
