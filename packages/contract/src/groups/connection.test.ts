/**
 * Tests that a Connection's update refuses a malformed key in its maps rather
 * than dropping it, which would quietly undo the user's choice for that key.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ConnectionUpdateInput } from "./connection";

const decode = Schema.decodeUnknownExit(ConnectionUpdateInput);

describe("ConnectionUpdateInput", () => {
  it("refuses an Intake override whose kind is malformed", () => {
    for (const intake of [
      { eventKinds: { "": false }, signalKinds: {} },
      { eventKinds: {}, signalKinds: { "": false } },
      { eventKinds: {}, signalKinds: { "Not a kind": false } },
    ]) {
      expect(decode({ intake })._tag).toBe("Failure");
    }
    expect(
      decode({ intake: { eventKinds: {}, signalKinds: { "github/review-requested": false } } })
        ._tag,
    ).toBe("Success");
  });

  it("refuses a poll interval whose feed name is empty", () => {
    expect(decode({ feedIntervals: { "": 30 } })._tag).toBe("Failure");
    expect(decode({ feedIntervals: { notifications: 30 } })._tag).toBe("Success");
  });
});
