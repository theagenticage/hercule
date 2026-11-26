/**
 * Tests the files of an Antigravity account in its Harness Home: finding the
 * login, reading the signed-in email, the log folder, the files the probe keeps,
 * and deleting one
 * conversation's files. Each test uses a real temporary folder laid out the
 * way `agy` lays out its files.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { cleanupHomes, createScratchHome } from "../testing";
import {
  APP_DATA_DIR,
  deleteSessionFiles,
  hasTokenFile,
  makeProbeFolder,
  makeLogFolder,
  readProbeConversationId,
  readSignedInEmail,
  writeProbeConversationId,
} from "./harness-home";

const isRoot = process.getuid?.() === 0;

afterEach(() => {
  cleanupHomes();
});

const SESSION_ID = "44444444-4444-4444-8444-444444444444";

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

describe("hasTokenFile", () => {
  it("is true for a regular token file", async () => {
    const home = createHome();
    createToken(home, tokenText("a@example.com"));

    expect(await Effect.runPromise(hasTokenFile(home))).toBe(true);
  });

  it("is false when the Harness Home has no login", async () => {
    expect(await Effect.runPromise(hasTokenFile(createHome()))).toBe(false);
  });

  it("is false when only the app data folder is missing, or only the token file is", async () => {
    const withFolder = createHome();
    mkdirSync(join(withFolder, APP_DATA_DIR));

    expect(await Effect.runPromise(hasTokenFile(withFolder))).toBe(false);
  });

  it.each([
    [
      "a link",
      (home: string) => {
        createFile(join(home, "real-token"));
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
  ])("fails, and does not say false, when the token file is %s", async (_what, prepare, reason) => {
    const home = createHome();
    prepare(home);

    const error = await Effect.runPromise(Effect.flip(hasTokenFile(home)));

    expect(error._tag).toBe("AdapterFailed");
    expect(error.message).toBe(
      `Could not look for the Antigravity login on this runner: ${reason}.`,
    );
  });

  it("fails when the app data folder is a link to a folder with a token", async () => {
    const home = createHome();
    linkAppDataDir(home);

    const error = await Effect.runPromise(Effect.flip(hasTokenFile(home)));

    expect(error._tag).toBe("AdapterFailed");
    expect(error.message).toContain("antigravity-acp is not a real folder");
  });

  it.skipIf(isRoot)(
    "fails, and does not say false, when nobody may read the token file",
    async () => {
      const home = createHome();
      createToken(home, tokenText("a@example.com"));
      chmodSync(tokenPath(home), 0o000);

      const error = await Effect.runPromise(Effect.flip(hasTokenFile(home)));

      chmodSync(tokenPath(home), 0o600);
      expect(error._tag).toBe("AdapterFailed");
      expect(error.message).toBe(
        "Could not look for the Antigravity login on this runner: permission denied.",
      );
    },
  );

  it.skipIf(isRoot)(
    "fails, and does not say false, when the folder cannot be searched",
    async () => {
      const home = createHome();
      createToken(home, tokenText("a@example.com"));
      chmodSync(join(home, APP_DATA_DIR), 0o000);

      const error = await Effect.runPromise(Effect.flip(hasTokenFile(home)));

      chmodSync(join(home, APP_DATA_DIR), 0o700);
      expect(error._tag).toBe("AdapterFailed");
      expect(error.message).toBe(
        "Could not look for the Antigravity login on this runner: permission denied.",
      );
    },
  );
});

describe("readSignedInEmail", () => {
  it("returns the email of the token file", async () => {
    const home = createHome();
    createToken(home, tokenText("person@example.com"));

    expect(await Effect.runPromise(readSignedInEmail(home))).toBe("person@example.com");
  });

  it("returns undefined when there is no token file", async () => {
    expect(await Effect.runPromise(readSignedInEmail(createHome()))).toBeUndefined();
  });

  it.each([
    ["not JSON", "this is not json {"],
    ["no id_token_email", JSON.stringify({ token: {}, auth_method: "oauth" })],
    ["an empty id_token_email", tokenText("")],
    ["an id_token_email that is not text", tokenText(42)],
  ])("returns undefined for a token file with %s", async (_name, content) => {
    const home = createHome();
    createToken(home, content);

    expect(await Effect.runPromise(readSignedInEmail(home))).toBeUndefined();
  });

  it("returns undefined for a token file over the limit, even when the email is in it", async () => {
    const home = createHome();
    createToken(home, JSON.stringify({ id_token_email: "a@example.com", pad: "x".repeat(70_000) }));

    expect(await Effect.runPromise(readSignedInEmail(home))).toBeUndefined();
  });

  it("returns undefined when the token file is a link", async () => {
    const home = createHome();
    createFile(join(home, "real-token"), tokenText("a@example.com"));
    mkdirSync(join(home, APP_DATA_DIR));
    symlinkSync(join(home, "real-token"), tokenPath(home));

    expect(await Effect.runPromise(readSignedInEmail(home))).toBeUndefined();
  });

  it("returns undefined, without waiting, when the token file is a FIFO", async () => {
    const home = createHome();
    createFifo(tokenPath(home));

    expect(await Effect.runPromise(readSignedInEmail(home))).toBeUndefined();
  });

  it("returns undefined when the token file is a folder", async () => {
    const home = createHome();
    mkdirSync(tokenPath(home), { recursive: true });

    expect(await Effect.runPromise(readSignedInEmail(home))).toBeUndefined();
  });

  it("returns undefined when the app data folder is a link to a folder with a valid token", async () => {
    const home = createHome();
    linkAppDataDir(home);

    expect(await Effect.runPromise(readSignedInEmail(home))).toBeUndefined();
  });

  it.skipIf(isRoot)("returns undefined when the token file cannot be read", async () => {
    const home = createHome();
    createToken(home, tokenText("a@example.com"));
    chmodSync(tokenPath(home), 0o000);

    expect(await Effect.runPromise(readSignedInEmail(home))).toBeUndefined();
  });
});

describe("makeLogFolder", () => {
  it("makes an empty folder in the Harness Home that only the user can enter", async () => {
    const home = createHome();

    const [folder, entries, mode] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const made = yield* makeLogFolder(home);
          return [made, readdirSync(made), statSync(made).mode & 0o777] as const;
        }),
      ),
    );

    expect(dirname(folder)).toBe(home);
    expect(basename(folder).startsWith("hercule-log-")).toBe(true);
    expect(entries).toEqual([]);
    expect(mode).toBe(0o700);
  });

  it("removes the folder and what is in it when the scope closes, and not before", async () => {
    const home = createHome();
    const scope = await Effect.runPromise(Scope.make());
    const folder = await Effect.runPromise(makeLogFolder(home).pipe(Scope.provide(scope)));
    createFile(join(folder, "deep", "note.txt"));

    expect(existsSync(folder)).toBe(true);
    await Effect.runPromise(Scope.close(scope, Exit.void));

    expect(existsSync(folder)).toBe(false);
  });

  it("fails with a sentence for the user when the Harness Home does not exist", async () => {
    const home = join(createHome(), "missing");

    const error = await Effect.runPromise(Effect.flip(Effect.scoped(makeLogFolder(home))));

    expect(error._tag).toBe("AdapterFailed");
    expect(error.message).toMatch(/^Could not make a log folder for Antigravity .*\.$/);
  });
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
    // The conversation the probe keeps is not a session of Hercule's.
    join(home, "hercule-probe-conversation"),
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

describe("the probe's conversation", () => {
  const ID = "33333333-3333-4333-8333-333333333333";

  it("makes its working folder once, with mode 0700, and reuses it", async () => {
    const home = createHome();

    const first = await Effect.runPromise(makeProbeFolder(home));
    createFile(join(first, "kept.txt"));
    const second = await Effect.runPromise(makeProbeFolder(home));

    expect(first).toBe(join(home, "hercule-probe"));
    expect(second).toBe(first);
    expect(statSync(first).mode & 0o777).toBe(0o700);
    expect(existsSync(join(first, "kept.txt"))).toBe(true);
  });

  it.each(["a link to a folder", "a file"])(
    "does not take %s for its working folder",
    async (what) => {
      const home = createHome();
      if (what === "a file") createFile(join(home, "hercule-probe"));
      else symlinkSync(createHome(), join(home, "hercule-probe"));

      const error = await Effect.runPromise(Effect.flip(makeProbeFolder(home)));

      expect(error._tag).toBe("AdapterFailed");
      expect(error.message).toMatch(/^Could not make the working folder for the Antigravity check/);
    },
  );

  it("stores an id and reads it back, replacing the one before", async () => {
    const home = createHome();

    await Effect.runPromise(writeProbeConversationId(home, ID));
    expect(await Effect.runPromise(readProbeConversationId(home))).toBe(ID);
    await Effect.runPromise(writeProbeConversationId(home, SESSION_ID));

    expect(await Effect.runPromise(readProbeConversationId(home))).toBe(SESSION_ID);
    expect(readdirSync(home)).toEqual(["hercule-probe-conversation"]);
  });

  it("reads no id from a missing file, and none from a regular file that is not one UUID", async () => {
    const home = createHome();
    const path = join(home, "hercule-probe-conversation");
    const read = () => Effect.runPromise(readProbeConversationId(home));

    expect(await read()).toBeUndefined();
    for (const content of ["", "../../etc/passwd\n", `${ID}\n${ID}\n`, `${ID}${" ".repeat(200)}`]) {
      createFile(path, content);
      expect(await read()).toBeUndefined();
    }
  });

  it.each([
    ["a folder", (path: string) => mkdirSync(path)],
    ["a link", (path: string) => symlinkSync(join(dirname(path), "elsewhere"), path)],
    ["a FIFO", (path: string) => createFifo(path)],
  ])(
    "fails when %s is in the file's place, so the probe makes no conversation",
    async (_what, prepare) => {
      const home = createHome();
      createFile(join(home, "elsewhere"), "33333333-3333-4333-8333-333333333333\n");
      prepare(join(home, "hercule-probe-conversation"));

      const error = await Effect.runPromise(Effect.flip(readProbeConversationId(home)));

      expect(error._tag).toBe("AdapterFailed");
      expect(error.message).toMatch(
        /^Could not read the conversation of the Antigravity check on this runner: /,
      );
    },
  );

  it.skipIf(isRoot)("fails when nobody may read the file", async () => {
    const home = createHome();
    const path = createFile(join(home, "hercule-probe-conversation"), `${ID}\n`);
    chmodSync(path, 0o000);

    const error = await Effect.runPromise(Effect.flip(readProbeConversationId(home)));

    chmodSync(path, 0o600);
    expect(error.message).toMatch(/permission denied\.$/);
  });

  it.each(["", "not-a-uuid", "../brain/x", `${ID}\n${ID}`])(
    "refuses to store the id %j, and writes nothing",
    async (id) => {
      const home = createHome();

      const error = await Effect.runPromise(Effect.flip(writeProbeConversationId(home, id)));

      expect(error._tag).toBe("AdapterFailed");
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it("fails with a sentence for the user when the id cannot be stored", async () => {
    const home = join(createHome(), "missing");

    const error = await Effect.runPromise(Effect.flip(writeProbeConversationId(home, ID)));

    expect(error._tag).toBe("AdapterFailed");
    expect(error.message).toMatch(/^Could not remember the conversation of the Antigravity check/);
  });
});
