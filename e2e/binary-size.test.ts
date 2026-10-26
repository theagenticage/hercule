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
 * One limit for every target, so it has to fit the biggest one. The Bun
 * runtime makes up most of the binary, not our code, and CI measures the Linux
 * build. With Bun 1.4.3 that build was 94.7 MiB; Bun 1.4.4 ships a runtime
 * 17.5 MiB bigger, and the same source now compiles to 112.2 MiB. 125 leaves
 * room to grow and is still well under the ~136 that one per-platform CLI
 * package would add, which is what this test is really watching for. Raise it
 * only after finding out why the binary grew.
 */
const SIZE_BUDGET_BYTES = 125 * 1024 * 1024;

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
