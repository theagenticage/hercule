import { assert, describe, it } from "vitest";
import {
  resolveBrowserTimezone,
  FALLBACK_TIMEZONE,
  isSupportedTimezone,
  listSupportedTimezones,
} from "./timezone";

describe("the zones this runtime knows", () => {
  it("lists zones its own formatter accepts", () => {
    const zones = listSupportedTimezones();
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

  it("accepts a spelling the formatter takes but the canonical list leaves out", () => {
    for (const zone of ["Asia/Kolkata", "US/Pacific", "GMT", "Etc/GMT+5"]) {
      assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }), zone);
      assert.isTrue(isSupportedTimezone(zone), zone);
    }
  });

  it("hands back the same list every time", () => {
    assert.strictEqual(listSupportedTimezones(), listSupportedTimezones());
  });
});

describe("resolveBrowserTimezone", () => {
  it("reads the zone from the resolver it is given", () => {
    assert.strictEqual(
      resolveBrowserTimezone(() => "Europe/Amsterdam"),
      "Europe/Amsterdam",
    );
  });

  it("answers UTC when the runtime reports a zone it cannot format", () => {
    assert.strictEqual(
      resolveBrowserTimezone(() => "Europe/Nowhere"),
      FALLBACK_TIMEZONE,
    );
  });

  it("answers a zone the formatter accepts, from the running environment", () => {
    assert.doesNotThrow(
      () => new Intl.DateTimeFormat("en-US", { timeZone: resolveBrowserTimezone() }),
    );
  });
});
