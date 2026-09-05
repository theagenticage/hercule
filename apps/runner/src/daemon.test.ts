/**
 * `hydra runner`, from the home it reads to the controller it dials.
 *
 * The daemon is three parts wired together - what this machine joined, what it
 * says about itself, and the loop that holds the connection - and the wiring is
 * the only thing here that no other test covers. What it asserts is that a
 * machine that never joined is told so by name, and that one that did dials the
 * controller its `runner.json` points at, with the credential that file holds.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runnerDirIn } from "@hydra/home";
import { currentFacts, DEFAULT_IDENTITY_PORT } from "./facts";
import { daemon } from "./daemon";

const homes: Array<string> = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const temporaryHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hydra-daemon-"));
  homes.push(home);
  return home;
};

/** A home holding a `runner.json` that points at this address. */
const enrolledAt = (controllerUrl: string): string => {
  const home = temporaryHome();
  mkdirSync(runnerDirIn(home), { recursive: true });
  writeFileSync(
    join(runnerDirIn(home), "runner.json"),
    JSON.stringify({
      runnerId: "0199e0e7-0000-7000-8000-000000000000",
      credential: "the-credential-the-join-handed-back",
      controllerUrl,
      controllerIdentityId: "0199e0e7-1111-7000-8000-000000000000",
      controllerPublicKey: "AAAA",
      storageDirectory: "deadbeefdeadbeef",
    }),
  );
  return home;
};

describe("the runner daemon", () => {
  it("says which file a machine that never joined is missing", async () => {
    const home = temporaryHome();

    const outcome = await Effect.runPromise(Effect.result(daemon(home)));

    expect(outcome._tag).toBe("Failure");
    const message = outcome._tag === "Failure" ? outcome.failure.message : "";
    expect(message).toContain(join(runnerDirIn(home), "runner.json"));
    expect(message).toContain("hydra runner join");
  });

  it("dials the controller its runner.json names, with the credential it holds", async () => {
    const seen: Array<{ path: string; authorization: string | null }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
        });
        return new Response("no", { status: 401 });
      },
    });

    try {
      const home = enrolledAt(`http://127.0.0.1:${String(server.port)}`);
      // The loop retries for ever, so it runs only for as long as it takes the
      // first attempt to reach the listener.
      await Effect.runPromise(
        Effect.raceFirst(
          Effect.ignore(daemon(home)),
          Effect.promise(async () => {
            for (let attempt = 0; attempt < 200 && seen.length === 0; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }),
        ),
      );

      expect(seen[0]?.path).toBe("/api/v1/runners/socket");
      expect(seen[0]?.authorization).toBe("Bearer the-credential-the-join-handed-back");
    } finally {
      await server.stop(true);
    }
  });
});

describe("what this machine says about itself", () => {
  it("states the machine it is on and the port it will answer on", async () => {
    const facts = await Effect.runPromise(currentFacts);

    expect(facts.os).not.toBe("");
    expect(facts.arch).not.toBe("");
    expect(facts.totalMemoryBytes).toBeGreaterThan(0);
    expect(facts.identityPort).toBe(DEFAULT_IDENTITY_PORT);
    // Nothing has been looked for yet; the probe is its own piece of work.
    expect(facts.toolchains).toEqual([]);
    expect(facts.providers).toEqual([]);
    expect(facts.docker).toBe(false);
  });
});
