/** Tests the CSS colour the app draws a plugin's mark or status icon in. */
import { describe, expect, it } from "vitest";
import { buildPluginColorStyle } from "./plugin-color";

describe("buildPluginColorStyle", () => {
  it("draws a hue at the theme's lightness and strength", () => {
    expect(buildPluginColorStyle({ _tag: "hue", hue: 210 })).toEqual({
      color: "oklch(var(--mark-l) var(--mark-c) 210)",
    });
  });

  it("draws an exact colour by the light or dark scheme of the theme", () => {
    expect(buildPluginColorStyle({ _tag: "exact", light: "#8250df", dark: "#ab7df8" })).toEqual({
      color: "light-dark(#8250df, #ab7df8)",
    });
  });

  it("leaves the colour to the stylesheet when the plugin declares none", () => {
    expect(buildPluginColorStyle(undefined)).toBeUndefined();
  });
});
