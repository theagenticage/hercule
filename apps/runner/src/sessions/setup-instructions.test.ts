/** Tests for adding the setup command to a failed start's error. */
import { describe, expect, it } from "vitest";
import {
  AdapterFailed,
  HarnessLoginMissing,
  HarnessNotInstalled,
  HarnessProtocolError,
} from "@hercule/protocol";
import { appendSetupInstructions } from "./setup-instructions";

const target = { runnerId: "runner-7", harnessId: "codex/codex", providerAccountId: "account-3" };

describe("appendSetupInstructions", () => {
  it("adds the install command to a missing harness", () => {
    const fixed = appendSetupInstructions(
      new HarnessNotInstalled({ message: "Codex is not installed on this runner." }),
      target,
    );
    expect(fixed._tag).toBe("HarnessNotInstalled");
    expect(fixed.message).toBe(
      "Codex is not installed on this runner. Install it with: `hercule runner install-harness runner-7 --harness codex/codex`",
    );
  });

  it("adds the sign-in command to a missing login", () => {
    const fixed = appendSetupInstructions(
      new HarnessLoginMissing({ message: "Codex is not logged in on this runner" }),
      target,
    );
    expect(fixed._tag).toBe("HarnessLoginMissing");
    expect(fixed.message).toBe(
      "Codex is not logged in on this runner. Sign in with: `hercule provider-account sign-in account-3 --runner runner-7`",
    );
  });

  it.each([
    new AdapterFailed({ message: "could not write the settings file" }),
    new HarnessProtocolError({ message: "the harness went away" }),
  ])("returns a $_tag unchanged", (error) => {
    expect(appendSetupInstructions(error, target)).toBe(error);
  });
});
