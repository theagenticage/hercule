/**
 * How big the thing an operator downloads is allowed to be.
 *
 * `dep-lint` says the same thing about the workspace; this says it about the
 * artefact, because a dependency that finds its way back in is invisible until
 * somebody downloads the result.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./harness";

/**
 * The binary is 65 MiB with the Agent SDK in it and was 63 MiB without, so the
 * budget leaves room to grow while staying nowhere near what one per-platform
 * CLI package would cost. It moves only when somebody looks at why it grew.
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
