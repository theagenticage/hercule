import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGoldenDiffImage,
  checkGoldens,
  compareWithGolden,
  describeProvenanceMismatch,
  formatProvenance,
  parseProvenance,
  recordGoldens,
  type GoldensLocation,
  type Provenance,
} from "./ui-goldens.ts";
import type { DecodedImage } from "./ui-pixels.ts";

const PROVENANCE: Provenance = {
  chromium: "153.0.1",
  playwright: "1.63.0",
  platform: "linux",
  arch: "x64",
};

/** Builds a `width` by `height` image of one RGBA colour. */
function buildImage(
  width: number,
  height: number,
  colour: [number, number, number, number] = [200, 100, 50, 255],
): DecodedImage {
  const data = new Uint8Array(width * height * 4);
  for (let at = 0; at < data.length; at += 4) data.set(colour, at);
  return { width, height, data };
}

/** Returns a copy of `image` with the pixel at `x`, `y` set to `colour`. */
function withPixel(
  image: DecodedImage,
  x: number,
  y: number,
  colour: [number, number, number, number],
): DecodedImage {
  const data = new Uint8Array(image.data);
  data.set(colour, (y * image.width + x) * 4);
  return { ...image, data };
}

/** Encodes an image as the bytes of a PNG file. */
function encode(image: DecodedImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

describe("compareWithGolden", () => {
  it("returns null for equal pixels", () => {
    expect(compareWithGolden(buildImage(3, 2), buildImage(3, 2))).toBeNull();
  });

  it("counts a difference of one level in one channel, including alpha, and boxes them", () => {
    const golden = buildImage(5, 4);
    const screenshot = withPixel(
      withPixel(golden, 1, 1, [200, 100, 51, 255]),
      3,
      2,
      [200, 100, 50, 254],
    );
    expect(compareWithGolden(golden, screenshot)).toEqual({
      kind: "pixels",
      pixels: 2,
      box: { left: 1, top: 1, right: 3, bottom: 2 },
    });
  });

  it("reports a size mismatch instead of comparing", () => {
    expect(compareWithGolden(buildImage(3, 2), buildImage(3, 3))).toEqual({
      kind: "size",
      golden: { width: 3, height: 2 },
      screenshot: { width: 3, height: 3 },
    });
  });
});

describe("buildGoldenDiffImage", () => {
  it("draws differing pixels in magenta over the golden at a quarter of its strength", () => {
    const golden = buildImage(2, 1, [0, 0, 0, 255]);
    const diff = buildGoldenDiffImage(golden, withPixel(golden, 1, 0, [1, 0, 0, 255]));
    expect([...diff.data]).toEqual([191, 191, 191, 255, 255, 0, 255, 255]);
  });
});

describe("describeProvenanceMismatch", () => {
  it("is null when the browser and machine agree, whatever the Playwright version", () => {
    expect(
      describeProvenanceMismatch(PROVENANCE, { ...PROVENANCE, playwright: "9.9.9" }),
    ).toBeNull();
  });

  it("names both Chromium versions and platforms when they differ", () => {
    const message = describeProvenanceMismatch(PROVENANCE, {
      ...PROVENANCE,
      chromium: "154.0.2",
      platform: "darwin",
    });
    expect(message).toContain("recorded with Chromium 153.0.1 on linux x64");
    expect(message).toContain("this run uses Chromium 154.0.2 on darwin x64");
  });
});

describe("parseProvenance", () => {
  it("reads what formatProvenance writes", () => {
    expect(parseProvenance(formatProvenance(PROVENANCE))).toEqual(PROVENANCE);
  });

  it("fails naming the field that is missing", () => {
    expect(() => parseProvenance('{"chromium":"1"}')).toThrow('"playwright"');
  });
});

describe("goldens on disk", () => {
  let root: string;
  let location: GoldensLocation;
  const names = ["light/a.png", "dark/a.png"];

  /** Writes `image` as the screenshot or golden `name`. */
  async function put(folder: string, name: string, image: DecodedImage): Promise<void> {
    await mkdir(join(root, folder, name, ".."), { recursive: true });
    await writeFile(join(root, folder, name), encode(image));
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ui-goldens-"));
    location = {
      goldensDir: join(root, "goldens"),
      screenshotsDir: join(root, "screenshots"),
      diffDir: join(root, "diff"),
      unmeasuredThemes: [],
      names,
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes when every screenshot has an equal golden, whatever bytes encode them", async () => {
    const image = buildImage(4, 4);
    for (const name of names) await put("screenshots", name, image);
    await put("goldens", "light/a.png", image);
    // The same pixels in other file bytes: the comparison is on decoded pixels.
    await mkdir(join(location.goldensDir, "dark"), { recursive: true });
    const png = new PNG({ width: 4, height: 4 });
    png.data = Buffer.from(image.data);
    const otherBytes = PNG.sync.write(png, { deflateLevel: 1, filterType: 0 });
    expect(otherBytes.equals(encode(image))).toBe(false);
    await writeFile(join(location.goldensDir, "dark/a.png"), otherBytes);
    await writeFile(join(location.goldensDir, "provenance.json"), formatProvenance(PROVENANCE));

    const check = await checkGoldens(location, PROVENANCE);
    expect(check.problems).toEqual([]);
  });

  it("reports a missing golden, an extra golden and a difference, and writes the diff image", async () => {
    const image = buildImage(4, 4);
    await put("screenshots", "light/a.png", withPixel(image, 2, 3, [0, 0, 0, 255]));
    await put("screenshots", "dark/a.png", image);
    await put("goldens", "light/a.png", image);
    await put("goldens", "light/old.png", image);
    await writeFile(join(location.goldensDir, "provenance.json"), formatProvenance(PROVENANCE));

    const check = await checkGoldens(location, { ...PROVENANCE, chromium: "154.0.2" });
    expect(check.problems).toEqual([
      { name: "dark/a.png", kind: "missing" },
      {
        name: "light/a.png",
        kind: "differs",
        difference: { kind: "pixels", pixels: 1, box: { left: 2, top: 3, right: 2, bottom: 3 } },
      },
      { name: "light/old.png", kind: "extra" },
    ]);
    expect(check.provenanceWarning).toContain("recorded with Chromium 153.0.1");
    const diff = PNG.sync.read(await readFile(join(location.diffDir, "light/a.png")));
    expect([...diff.data.subarray((3 * 4 + 2) * 4, (3 * 4 + 2) * 4 + 4)]).toEqual([
      255, 0, 255, 255,
    ]);
  });

  it("leaves the goldens of unmeasured themes alone, and still checks the others and provenance.json", async () => {
    const image = buildImage(4, 4);
    // A shard of the theme "light": "dark" is measured by another shard.
    const shard: GoldensLocation = {
      ...location,
      unmeasuredThemes: ["dark"],
      names: ["light/a.png"],
    };
    await put("screenshots", "light/a.png", withPixel(image, 0, 0, [1, 2, 3, 255]));
    await put("goldens", "light/a.png", image);
    await put("goldens", "dark/a.png", image);
    await put("goldens", "dark/old.png", image);
    await put("goldens", "light/old.png", image);
    await writeFile(join(shard.goldensDir, "provenance.json"), formatProvenance(PROVENANCE));

    const check = await checkGoldens(shard, PROVENANCE);
    expect(check.checked).toBe(1);
    expect(check.problems).toEqual([
      {
        name: "light/a.png",
        kind: "differs",
        difference: { kind: "pixels", pixels: 1, box: { left: 0, top: 0, right: 0, bottom: 0 } },
      },
      { name: "light/old.png", kind: "extra" },
    ]);

    await rm(join(shard.goldensDir, "provenance.json"));
    await expect(checkGoldens(shard, PROVENANCE)).rejects.toThrow("provenance.json");
  });

  it("still reports a file outside every theme folder as extra in a shard", async () => {
    const image = buildImage(2, 2);
    const shard: GoldensLocation = {
      ...location,
      unmeasuredThemes: ["dark"],
      names: ["light/a.png"],
    };
    await put("screenshots", "light/a.png", image);
    await put("goldens", "light/a.png", image);
    await put("goldens", "retired/a.png", image);
    await writeFile(join(shard.goldensDir, "provenance.json"), formatProvenance(PROVENANCE));

    expect((await checkGoldens(shard, PROVENANCE)).problems).toEqual([
      { name: "retired/a.png", kind: "extra" },
    ]);
  });

  it("fails when there is no provenance.json", async () => {
    for (const name of names) await put("screenshots", name, buildImage(2, 2));
    await expect(checkGoldens(location, PROVENANCE)).rejects.toThrow("provenance.json");
  });

  it("records only the goldens whose pixels changed, and deletes the stale ones", async () => {
    const image = buildImage(4, 4);
    await put("screenshots", "light/a.png", image);
    await put("screenshots", "dark/a.png", withPixel(image, 0, 0, [1, 2, 3, 255]));
    await put("goldens", "light/a.png", image);
    await put("goldens", "dark/a.png", image);
    await put("goldens", "dark/old.png", image);
    await writeFile(join(location.goldensDir, "provenance.json"), formatProvenance(PROVENANCE));

    const recording = await recordGoldens(location, PROVENANCE);
    expect(recording).toEqual({
      total: 2,
      changed: ["dark/a.png"],
      deleted: ["dark/old.png"],
      provenanceChanged: false,
    });
    expect(await readdir(join(location.goldensDir, "dark"))).toEqual(["a.png"]);
    expect((await checkGoldens(location, PROVENANCE)).problems).toEqual([]);
  });
});
