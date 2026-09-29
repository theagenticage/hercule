/** Tests how main encodes the payload of a main-to-renderer message. */
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { encodeIpcPayload } from "./payload";

describe("encodeIpcPayload", () => {
  it.each(["signOut", "newThread"] as const)("encodes the menu command %s", (command) => {
    expect(Effect.runSync(encodeIpcPayload("menu.command", command))).toBe(command);
  });

  it("dies on a payload outside the contract, because only a bug in main sends one", () => {
    const exit = Effect.runSyncExit(encodeIpcPayload("menu.command", "quit" as never));
    expect(Exit.hasDies(exit)).toBe(true);
  });
});
