/**
 * `hydra runner`, from the home it reads to the controller it dials.
 *
 * The daemon is three parts wired together - what this machine joined, what it
 * says about itself, and the loop that holds the connection - and the wiring is
 * the only thing here that no other test covers. What it asserts is that a
 * machine that never joined is told so by name, that one holding an address it
 * cannot dial is told which field to edit, and that one that did dials the
 * controller its `runner.json` points at, with the credential that file holds.
 */
import { lstatSync, mkdtempSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runnerDirIn } from "@hercule/home";
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

  it.each([
    ["is not a URL at all", "not-a-url"],
    ["is a scheme the socket cannot dial", "mailto:a@b.c"],
  ])("refuses to start when the stored controllerUrl %s", async (_case, controllerUrl) => {
    const home = enrolledAt(controllerUrl);

    const outcome = await Effect.runPromise(Effect.result(daemon(home)));

    expect(outcome._tag).toBe("Failure");
    const message = outcome._tag === "Failure" ? outcome.failure.message : "";
    expect(message).toContain("runner.json");
    expect(message).toContain("controllerUrl");
    expect(message).toContain("hydra runner set-controller");
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
      // Put there on the way up, before any session could be placed here: a
      // session whose `PATH` names this directory and finds nothing in it has
      // no way to call Hydra at all (spec 15 section 2).
      const link = join(runnerDirIn(home), "bin", "hydra");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(process.execPath);
    } finally {
      await server.stop(true);
    }
  });

  it("answers who it is on the port its hello reports", async () => {
    // The hello is the only place the runner says where to find it, so a
    // listener that never started, or one on a port the facts do not name,
    // reads here as a machine a browser cannot recognise.
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
      const home = enrolledAt(`http://127.0.0.1:${String(server.port)}`);
      // The listener lives as long as the daemon does, so it is asked from
      // inside the race rather than after it.
      const answered = await Effect.runPromise(
        Effect.raceFirst(
          Effect.as(Effect.ignore(daemon(home)), undefined as unknown),
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
