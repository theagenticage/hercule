import { assert, describe, it } from "vitest";
import {
  resolveBrowserTimezone,
  resolveDisplayTimezone,
  FALLBACK_TIMEZONE,
  isSupportedTimezone,
  listSupportedTimezones,
  listTimezoneChoices,
} from "./timezone";

describe("listTimezoneChoices", () => {
  it("returns the supported list itself when it holds the stored zone", () => {
    assert.strictEqual(listTimezoneChoices("Europe/Amsterdam"), listSupportedTimezones());
  });

  it("puts a stored zone the list does not hold first, and keeps every supported zone", () => {
    const zones = listSupportedTimezones();
    assert.notInclude(zones, "US/Pacific");
    assert.deepEqual(listTimezoneChoices("US/Pacific"), ["US/Pacific", ...zones]);
  });
});

describe("listSupportedTimezones and isSupportedTimezone", () => {
  it("lists zones the runtime's formatter accepts", () => {
    const zones = listSupportedTimezones();
    assert.isAbove(zones.length, 100);
    for (const zone of [zones[0]!, zones[zones.length - 1]!, "UTC"]) {
      assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }));
    }
  });

  it("accepts a real zone and rejects an invalid one", () => {
    assert.isTrue(isSupportedTimezone("Europe/Amsterdam"));
    assert.isTrue(isSupportedTimezone(FALLBACK_TIMEZONE));
    assert.isFalse(isSupportedTimezone("Amsterdam"));
    assert.isFalse(isSupportedTimezone(""));
  });

  it("accepts a zone name the formatter supports but the canonical list leaves out", () => {
    for (const zone of ["Asia/Kolkata", "US/Pacific", "GMT", "Etc/GMT+5"]) {
      assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }), zone);
      assert.isTrue(isSupportedTimezone(zone), zone);
    }
  });

  it("returns the same list every time", () => {
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

  it("returns UTC when the runtime reports a zone it cannot format", () => {
    assert.strictEqual(
      resolveBrowserTimezone(() => "Europe/Nowhere"),
      FALLBACK_TIMEZONE,
    );
  });

  it("returns a supported zone from the real environment", () => {
    assert.doesNotThrow(
      () => new Intl.DateTimeFormat("en-US", { timeZone: resolveBrowserTimezone() }),
    );
  });
});

describe("resolveDisplayTimezone", () => {
  it("uses the stored zone, and UTC when none is stored or the stored one is unknown", () => {
    assert.strictEqual(resolveDisplayTimezone("Europe/Amsterdam"), "Europe/Amsterdam");
    assert.strictEqual(resolveDisplayTimezone(undefined), "UTC");
    assert.strictEqual(resolveDisplayTimezone("Europe/Nowhere"), "UTC");
  });
});
