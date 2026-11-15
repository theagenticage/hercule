import { StatusIcon } from "@hercule/plugin-host";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { NEW_ICON, REGRESSED_ICON } from "./status-icons";

describe("Sentry status icons", () => {
  it.each([
    ["new", NEW_ICON],
    ["regressed", REGRESSED_ICON],
  ])("the %s icon passes the contract's own check", (_name, icon) => {
    expect(() => Schema.decodeUnknownSync(StatusIcon)(icon)).not.toThrow();
  });
});
