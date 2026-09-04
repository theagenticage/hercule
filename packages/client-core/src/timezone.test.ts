import { assert, describe, it } from "vitest";
import { browserTimezone } from "./timezone";

describe("browserTimezone", () => {
  it("reads the zone from the resolver it is given", () => {
    assert.strictEqual(
      browserTimezone(() => "Europe/Amsterdam"),
      "Europe/Amsterdam",
    );
  });

  it("reads an IANA zone from the running environment by default", () => {
    assert.match(browserTimezone(), /^[A-Za-z]+(\/[A-Za-z0-9_+-]+)*$/);
  });
});
