/**
 * Finds the `agy` binary the real-`agy` tests run against. Returns the path in
 * `HERCULE_AGY_TEST_BINARY` when it is set, so a test can use a pinned release
 * without changing `PATH`, and otherwise the `agy` on `PATH`. Returns
 * `undefined` when there is neither, and those tests skip.
 */
export const findAgyTestBinary = (): string | undefined =>
  process.env["HERCULE_AGY_TEST_BINARY"] ?? Bun.which("agy") ?? undefined;
