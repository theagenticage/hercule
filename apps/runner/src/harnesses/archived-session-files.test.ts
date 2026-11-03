/**
 * Tests for the warning data of a session whose files stay: the name the user
 * knows the harness by, and a reason without a final period.
 */
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
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
    const failure = await Effect.runPromise(
      Effect.flip(
        deleteHarnessSessionFiles("/nowhere", {
          harnessId: CLAUDE_CODE,
          harnessHome: HOME,
          // Not a plain file name, which every adapter refuses.
          nativeSessionId: "../escape",
        }),
      ),
    );

    expect(failure).toEqual({
      harnessName: "Claude Code",
      reason: "the session id is not valid",
    });
  });
});
