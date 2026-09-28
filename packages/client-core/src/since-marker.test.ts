import { assert, describe, it } from "vitest";
import {
  chooseNewSince,
  choosePinOnOpen,
  NEVER_CHECKED,
  parseSincePin,
  splitBySince,
} from "./since-marker";

const MONDAY = "2026-09-28T07:14:00.000Z";

describe("parseSincePin", () => {
  it("keeps an instant", () => {
    assert.strictEqual(parseSincePin(MONDAY), MONDAY);
  });

  it("keeps the never-checked pin", () => {
    assert.strictEqual(parseSincePin(NEVER_CHECKED), NEVER_CHECKED);
  });

  it("drops a value that is not an instant", () => {
    assert.isUndefined(parseSincePin("yesterday"));
    assert.isUndefined(parseSincePin(42));
    assert.isUndefined(parseSincePin(undefined));
  });
});

describe("choosePinOnOpen", () => {
  it("pins the stored marker", () => {
    assert.strictEqual(choosePinOnOpen(MONDAY), MONDAY);
  });

  it("pins never-checked when there is no marker", () => {
    assert.strictEqual(choosePinOnOpen(undefined), NEVER_CHECKED);
  });
});

describe("chooseNewSince", () => {
  it("counts from the pin, not from the advanced marker", () => {
    assert.strictEqual(chooseNewSince(MONDAY, "2026-09-28T12:00:00.000Z"), MONDAY);
  });

  it("counts everything as new when the pin says the view was never checked", () => {
    assert.isUndefined(chooseNewSince(NEVER_CHECKED, "2026-09-28T12:00:00.000Z"));
  });

  it("counts from the stored marker until the view pins", () => {
    assert.strictEqual(chooseNewSince(undefined, MONDAY), MONDAY);
    assert.isUndefined(chooseNewSince(undefined, undefined));
  });
});

describe("splitBySince", () => {
  const items = [
    { id: "c", createdAt: "2026-09-28T09:00:00.000Z" },
    { id: "b", createdAt: MONDAY },
    { id: "a", createdAt: "2026-09-27T22:10:00.000Z" },
  ];

  it("puts items created at or after the instant in fresh, and older ones in seen", () => {
    const { fresh, seen } = splitBySince(items, MONDAY);
    assert.deepStrictEqual(
      fresh.map((item) => item.id),
      ["c", "b"],
    );
    assert.deepStrictEqual(
      seen.map((item) => item.id),
      ["a"],
    );
  });

  it("counts every item as fresh without an instant", () => {
    const { fresh, seen } = splitBySince(items, undefined);
    assert.strictEqual(fresh.length, 3);
    assert.strictEqual(seen.length, 0);
  });
});
