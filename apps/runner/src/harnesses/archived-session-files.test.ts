/**
 * Tests for the warning data of a session whose files stay: the name the user
 * knows the harness by, and a reason without a final period.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { deleteHarnessSessionFiles } from "./archived-session-files";
import { CLAUDE_CODE } from "./claude-code";

const HOME = "providers/account-1";

describe("deleteHarnessSessionFiles", () => {
  it("names a harness this runner has no adapter for by its id", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        deleteHarnessSessionFiles("/nowhere", {
          harnessId: "unknown:harness",
          harnessHome: HOME,
          nativeSessionId: "native-1",
        }),
      ),
    );

    expect(failure.harnessName).toBe("unknown:harness");
  });

  it("names the harness as the user knows it, and ends the reason without a period", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "archived-session-files-"));
    try {
      mkdirSync(join(storageDir, HOME), { recursive: true });
      const failure = await Effect.runPromise(
        Effect.flip(
          deleteHarnessSessionFiles(storageDir, {
            harnessId: CLAUDE_CODE,
            harnessHome: HOME,
            // Not a valid id, which every adapter refuses.
            nativeSessionId: "../escape",
          }),
        ),
      );

      expect(failure).toEqual({
        harnessName: "Claude Code",
        reason: "the session id is not valid",
      });
    } finally {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });
});

describe("deleteHarnessSessionFiles and symbolic links", () => {
  const temporaries: Array<string> = [];
  afterEach(() => {
    for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  const createTemporary = (): string => {
    const path = mkdtempSync(join(tmpdir(), "archived-session-files-"));
    temporaries.push(path);
    return path;
  };

  /** Makes an external folder that holds a Claude Code session's files, and returns the transcript's path. */
  const createExternalHome = (): { readonly external: string; readonly transcript: string } => {
    const external = createTemporary();
    mkdirSync(join(external, "projects", "-work"), { recursive: true });
    const transcript = join(external, "projects", "-work", `${SESSION_ID}.jsonl`);
    writeFileSync(transcript, "{}");
    return { external, transcript };
  };

  const SESSION_ID = "11111111-1111-4111-8111-111111111111";
  const session = {
    harnessId: CLAUDE_CODE,
    harnessHome: "providers/homes/account-1/anthropic/claude",
    nativeSessionId: SESSION_ID,
  };

  it("keeps the files and says why when the home is a symbolic link", async () => {
    const storageDir = createTemporary();
    const { external, transcript } = createExternalHome();
    mkdirSync(join(storageDir, "providers/homes/account-1/anthropic"), { recursive: true });
    symlinkSync(external, join(storageDir, session.harnessHome));

    const failure = await Effect.runPromise(
      Effect.flip(deleteHarnessSessionFiles(storageDir, session)),
    );

    expect(failure).toEqual({
      harnessName: "Claude Code",
      reason: "its home is not a folder inside the runner's storage",
    });
    expect(existsSync(transcript)).toBe(true);
  });

  it("keeps the files when a folder above the home is a symbolic link", async () => {
    const storageDir = createTemporary();
    const { external, transcript } = createExternalHome();
    mkdirSync(join(external, "anthropic", "claude"), { recursive: true });
    mkdirSync(join(external, "anthropic", "claude", "projects", "-work"), { recursive: true });
    const nested = join(
      external,
      "anthropic",
      "claude",
      "projects",
      "-work",
      `${SESSION_ID}.jsonl`,
    );
    writeFileSync(nested, "{}");
    mkdirSync(join(storageDir, "providers/homes"), { recursive: true });
    symlinkSync(external, join(storageDir, "providers/homes/account-1"));

    const failure = await Effect.runPromise(
      Effect.flip(deleteHarnessSessionFiles(storageDir, session)),
    );

    expect(failure.reason).toBe("its home is not a folder inside the runner's storage");
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(transcript)).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    "keeps the files and gives the plain reason when the home cannot be read",
    async () => {
      const storageDir = createTemporary();
      mkdirSync(join(storageDir, session.harnessHome), { recursive: true });
      chmodSync(join(storageDir, "providers"), 0o000);

      try {
        const failure = await Effect.runPromise(
          Effect.flip(deleteHarnessSessionFiles(storageDir, session)),
        );

        expect(failure.reason).toBe("its home cannot be read: permission denied");
      } finally {
        chmodSync(join(storageDir, "providers"), 0o700);
      }
    },
  );

  it("succeeds when the home is not there", async () => {
    await Effect.runPromise(deleteHarnessSessionFiles(createTemporary(), session));
  });

  it("deletes the files of a home that is a real folder", async () => {
    const storageDir = createTemporary();
    const home = join(storageDir, session.harnessHome);
    mkdirSync(join(home, "projects", "-work"), { recursive: true });
    const transcript = join(home, "projects", "-work", `${SESSION_ID}.jsonl`);
    writeFileSync(transcript, "{}");

    await Effect.runPromise(deleteHarnessSessionFiles(storageDir, session));

    expect(existsSync(transcript)).toBe(false);
  });
});
