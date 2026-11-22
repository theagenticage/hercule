/**
 * Tests how a plugin's colour and mark are drawn: the hue or the exact
 * colours it declares, and its own paths or the initial of its name.
 */
import { describe, expect, it } from "vitest";
import { decidePluginColor, decidePluginMark } from "./plugin-names";

const PLUGINS = [
  { id: "github", displayName: "GitHub" },
  { id: "slack", displayName: "Slack" },
];

describe("decidePluginColor", () => {
  it("draws a hue at the theme's lightness", () => {
    expect(decidePluginColor({ hue: 210 })).toEqual({ _tag: "hue", hue: 210 });
  });

  it("draws one exact colour the same in light and dark themes", () => {
    expect(decidePluginColor({ color: "#8250df" })).toEqual({
      _tag: "exact",
      light: "#8250df",
      dark: "#8250df",
    });
  });

  it("draws a light and dark pair as declared", () => {
    expect(decidePluginColor({ color: { light: "#8250df", dark: "#ab7df8" } })).toEqual({
      _tag: "exact",
      light: "#8250df",
      dark: "#ab7df8",
    });
  });

  it("leaves the colour to the client when the plugin declares none", () => {
    expect(decidePluginColor({})).toBeUndefined();
  });
});

describe("decidePluginMark", () => {
  it("draws the paths of the mark the plugin declares", () => {
    const plugins = [{ id: "sentry", displayName: "Sentry", mark: { paths: ["M0 0h16v16H0z"] } }];
    expect(decidePluginMark("sentry", plugins)).toEqual({
      _tag: "paths",
      paths: ["M0 0h16v16H0z"],
    });
  });

  it("draws the initial of the plugin's name when it declares no mark", () => {
    expect(decidePluginMark("slack", PLUGINS)).toEqual({ _tag: "initial", initial: "S" });
  });

  it("draws the initial of the id of a plugin that is not listed", () => {
    expect(decidePluginMark("jira", PLUGINS)).toEqual({ _tag: "initial", initial: "J" });
  });
});
