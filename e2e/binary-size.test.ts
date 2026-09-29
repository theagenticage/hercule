/**
 * `dep-lint` checks the workspace; this test checks the built binary, because
 * a dependency that gets back in is invisible until somebody downloads the
 * result.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../scripts/controller-process";

/**
 * One limit for every target, so it has to fit the biggest one. The same
 * source compiles to 68 MiB on darwin-arm64 and 83 MiB on both Linux targets:
 * the Bun runtime makes the difference, not our code, and CI measures the
 * Linux build. 95 leaves room to grow and is still well under the ~107 that
 * one per-platform CLI package would add, which is what this test is really
 * watching for. Raise it only after finding out why the binary grew.
 */
const SIZE_BUDGET_BYTES = 95 * 1024 * 1024;

const binary = join(ROOT, "hercule");

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
