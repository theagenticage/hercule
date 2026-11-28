/**
 * Tests the files of an Antigravity account in its Harness Home: reading the
 * login file and deleting one conversation's files. Each test uses a real
 * temporary folder laid out the way `agy` lays out its files.
 */
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { cleanupHomes, createScratchHome } from "../testing";
import { APP_DATA_DIR, deleteSessionFiles, readLoginFile } from "./harness-home";

const isRoot = process.getuid?.() === 0;

afterEach(() => {
  cleanupHomes();
});

const createHome = (): string => createScratchHome("antigravity");

/** Writes `content` to a file, creating the folders above it. */
const createFile = (path: string, content = "{}"): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
};

const tokenPath = (home: string): string => join(home, APP_DATA_DIR, "antigravity-oauth-token");

const tokenText = (email: unknown): string =>
  JSON.stringify({
    token: { access_token: "secret-access", refresh_token: "secret-refresh" },
    auth_method: "oauth",
    id_token_email: email,
  });

const createToken = (home: string, content: string): void => {
  createFile(tokenPath(home), content);
};

const createFifo = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
};

/** Makes `<home>/antigravity-acp` a link to a folder elsewhere that holds a valid token. */
const linkAppDataDir = (home: string): void => {
  const elsewhere = createHome();
  createToken(elsewhere, tokenText("linked@example.com"));
  symlinkSync(join(elsewhere, APP_DATA_DIR), join(home, APP_DATA_DIR));
};

describe("readLoginFile", () => {
  const read = (home: string) => Effect.runPromise(readLoginFile(home));
  const readFailure = (home: string) => Effect.runPromise(Effect.flip(readLoginFile(home)));

  it("returns the email of the token file", async () => {
    const home = createHome();
    createToken(home, tokenText("person@example.com"));

    expect(await read(home)).toEqual({ email: "person@example.com" });
  });

  it("returns undefined when the account has no login: no app data folder, or no token file in it", async () => {
    const withFolder = createHome();
    mkdirSync(join(withFolder, APP_DATA_DIR));

    expect(await read(createHome())).toBeUndefined();
    expect(await read(withFolder)).toBeUndefined();
  });

  it.each([
    ["not JSON", "this is not json {"],
    ["no id_token_email", JSON.stringify({ token: {}, auth_method: "oauth" })],
    ["an empty id_token_email", tokenText("")],
    ["an id_token_email that is not text", tokenText(42)],
    ["an email with a space", tokenText("a b@example.com")],
    ["an email with two @", tokenText("a@b@example.com")],
    ["an email with no @", tokenText("example.com")],
    ["an email with a control character", tokenText("a\u0007@example.com")],
    ["an email with a text direction override", tokenText("a@\u202eexample.com")],
    ["an email of 255 characters", tokenText(`${"a".repeat(243)}@example.com`)],
    [
      "more than 64 KiB, with the email in it",
      JSON.stringify({ id_token_email: "a@example.com", pad: "x".repeat(70_000) }),
    ],
  ])("returns a login with no email for a token file with %s", async (_name, content) => {
    const home = createHome();
    createToken(home, content);

    expect(await read(home)).toEqual({ email: undefined });
  });

  it.each([
    [
      "a link",
      (home: string) => {
        createFile(join(home, "real-token"), tokenText("a@example.com"));
        mkdirSync(join(home, APP_DATA_DIR));
        symlinkSync(join(home, "real-token"), tokenPath(home));
      },
      "it is a link",
    ],
    [
      "a folder",
      (home: string) => mkdirSync(tokenPath(home), { recursive: true }),
      "it is not a regular file",
    ],
    ["a FIFO", (home: string) => createFifo(tokenPath(home)), "it is not a regular file"],
  ])(
    "fails, and does not say there is no login, when the token file is %s",
    async (_what, prepare, reason) => {
      const home = createHome();
      prepare(home);

      const error = await readFailure(home);

      expect(error._tag).toBe("AdapterFailed");
      expect(error.message).toBe(
        `Could not look for the login file of this account on this runner: ${reason}.`,
      );
    },
  );

  it("fails when the app data folder is a link to a folder with a token", async () => {
    const home = createHome();
    linkAppDataDir(home);

    const error = await readFailure(home);

    expect(error._tag).toBe("AdapterFailed");
    expect(error.message).toContain("antigravity-acp is not a real folder");
  });

  it.skipIf(isRoot)(
    "fails, and does not say there is no login, when nobody may read the token file",
    async () => {
      const home = createHome();
      createToken(home, tokenText("a@example.com"));
      chmodSync(tokenPath(home), 0o000);

      const error = await readFailure(home);

      chmodSync(tokenPath(home), 0o600);
      expect(error.message).toBe(
        "Could not look for the login file of this account on this runner: permission denied.",
      );
    },
  );

  it.skipIf(isRoot)(
    "fails, and does not say there is no login, when the folder cannot be searched",
    async () => {
      const home = createHome();
      createToken(home, tokenText("a@example.com"));
      chmodSync(join(home, APP_DATA_DIR), 0o000);

      const error = await readFailure(home);

      chmodSync(join(home, APP_DATA_DIR), 0o700);
      expect(error.message).toBe(
        "Could not look for the login file of this account on this runner: permission denied.",
      );
    },
  );
});

describe("deleteSessionFiles", () => {
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const OTHER = "22222222-2222-4222-8222-222222222222";

  const sessionFiles = (home: string, id: string): ReadonlyArray<string> => [
    join(home, APP_DATA_DIR, "conversations", `${id}.db`),
    join(home, APP_DATA_DIR, "conversations", `${id}.db-wal`),
    join(home, APP_DATA_DIR, "conversations", `${id}.db-shm`),
    join(home, APP_DATA_DIR, "annotations", `${id}.pbtxt`),
    join(home, APP_DATA_DIR, "brain", id, "notes", "plan.md"),
  ];

  const sharedFiles = (home: string): ReadonlyArray<string> => [
    join(home, APP_DATA_DIR, "conversation_summaries.db"),
    join(home, APP_DATA_DIR, "jetbox_summaries_proto.pb"),
    join(home, APP_DATA_DIR, "implicit", "state.json"),
    tokenPath(home),
  ];

  const remaining = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
    paths.filter((path) => existsSync(path));

  it("deletes the session's own files, and leaves another session's and the shared files", async () => {
    const home = createHome();
    const own = sessionFiles(home, SESSION);
    const kept = [...sessionFiles(home, OTHER), ...sharedFiles(home)];
    for (const file of [...own, ...kept]) createFile(file);

    await Effect.runPromise(deleteSessionFiles(home, SESSION));

    expect(remaining(own)).toEqual([]);
    expect(existsSync(join(home, APP_DATA_DIR, "brain", SESSION))).toBe(false);
    expect(remaining(kept)).toEqual(kept);
  });

  it("succeeds for a session with no files, and for a Harness Home with no app data", async () => {
    const withData = createHome();
    createFile(tokenPath(withData));

    await Effect.runPromise(deleteSessionFiles(withData, SESSION));
    await Effect.runPromise(deleteSessionFiles(createHome(), SESSION));

    expect(existsSync(tokenPath(withData))).toBe(true);
  });

  it("does not delete below a conversations or brain folder that is a link", async () => {
    const home = createHome();
    const outside = createHome();
    const outsideFiles = sessionFiles(outside, SESSION).map((file) =>
      createFile(file.replace(join(outside, APP_DATA_DIR), outside)),
    );
    mkdirSync(join(home, APP_DATA_DIR));
    symlinkSync(join(outside, "conversations"), join(home, APP_DATA_DIR, "conversations"));
    symlinkSync(join(outside, "brain"), join(home, APP_DATA_DIR, "brain"));

    await Effect.runPromise(deleteSessionFiles(home, SESSION));

    expect(remaining(outsideFiles)).toEqual(outsideFiles);
  });

  it("does not delete below an annotations folder that is a link", async () => {
    const home = createHome();
    const outside = createHome();
    const outsideFile = createFile(join(outside, "annotations", `${SESSION}.pbtxt`));
    mkdirSync(join(home, APP_DATA_DIR));
    symlinkSync(join(outside, "annotations"), join(home, APP_DATA_DIR, "annotations"));

    await Effect.runPromise(deleteSessionFiles(home, SESSION));

    expect(existsSync(outsideFile)).toBe(true);
  });

  it("does not delete below an app data folder that is a link", async () => {
    const home = createHome();
    const outside = createHome();
    const outsideFiles = sessionFiles(outside, SESSION).map((file) => createFile(file));
    symlinkSync(join(outside, APP_DATA_DIR), join(home, APP_DATA_DIR));

    await Effect.runPromise(deleteSessionFiles(home, SESSION));

    expect(remaining(outsideFiles)).toEqual(outsideFiles);
  });

  it.each(["..", "brain", "*", "11111111"])(
    "refuses the id %s, and deletes nothing",
    async (id) => {
      const home = createHome();
      const files = [...sessionFiles(home, SESSION), ...sharedFiles(home)];
      for (const file of files) createFile(file);

      const error = await Effect.runPromise(Effect.flip(deleteSessionFiles(home, id)));

      expect(error._tag).toBe("AdapterFailed");
      expect(remaining(files)).toEqual(files);
    },
  );
});
