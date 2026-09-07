/**
 * `dep-lint` guards the workspace; this guards the artefact, because a
 * dependency that finds its way back in is invisible until somebody downloads
 * the result.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./harness";

/**
 * One number for every target, so it has to clear the biggest one. The same
 * source compiles to 68 MiB on darwin-arm64 and 83 MiB on both Linux targets:
 * the Bun runtime is what differs, not anything of ours, and CI weighs the
 * Linux build. 95 leaves room to grow and is still well under the ~107 that one
 * per-platform CLI package coming back would make, which is the thing this is
 * really watching for. Raise it only after looking at why it grew.
 */
const SIZE_BUDGET_BYTES = 95 * 1024 * 1024;

const binary = join(ROOT, "hydra");

const MIB = 1024 * 1024;

describe("the release binary", () => {
  it("stays under the size budget", () => {
    if (!existsSync(binary)) {
      throw new Error(
        `no binary at ${binary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
      );
    }

    const bytes = statSync(binary).size;

    expect(
      bytes,
      `the binary is ${(bytes / MIB).toFixed(1)} MiB, over the ${(SIZE_BUDGET_BYTES / MIB).toFixed(1)} MiB budget`,
    ).toBeLessThanOrEqual(SIZE_BUDGET_BYTES);
  });
});
