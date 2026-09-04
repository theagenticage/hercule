import { assert, describe, it } from "vitest";
import {
  browserTimezone,
  FALLBACK_TIMEZONE,
  isSupportedTimezone,
  supportedTimezones,
} from "./timezone";

describe("the zones this runtime knows", () => {
  it("lists zones its own formatter accepts", () => {
    const zones = supportedTimezones();
    assert.isAbove(zones.length, 100);
    for (const zone of [zones[0]!, zones[zones.length - 1]!, "UTC"]) {
      assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }));
    }
  });

  it("knows a real zone and refuses one that is not", () => {
    assert.isTrue(isSupportedTimezone("Europe/Amsterdam"));
    assert.isTrue(isSupportedTimezone(FALLBACK_TIMEZONE));
    assert.isFalse(isSupportedTimezone("Amsterdam"));
    assert.isFalse(isSupportedTimezone(""));
  });
});

describe("browserTimezone", () => {
  it("reads the zone from the resolver it is given", () => {
    assert.strictEqual(
      browserTimezone(() => "Europe/Amsterdam"),
      "Europe/Amsterdam",
    );
  });

  it("answers UTC when the runtime reports a zone it cannot format", () => {
    assert.strictEqual(
      browserTimezone(() => "Europe/Nowhere"),
      FALLBACK_TIMEZONE,
    );
  });

  it("answers a zone the formatter accepts, from the running environment", () => {
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: browserTimezone() }));
  });
});
