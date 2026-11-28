/**
 * Finds the Codex binary the real-Codex tests run against. Returns the path in
 * `HERCULE_CODEX_TEST_BINARY` when it is set, so a test can use a pinned
 * release without changing `PATH`, and otherwise the `codex` on `PATH`.
 * Returns `undefined` when there is neither, and those tests skip.
 */
export const findCodexTestBinary = (): string | undefined =>
  process.env["HERCULE_CODEX_TEST_BINARY"] ?? Bun.which("codex") ?? undefined;
