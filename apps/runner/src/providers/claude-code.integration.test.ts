/**
 * Proves the vendor SDK still hands back the shapes the stubbed test beside
 * this one assumes. Runs against a temporary config directory, so it never
 * reads or writes the developer's own `~/.claude`, and skips when there is no
 * `claude` on PATH.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import { PROBE_DEADLINE, claudeCode } from "./claude-code";
import type { ProviderRunnerContext } from "./index";

const binary = Bun.which("claude") ?? undefined;

const homes: Array<string> = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const emptyHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hydra-claude-probe-"));
  homes.push(home);
  return home;
};

const installedVersion = async (path: string): Promise<string> => {
  const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
  const printed = await new Response(child.stdout).text();
  await child.exited;
  expect(child.exitCode, printed).toBe(0);
  return /\d+\.\d+\.\d+\S*/.exec(printed)?.[0] ?? printed.trim();
};

describe.skipIf(binary === undefined)("the real Claude adapter on this machine", () => {
  it("reports an empty config directory as not logged in, with the machine's version and models", async () => {
    const context: ProviderRunnerContext = {
      home: emptyHome(),
      binary: binary!,
      env: { PATH: process.env["PATH"] ?? "" },
    };

    const started = Date.now();
    const probed = await Effect.runPromise(claudeCode.probe(context, {}));
    const took = Date.now() - started;

    // Not `error`: an empty config dir is a machine nobody has logged in on,
    // and telling that apart from a broken harness is the whole point.
    expect(probed.auth.status, probed.auth.message ?? "").toBe("unauthenticated");
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.harnessVersion).toBe(await installedVersion(binary!));
    // The catalogue is probed, never authored: an empty one would leave the
    // composer with nothing to offer on a perfectly good machine.
    expect(probed.models.length).toBeGreaterThan(0);
    for (const model of probed.models) expect(model.slug).not.toBe("");

    expect(took).toBeLessThan(Duration.toMillis(PROBE_DEADLINE));
  });
});
