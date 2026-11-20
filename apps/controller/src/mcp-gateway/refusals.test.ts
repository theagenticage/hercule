/** Tests how often the Thread is told about a refused call (spec 21 section 3.6). */
import { describe, expect, it } from "vitest";
import {
  buildMissingGrantRefusal,
  buildNotInListRefusal,
  buildRefusalWarning,
  buildToolGoneRefusal,
  buildUnknownToolRefusal,
  claimWarning,
  type SeenWarning,
} from "./refusals";

const sentry = { id: "server-1", name: "sentry" };

describe("claimWarning", () => {
  it("tells the Thread once per server and reason in a turn", () => {
    const seen = new Map<string, SeenWarning>();
    const refusal = buildNotInListRefusal(sentry, "sentry", "search");
    expect(claimWarning(seen, refusal, "turn-1", 0)).toBe(true);
    expect(claimWarning(seen, refusal, "turn-1", 10)).toBe(false);
    expect(claimWarning(seen, refusal, "turn-2", 20)).toBe(true);
  });

  it("tells it again for another reason or another server in the same turn", () => {
    const seen = new Map<string, SeenWarning>();
    expect(claimWarning(seen, buildNotInListRefusal(sentry, "sentry", "search"), "turn-1", 0)).toBe(
      true,
    );
    expect(claimWarning(seen, buildMissingGrantRefusal(), "turn-1", 0)).toBe(true);
    const linear = { id: "server-2", name: "linear" };
    expect(claimWarning(seen, buildNotInListRefusal(linear, "linear", "search"), "turn-1", 0)).toBe(
      true,
    );
  });

  it("tells it once a minute outside a turn", () => {
    const seen = new Map<string, SeenWarning>();
    const refusal = buildNotInListRefusal(sentry, "sentry", "search");
    expect(claimWarning(seen, refusal, undefined, 0)).toBe(true);
    expect(claimWarning(seen, refusal, undefined, 59_999)).toBe(false);
    expect(claimWarning(seen, refusal, undefined, 60_000)).toBe(true);
  });
});

describe("buildUnknownToolRefusal", () => {
  it("repeats a caller's tool name cut to 64 characters, with no character a tool name cannot have", () => {
    const name = `search\n${"x".repeat(900_000)}`;
    const refusal = buildUnknownToolRefusal(name);

    expect(refusal.message).toContain('"search?xxxxxxxx');
    expect(refusal.message).not.toContain("\n");
    // The Thread's line must stay under the protocol's 4,096 character bound.
    expect(buildRefusalWarning(refusal).length).toBeLessThan(4_096);
  });
});

describe("buildToolGoneRefusal", () => {
  it("names the removed tool by a display name cut to 64 characters, so the Thread's line stays bounded", () => {
    const refusal = buildToolGoneRefusal(sentry, `search\n${"x".repeat(900_000)}`);

    expect(refusal.message).toContain('a tool named "search?xxxxxxxx');
    expect(refusal.message).not.toContain("\n");
    expect(buildRefusalWarning(refusal).length).toBeLessThan(4_096);
  });
});
