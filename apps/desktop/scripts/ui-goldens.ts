/**
 * The goldens of `pnpm ui:metrics` (scripts/ui-metrics.ts): the committed
 * screenshots of the desktop screens, and the exact comparison of a run's
 * screenshots with them. The goldens are the app's own pixel reference
 * (docs/adr/0047-the-desktop-app-is-its-own-pixel-reference.md).
 *
 * The goldens are `<goldensDir>/<theme>/<screen>.png`, one per variant that
 * `ui:metrics` screenshots, and `<goldensDir>/provenance.json`, which records
 * the browser that drew them. A run passes when every golden has a screenshot
 * with the same size and the same decoded pixels (all four RGBA bytes), and
 * no golden is left over. There is no tolerance: a token change that moves
 * pixels must show up as a change of the goldens in the diff.
 *
 * Runs on plain Node by stripping types, so it uses only syntax that
 * stripping can erase: no enums, namespaces or parameter properties.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { PNG } from "pngjs";
import type { DecodedImage } from "./ui-pixels.ts";

/** The file in the goldens folder that records which browser drew the goldens. */
export const PROVENANCE_FILE = "provenance.json";

/** The browser and machine that drew the goldens, or that draws this run. */
export interface Provenance {
  /** The Chromium version, as `browser.version()` returns it. */
  readonly chromium: string;
  /** The Playwright version. */
  readonly playwright: string;
  /** The operating system, as `process.platform` names it. */
  readonly platform: string;
  /** The CPU architecture, as `process.arch` names it. */
  readonly arch: string;
}

/** How one screenshot differs from its golden, in device pixels. */
export type GoldenDifference =
  | {
      readonly kind: "pixels";
      /** How many pixels have at least one RGBA byte that differs. */
      readonly pixels: number;
      /** The smallest rectangle holding every differing pixel; both ends are included. */
      readonly box: {
        readonly left: number;
        readonly top: number;
        readonly right: number;
        readonly bottom: number;
      };
    }
  | {
      readonly kind: "size";
      readonly golden: { readonly width: number; readonly height: number };
      readonly screenshot: { readonly width: number; readonly height: number };
    };

/** What is wrong with one golden: `name` is its path in the goldens folder, such as `whitehaven/thread-long.png`. */
export type GoldenProblem =
  | { readonly name: string; readonly kind: "missing" }
  | { readonly name: string; readonly kind: "extra" }
  | { readonly name: string; readonly kind: "differs"; readonly difference: GoldenDifference };

/** The result of comparing a run with the goldens. */
export interface GoldensCheck {
  /** How many screenshots the run took. */
  readonly checked: number;
  /** What is wrong with the goldens, in the order of their names. Empty when the run passes. */
  readonly problems: ReadonlyArray<GoldenProblem>;
  /** The sentence that says the goldens were drawn by another browser or machine than this run. Null when they were not, or when no problem needs it. */
  readonly provenanceWarning: string | null;
  /** The folder of the diff images, one per screenshot whose pixels differ. */
  readonly diffDir: string;
}

/** The result of recording the goldens from a run. */
export interface GoldensRecording {
  /** How many goldens exist now. */
  readonly total: number;
  /** The names of the goldens written because they are new or their pixels changed. */
  readonly changed: ReadonlyArray<string>;
  /** The names of the goldens deleted because no variant has them any more. */
  readonly deleted: ReadonlyArray<string>;
  /** Whether `provenance.json` was written because it changed. */
  readonly provenanceChanged: boolean;
}

/** The folders and files a comparison or a recording reads and writes. */
export interface GoldensLocation {
  /** The committed goldens. */
  readonly goldensDir: string;
  /** The folder holding this run's screenshots, laid out like the goldens. */
  readonly screenshotsDir: string;
  /** The folder the diff images are written to. */
  readonly diffDir: string;
  /** The themes the run did not measure. A golden of such a theme is neither missing nor extra, because a CI shard measures only some themes. Empty for a full run. */
  readonly unmeasuredThemes: ReadonlyArray<string>;
  /** The names of the screenshots the run took, such as `whitehaven/thread-long.png`. */
  readonly names: ReadonlyArray<string>;
}

/** Returns the name of the golden of a screen in a theme. */
export function buildGoldenName(theme: string, screen: string): string {
  return `${theme}/${screen}.png`;
}

/** Returns the provenance of the browser and machine of this run. */
export function buildProvenance(chromiumVersion: string, playwrightVersion: string): Provenance {
  return {
    chromium: chromiumVersion,
    playwright: playwrightVersion,
    platform: process.platform,
    arch: process.arch,
  };
}

/** Returns the text of `provenance.json` for `provenance`. */
export function formatProvenance(provenance: Provenance): string {
  return `${JSON.stringify(provenance, null, 2)}\n`;
}

/** Parses the text of `provenance.json`. Fails when it is not a provenance, naming the field that is wrong. */
export function parseProvenance(text: string): Provenance {
  const parsed: unknown = JSON.parse(text);
  const record =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const field = (name: keyof Provenance): string => {
    const value = record[name];
    if (typeof value !== "string") {
      throw new Error(`${PROVENANCE_FILE} has no text field "${name}".`);
    }
    return value;
  };
  return {
    chromium: field("chromium"),
    playwright: field("playwright"),
    platform: field("platform"),
    arch: field("arch"),
  };
}

/**
 * Returns the sentence that says the goldens were drawn by another browser
 * than this run uses, or null when `recorded` and `current` agree on Chromium,
 * platform and architecture. The Playwright version is not compared: it only
 * matters through the Chromium it brings.
 */
export function describeProvenanceMismatch(
  recorded: Provenance,
  current: Provenance,
): string | null {
  if (
    recorded.chromium === current.chromium &&
    recorded.platform === current.platform &&
    recorded.arch === current.arch
  ) {
    return null;
  }
  return (
    `The goldens were recorded with Chromium ${recorded.chromium} on ${recorded.platform} ${recorded.arch}; ` +
    `this run uses Chromium ${current.chromium} on ${current.platform} ${current.arch}. ` +
    "Every pixel may differ for that reason alone."
  );
}

/**
 * Compares a screenshot with its golden. Returns null when both have the same
 * size and every RGBA byte of every pixel is equal. Otherwise returns the
 * size mismatch, or the number of differing pixels and their bounding box.
 */
export function compareWithGolden(
  golden: DecodedImage,
  screenshot: DecodedImage,
): GoldenDifference | null {
  if (golden.width !== screenshot.width || golden.height !== screenshot.height) {
    return {
      kind: "size",
      golden: { width: golden.width, height: golden.height },
      screenshot: { width: screenshot.width, height: screenshot.height },
    };
  }
  let pixels = 0;
  let left = golden.width;
  let top = golden.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < golden.height; y += 1) {
    for (let x = 0; x < golden.width; x += 1) {
      const at = (y * golden.width + x) * 4;
      if (
        golden.data[at] === screenshot.data[at] &&
        golden.data[at + 1] === screenshot.data[at + 1] &&
        golden.data[at + 2] === screenshot.data[at + 2] &&
        golden.data[at + 3] === screenshot.data[at + 3]
      ) {
        continue;
      }
      pixels += 1;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = y;
    }
  }
  return pixels === 0 ? null : { kind: "pixels", pixels, box: { left, top, right, bottom } };
}

/**
 * Builds the picture of a difference: the golden at a quarter of its strength
 * (each colour a quarter of the way from white), with every pixel that
 * differs in opaque magenta, as RGBA. Fails when the two sizes differ.
 */
export function buildGoldenDiffImage(golden: DecodedImage, screenshot: DecodedImage): DecodedImage {
  if (golden.width !== screenshot.width || golden.height !== screenshot.height) {
    throw new Error("A diff image needs a golden and a screenshot of the same size.");
  }
  const data = new Uint8Array(golden.data.length);
  for (let at = 0; at < data.length; at += 4) {
    const same =
      golden.data[at] === screenshot.data[at] &&
      golden.data[at + 1] === screenshot.data[at + 1] &&
      golden.data[at + 2] === screenshot.data[at + 2] &&
      golden.data[at + 3] === screenshot.data[at + 3];
    if (!same) {
      data.set([255, 0, 255, 255], at);
      continue;
    }
    for (let channel = 0; channel < 3; channel += 1) {
      data[at + channel] = Math.round(255 - (255 - golden.data[at + channel]!) / 4);
    }
    data[at + 3] = 255;
  }
  return { width: golden.width, height: golden.height, data };
}

/** Reads a file. Returns null when it does not exist. */
async function readFileIfExists(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Lists the files under `dir`, as paths relative to it with `/` separators, sorted. Returns an empty list when `dir` does not exist. */
async function listFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

/** Returns the names of the files in the goldens folder that no screenshot corresponds to. `provenance.json` and the goldens of unmeasured themes are left out. */
async function listExtraGoldens(location: GoldensLocation): Promise<string[]> {
  const known = new Set<string>([...location.names, PROVENANCE_FILE]);
  return (await listFiles(location.goldensDir)).filter(
    (name) =>
      !known.has(name) && !location.unmeasuredThemes.includes(name.split("/")[0] ?? ""),
  );
}

/** Encodes a decoded image as the bytes of a PNG file. */
function encodePng(image: DecodedImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

/**
 * Compares every screenshot of the run with its golden, exactly. Returns the
 * problems found: a golden that is missing, a golden no screenshot belongs
 * to, a size that differs, and pixels that differ. For each screenshot whose
 * pixels differ it writes a diff image to `<diffDir>/<name>`. Fails when
 * `provenance.json` is missing or invalid, since then nothing says what the
 * goldens were drawn with.
 */
export async function checkGoldens(
  location: GoldensLocation,
  current: Provenance,
): Promise<GoldensCheck> {
  const problems: GoldenProblem[] = [];
  await rm(location.diffDir, { recursive: true, force: true });
  for (const name of [...location.names].sort()) {
    const goldenBytes = await readFileIfExists(join(location.goldensDir, name));
    if (goldenBytes === null) {
      problems.push({ name, kind: "missing" });
      continue;
    }
    const screenshotBytes = await readFile(join(location.screenshotsDir, name));
    // Equal files decode to equal pixels, so most goldens need no decoding.
    if (goldenBytes.equals(screenshotBytes)) continue;
    const golden = PNG.sync.read(goldenBytes);
    const screenshot = PNG.sync.read(screenshotBytes);
    const difference = compareWithGolden(golden, screenshot);
    if (difference === null) continue;
    problems.push({ name, kind: "differs", difference });
    if (difference.kind === "pixels") {
      const diffPath = join(location.diffDir, name);
      await mkdir(dirname(diffPath), { recursive: true });
      await writeFile(diffPath, encodePng(buildGoldenDiffImage(golden, screenshot)));
    }
  }
  for (const name of await listExtraGoldens(location)) problems.push({ name, kind: "extra" });
  problems.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const provenanceBytes = await readFileIfExists(join(location.goldensDir, PROVENANCE_FILE));
  if (provenanceBytes === null) {
    throw new Error(
      `There is no ${PROVENANCE_FILE} in ${location.goldensDir}, so it is not known what drew the goldens. ` +
        "Record them with `pnpm --filter @hercule/desktop ui:metrics --write-goldens`.",
    );
  }
  const provenanceWarning =
    problems.length === 0
      ? null
      : describeProvenanceMismatch(parseProvenance(provenanceBytes.toString("utf8")), current);
  return { checked: location.names.length, problems, provenanceWarning, diffDir: location.diffDir };
}

/**
 * Records the run's screenshots as the goldens. Writes only the goldens that
 * are new or whose decoded pixels changed, so that the git diff shows exactly
 * what moved, deletes the goldens that no screenshot belongs to, and writes
 * `provenance.json` when it changed. Returns what it did.
 */
export async function recordGoldens(
  location: GoldensLocation,
  current: Provenance,
): Promise<GoldensRecording> {
  const changed: string[] = [];
  for (const name of [...location.names].sort()) {
    const screenshotBytes = await readFile(join(location.screenshotsDir, name));
    const goldenBytes = await readFileIfExists(join(location.goldensDir, name));
    if (
      goldenBytes !== null &&
      (goldenBytes.equals(screenshotBytes) ||
        compareWithGolden(PNG.sync.read(goldenBytes), PNG.sync.read(screenshotBytes)) === null)
    ) {
      continue;
    }
    const goldenPath = join(location.goldensDir, name);
    await mkdir(dirname(goldenPath), { recursive: true });
    await writeFile(goldenPath, screenshotBytes);
    changed.push(name);
  }
  const deleted = await listExtraGoldens(location);
  for (const name of deleted) await rm(join(location.goldensDir, name));

  const provenancePath = join(location.goldensDir, PROVENANCE_FILE);
  const provenanceText = formatProvenance(current);
  const provenanceBytes = await readFileIfExists(provenancePath);
  const provenanceChanged = provenanceBytes?.toString("utf8") !== provenanceText;
  if (provenanceChanged) await writeFile(provenancePath, provenanceText);
  return { total: location.names.length, changed, deleted, provenanceChanged };
}

/** Returns the text that describes one problem on one line. */
function describeProblem(problem: GoldenProblem, diffDir: string): string {
  switch (problem.kind) {
    case "missing":
      return `- ${problem.name}: no golden. Record it with --write-goldens.`;
    case "extra":
      return `- ${problem.name}: a golden that no screen of this run belongs to. Delete it, or record with --write-goldens.`;
    case "differs": {
      const { difference } = problem;
      if (difference.kind === "size") {
        const { golden, screenshot } = difference;
        return `- ${problem.name}: the golden is ${String(golden.width)}x${String(golden.height)} and the screenshot is ${String(screenshot.width)}x${String(screenshot.height)}.`;
      }
      const { box } = difference;
      return (
        `- ${problem.name}: ${String(difference.pixels)} pixels differ, within x ${String(box.left)}-${String(box.right)}, ` +
        `y ${String(box.top)}-${String(box.bottom)}. Diff image: ${join(diffDir, problem.name)}`
      );
    }
  }
}

/** Returns the "Goldens" section of the report for a comparison, as Markdown. */
export function formatGoldensCheck(check: GoldensCheck): string {
  if (check.problems.length === 0) {
    return `## Goldens: passed\n\nAll ${String(check.checked)} screenshots equal their goldens, pixel for pixel.\n`;
  }
  const lines = [`## Goldens: ${String(check.problems.length)} failed`, ""];
  if (check.provenanceWarning !== null) lines.push(check.provenanceWarning, "");
  lines.push(...check.problems.map((problem) => describeProblem(problem, check.diffDir)));
  lines.push(
    "",
    "If the change is meant, run `pnpm --filter @hercule/desktop ui:metrics --write-goldens`, look at every changed golden, and commit them.",
  );
  return `${lines.join("\n")}\n`;
}

/** Returns the "Goldens" section of the report for a recording, as Markdown. */
export function formatGoldensRecording(recording: GoldensRecording): string {
  const lines = [
    "## Goldens: recorded",
    "",
    `${String(recording.total)} goldens exist now. ${String(recording.changed.length)} were written and ${String(recording.deleted.length)} deleted.`,
  ];
  if (recording.changed.length > 0) {
    lines.push("", "Changed:", ...recording.changed.map((name) => `- ${name}`));
  }
  if (recording.deleted.length > 0) {
    lines.push("", "Deleted:", ...recording.deleted.map((name) => `- ${name}`));
  }
  if (recording.provenanceChanged) lines.push("", `${PROVENANCE_FILE} changed.`);
  if (recording.changed.length + recording.deleted.length > 0 || recording.provenanceChanged) {
    lines.push("", "Look at every changed golden before committing it.");
  }
  return `${lines.join("\n")}\n`;
}
