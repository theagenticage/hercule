/**
 * Names and builds the container image the desktop end-to-end suite runs in
 * (`Dockerfile` in this folder).
 *
 *   node apps/desktop/container/image.ts name    prints the image's name
 *   node apps/desktop/container/image.ts ensure  builds the image unless this
 *                                                machine has it, then prints
 *                                                its name
 *
 * The name is `hercule-desktop-linux:<key>`. The key is a hash of everything
 * the image is built from, so two checkouts that need different images never
 * share a name, and one that needs the same image finds it ready:
 *
 * - the Dockerfile, which pins Node;
 * - the Bun version, from `.bun-version`;
 * - the pnpm version, from `packageManager` in `package.json`;
 * - the Playwright version, from `package.json`. The image holds Playwright's
 *   Chromium, and each Playwright release wants its own build of it.
 *
 * Bun, pnpm and Playwright are passed to the build as `--build-arg`s, so each
 * version is written once in the repository. CI pulls an image of this name
 * from the registry before it builds one (`.github/actions/desktop-e2e-image`).
 *
 * Fails when `docker build` fails, or when a version cannot be read.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const IMAGE_REPOSITORY = "hercule-desktop-linux";
const REPOSITORY_ROOT = join(import.meta.dirname, "../../..");
const CONTAINER_FOLDER = join(REPOSITORY_ROOT, "apps/desktop/container");

/** The versions the image is built with. Each one is the `--build-arg` of the same name. */
export interface ImageVersions {
  readonly BUN_VERSION: string;
  readonly PNPM_VERSION: string;
  readonly PLAYWRIGHT_VERSION: string;
}

/**
 * Reads the Bun, pnpm and Playwright versions the repository pins, from
 * `.bun-version` and the root `package.json`.
 *
 * Fails when one of them is missing or is not an exact version, because a
 * range would make the key stand for different images over time.
 */
export function readImageVersions(): ImageVersions {
  const packageJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")) as {
    packageManager?: string;
    devDependencies?: Record<string, string>;
  };
  const bun = readFileSync(join(REPOSITORY_ROOT, ".bun-version"), "utf8").trim();
  const pnpm = /^pnpm@(\d+\.\d+\.\d+)/.exec(packageJson.packageManager ?? "")?.[1];
  const playwright = packageJson.devDependencies?.playwright;
  for (const [name, version] of [
    [".bun-version", bun],
    ["packageManager in package.json", pnpm],
    ["playwright in package.json", playwright],
  ] as const) {
    if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(
        `${name} is not an exact version (${version ?? "missing"}); the container image cannot be named.`,
      );
    }
  }
  return { BUN_VERSION: bun, PNPM_VERSION: pnpm!, PLAYWRIGHT_VERSION: playwright! };
}

/**
 * Returns the name of the image built from this Dockerfile text and these
 * versions: `hercule-desktop-linux:` and the first 16 hex digits of a SHA-256
 * over both.
 */
export function buildImageName(dockerfile: string, versions: ImageVersions): string {
  const hash = createHash("sha256");
  hash.update(dockerfile);
  for (const [name, version] of Object.entries(versions)) hash.update(`\n${name}=${version}`);
  return `${IMAGE_REPOSITORY}:${hash.digest("hex").slice(0, 16)}`;
}

/** Returns the name of the image the checked-out repository needs. */
export function readImageName(): string {
  return buildImageName(
    readFileSync(join(CONTAINER_FOLDER, "Dockerfile"), "utf8"),
    readImageVersions(),
  );
}

/** Builds the image the checked-out repository needs, under its name. Fails when the build fails. */
function buildImage(name: string): void {
  const buildArguments = Object.entries(readImageVersions()).flatMap(([key, value]) => [
    "--build-arg",
    `${key}=${value}`,
  ]);
  // Build output goes to stderr, so stdout stays the image's name alone.
  const build = spawnSync("docker", ["build", "--tag", name, ...buildArguments, CONTAINER_FOLDER], {
    stdio: ["ignore", process.stderr, process.stderr],
  });
  if (build.status !== 0) {
    throw new Error(
      `docker build of ${name} failed${build.error ? `: ${build.error.message}` : ""}.`,
    );
  }
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command !== "name" && command !== "ensure") {
    console.error("Usage: node apps/desktop/container/image.ts name|ensure");
    process.exit(1);
  }
  const name = readImageName();
  if (command === "ensure") {
    const inspect = spawnSync("docker", ["image", "inspect", name], { stdio: "ignore" });
    if (inspect.status !== 0) buildImage(name);
  }
  console.log(name);
}
