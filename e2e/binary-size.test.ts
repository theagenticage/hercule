/**
 * How big the thing an operator downloads is allowed to be.
 *
 * Hydra ships as one self-contained binary, and the first vendor SDK in the
 * tree brings eight per-platform packages with a 196 MB CLI inside them. The
 * install excludes them; this is what says so about the artefact rather than
 * about the lockfile, because a dependency that finds its way back in is
 * invisible until somebody downloads the result.
 *
 * The budget is the size the binary really is plus room to grow. It moves only
 * when somebody looks at why it grew.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./harness";

/**
 * The binary is 65 MiB with the Agent SDK in it, and was 63 MiB without: the
 * SDK itself costs under two. 80 leaves room to grow and is still nowhere near
 * what one per-platform CLI package would cost, which is the thing this is
 * really watching for.
 */
const SIZE_BUDGET_BYTES = 80 * 1024 * 1024;

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
