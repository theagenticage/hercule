/**
 * Writes `apps/runner/src/providers/codex/generated`.
 *
 * Unlike the other generated trees this one is checked in: `pnpm typecheck`
 * would otherwise need a `codex` binary on the machine, and CI has none. The
 * whole tree is committed rather than only the files the adapter uses, because
 * `git diff` over it serves as the vendor's protocol changelog, and pruning it
 * would mean editing generated output.
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { $ } from "bun";
import { CODEX_VERSION } from "../packages/home/src/version";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}apps/runner/src/providers/codex/generated`;

const reported = (await $`codex --version`.nothrow().quiet().text()).trim();
// The types and the version constant must match: types from another release
// would describe a protocol this build does not speak.
if (!reported.includes(CODEX_VERSION)) {
  console.error(`codex on PATH reports "${reported}", not ${CODEX_VERSION}`);
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
await $`codex app-server generate-ts --out ${out}`;
