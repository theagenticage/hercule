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
 *   with the credential stored there;
 * - the folders a crashed run left behind are wiped at start, including the
 *   scratch folders of token logins in the temp directory;
 * - a leftover the runner cannot delete is logged with its path and reason,
 *   and the runner starts anyway;
 * - the folders harness processes of a crashed run left in the temp directory
 *   are removed through the runner's record, and a folder with a matching name
 *   that the runner never recorded stays.
 */
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Logger } from "effect";
import { locateRunnerDir } from "@hercule/home";
import { runDaemon } from "./daemon";
import { makeRecordedFolders } from "./recorded-folders";
import { SETUP_TOKEN_FOLDER_PREFIX } from "./harnesses/setup-token-folder";

const homes: Array<string> = [];
const lockedFolders: Array<string> = [];

afterEach(() => {
  // Unlock first: a folder without write permission cannot be emptied.
  for (const folder of lockedFolders.splice(0)) chmodSync(folder, 0o700);
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
      // What a crashed run leaves: the session skills folder of a start.
      const storageDir = join(locateRunnerDir(home), "deadbeefdeadbeef");
      mkdirSync(
        join(storageDir, "session-skills", "0199e0e7-0000-7000-8000-0000000000ff-start", "skills"),
        { recursive: true },
      );
      // What a killed runner leaves in the temp directory: the scratch folder
      // of a token login, older than any login may run.
      const leftover = mkdtempSync(join(tmpdir(), SETUP_TOKEN_FOLDER_PREFIX));
      const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      utimesSync(leftover, longAgo, longAgo);
      // The loop retries for ever, so the race stops it as soon as the first
      // attempt reaches the listener.
      await Effect.runPromise(
        Effect.raceFirst(
          Effect.ignore(runDaemon(home)),
          Effect.promise(async () => {
            for (let attempt = 0; attempt < 1000 && seen.length === 0; attempt++) {
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
      // No session outlives the process, so nothing of the last run's skills stays.
      expect(existsSync(join(storageDir, "session-skills"))).toBe(false);
      expect(existsSync(leftover)).toBe(false);
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

  it("starts anyway, and logs the path and reason, when a leftover cannot be deleted", async () => {
    const seen: Array<string> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push(new URL(request.url).pathname);
        return new Response("no", { status: 401 });
      },
    });
    const warnings: Array<string> = [];
    const logger = Logger.make<unknown, void>((options) => {
      if (options.logLevel === "Warn") warnings.push(String(options.message));
    });

    try {
      const home = createEnrolledHome(`http://127.0.0.1:${String(server.port)}`);
      // A file its owner cannot delete: the folder around it has no write
      // permission. This is what a container running as root leaves in a
      // session's scratch folder, without the test needing root.
      const storageDir = join(locateRunnerDir(home), "deadbeefdeadbeef");
      const blockedFolder = join(storageDir, "scratch", "0199e0e7-0000-7000-8000-0000000000aa");
      mkdirSync(blockedFolder, { recursive: true });
      writeFileSync(join(blockedFolder, "app.dll"), "");
      chmodSync(blockedFolder, 0o500);
      lockedFolders.push(blockedFolder);
      // A later leftover must still be deleted after the blocked one.
      const attachmentsFolder = join(
        storageDir,
        "attachments",
        "0199e0e7-0000-7000-8000-0000000000bb",
      );
      mkdirSync(attachmentsFolder, { recursive: true });

      await Effect.runPromise(
        Effect.raceFirst(
          Effect.ignore(runDaemon(home)),
          Effect.promise(async () => {
            for (let attempt = 0; attempt < 1000 && seen.length === 0; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }),
        ).pipe(Effect.provide(Logger.layer([logger]))),
      );

      // The runner got as far as dialling the controller.
      expect(seen[0]).toBe("/api/v1/runners/socket");
      expect(
        warnings.some(
          (line) => line.includes(join(storageDir, "scratch")) && line.includes("EACCES"),
        ),
      ).toBe(true);
      expect(existsSync(join(storageDir, "attachments"))).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
  it("removes the folders a crashed run's harness processes left, found through the record, and no other", async () => {
    const seen: Array<string> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push(new URL(request.url).pathname);
        return new Response("no", { status: 401 });
      },
    });
    const lines: Array<string> = [];
    const logger = Logger.make<unknown, void>((options) => {
      lines.push(`${options.logLevel}: ${String(options.message)}`);
    });

    try {
      const home = createEnrolledHome(`http://127.0.0.1:${String(server.port)}`);
      const storageDir = join(locateRunnerDir(home), "deadbeefdeadbeef");
      // What a crashed run leaves: folders its adapters made and never removed,
      // in the temp directory and in a Harness Home.
      const folders = makeRecordedFolders(join(locateRunnerDir(home), "recorded-folders"));
      const harnessHome = join(storageDir, "providers", "0199e0e7-0000-7000-8000-0000000000cc");
      mkdirSync(harnessHome, { recursive: true });
      const tempFolder = folders.make(tmpdir(), "hercule-agy-");
      const logFolder = folders.make(harnessHome, "hercule-log-");
      writeFileSync(join(logFolder, "agy.log"), "the account's email");
      // A process of another runner on this machine: same name pattern, no record.
      const stranger = mkdtempSync(join(tmpdir(), "hercule-agy-"));
      homes.push(stranger);

      await Effect.runPromise(
        Effect.raceFirst(
          Effect.ignore(runDaemon(home)),
          Effect.promise(async () => {
            for (let attempt = 0; attempt < 1000 && seen.length === 0; attempt++) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }),
        ).pipe(Effect.provide(Logger.layer([logger]))),
      );

      expect(seen[0]).toBe("/api/v1/runners/socket");
      expect(existsSync(tempFolder)).toBe(false);
      expect(existsSync(logFolder)).toBe(false);
      expect(existsSync(stranger)).toBe(true);
      expect(lines).toContain(`Info: removed the leftover folder ${tempFolder} of an earlier run`);
      expect(lines).toContain(`Info: removed the leftover folder ${logFolder} of an earlier run`);
    } finally {
      await server.stop(true);
    }
  });
});
