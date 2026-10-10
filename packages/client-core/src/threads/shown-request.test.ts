/** Tests `locateShownRequest`, which decides which open request the dock shows and how it pages. */
import { describe, expect, it } from "vitest";
import { locateShownRequest } from "./shown-request";

/** A request as small as the helper needs: only an id, kept in a field of its own name. */
interface Asked {
  readonly key: string;
}

const FIRST: Asked = { key: "a" };
const SECOND: Asked = { key: "b" };
const THIRD: Asked = { key: "c" };

const readKey = (request: Asked): string => request.key;

describe("locateShownRequest", () => {
  it("returns null when no request is open", () => {
    expect(locateShownRequest([], readKey, "a")).toBeNull();
  });

  it("shows a lone request with no place among others and nothing to page to", () => {
    expect(locateShownRequest([FIRST], readKey, undefined)).toEqual({
      request: FIRST,
      position: null,
      previousRequestId: undefined,
      nextRequestId: undefined,
    });
  });

  it("shows the oldest when none is named", () => {
    expect(locateShownRequest([FIRST, SECOND, THIRD], readKey, undefined)).toEqual({
      request: FIRST,
      position: { at: 1, of: 3 },
      previousRequestId: undefined,
      nextRequestId: "b",
    });
  });

  it("shows the named request, with both neighbours read through readId", () => {
    expect(locateShownRequest([FIRST, SECOND, THIRD], readKey, "b")).toEqual({
      request: SECOND,
      position: { at: 2, of: 3 },
      previousRequestId: "a",
      nextRequestId: "c",
    });
  });

  it("has no next request on the last one", () => {
    expect(locateShownRequest([FIRST, SECOND, THIRD], readKey, "c")).toMatchObject({
      request: THIRD,
      previousRequestId: "b",
      nextRequestId: undefined,
    });
  });

  it("falls back to the oldest once the named request has closed", () => {
    expect(locateShownRequest([SECOND, THIRD], readKey, "a")?.request).toBe(SECOND);
  });
});
