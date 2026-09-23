/**
 * Tests `hercule runner`, from the Hercule Home it reads to the controller it
 * connects to.
 *
 * The daemon wires together three parts: the stored join, the facts probe,
 * and the reconnect loop. No other test covers that wiring. These tests check
 * that:
 *
 * - a machine that never joined gets an error that names the missing file;
 * - a machine with an invalid controller URL gets an error that names the field
 *   to edit;
 * - a machine that joined connects to the controller in its `runner.json`,
 *   with the credential stored there.
 */
import { lstatSync, mkdtempSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { locateRunnerDir } from "@hercule/home";
import { runDaemon } from "./daemon";

const homes: Array<string> = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const createTemporaryHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hercule-daemon-"));
  homes.push(home);
  return home;
};

/** Creates a Hercule Home whose `runner.json` points at `controllerUrl`. */
const createEnrolledHome = (controllerUrl: string): string => {
  const home = createTemporaryHome();
  mkdirSync(locateRunnerDir(home), { recursive: true });
  writeFileSync(
    join(locateRunnerDir(home), "runner.json"),
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

describe("runDaemon", () => {
  it("names the missing file on a machine that never joined", async () => {
    const home = createTemporaryHome();

    const outcome = await Effect.runPromise(Effect.result(runDaemon(home)));

    expect(outcome._tag).toBe("Failure");
    const message = outcome._tag === "Failure" ? outcome.failure.message : "";
    expect(message).toContain(join(locateRunnerDir(home), "runner.json"));
    expect(message).toContain("hercule runner join");
  });

  it.each([
    ["is not a URL at all", "not-a-url"],
    ["uses a scheme the socket cannot connect to", "mailto:a@b.c"],
  ])("fails to start when the stored controllerUrl %s", async (_case, controllerUrl) => {
    const home = createEnrolledHome(controllerUrl);

    const outcome = await Effect.runPromise(Effect.result(runDaemon(home)));

    expect(outcome._tag).toBe("Failure");
    const message = outcome._tag === "Failure" ? outcome.failure.message : "";
    expect(message).toContain("runner.json");
    expect(message).toContain("controllerUrl");
    expect(message).toContain("hercule runner set-controller");
  });

  it("connects to the controller in runner.json, with the stored credential", async () => {
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
      const home = createEnrolledHome(`http://127.0.0.1:${String(server.port)}`);
      // The loop retries for ever, so the race stops it as soon as the first
      // attempt reaches the listener.
      await Effect.runPromise(
        Effect.raceFirst(
          Effect.ignore(runDaemon(home)),
          Effect.promise(async () => {
            for (let attempt = 0; attempt < 200 && seen.length === 0; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }),
        ),
      );

      expect(seen[0]?.path).toBe("/api/v1/runners/socket");
      expect(seen[0]?.authorization).toBe("Bearer the-credential-the-join-handed-back");
      // Installed at startup, before any session can be placed here. A session
      // whose `PATH` holds this directory but finds nothing in it cannot call
      // Hercule at all (spec 15 section 2).
      const link = join(locateRunnerDir(home), "bin", "hercule");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(process.execPath);
    } finally {
      await server.stop(true);
    }
  });

  it("serves its identity on the port its hello reports", async () => {
    // The hello is the only place the runner reports where to find it. If the
    // listener never started, or runs on a different port than the facts
    // report, a browser cannot recognise the machine.
    let greeted: ((hello: unknown) => void) | undefined;
    const hello = new Promise<{ facts: { identityPort: number } }>((resolve) => {
      greeted = resolve as (hello: unknown) => void;
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, self) =>
        self.upgrade(request) ? undefined : new Response("no", { status: 401 }),
      websocket: {
        message(_socket, said) {
          greeted?.(JSON.parse(String(said)) as unknown);
        },
      },
    });

    try {
      const home = createEnrolledHome(`http://127.0.0.1:${String(server.port)}`);
      // The listener lives only as long as the daemon, so the request is made
      // inside the race, not after it.
      const answered = await Effect.runPromise(
        Effect.raceFirst(
          Effect.as(Effect.ignore(runDaemon(home)), undefined as unknown),
          Effect.promise(async () => {
            const said = await hello;
            const answer = await fetch(
              `http://127.0.0.1:${String(said.facts.identityPort)}/identity`,
            );
            return await answer.json();
          }),
        ),
      );

      expect(answered).toEqual({ runnerId: "0199e0e7-0000-7000-8000-000000000000" });
    } finally {
      await server.stop(true);
    }
  });
});
