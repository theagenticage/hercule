/**
 * The Claude Code adapter against the real vendor SDK and the real binary.
 *
 * The stubbed test beside this one says what the adapter makes of the shapes
 * the SDK hands back. Only this one says that those are still the shapes it
 * hands back: a probe is the one thing in Hydra whose whole job is to be right
 * about somebody else's CLI.
 *
 * The config directory is a fresh temporary one, so the answer is
 * `unauthenticated` on any machine - including one whose developer is logged
 * into Claude Code - and the developer's own `~/.claude` is never read or
 * written. A machine with no `claude` on its PATH skips this file rather than
 * failing it: not every checkout has the harness installed.
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

/** An instance home nobody has ever logged into. */
const emptyHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hydra-claude-probe-"));
  homes.push(home);
  return home;
};

/** What `claude --version` prints on this machine, cut to the version itself. */
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
