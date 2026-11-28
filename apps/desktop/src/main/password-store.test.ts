import { describe, expect, it } from "vitest";
import { looksLikeKde } from "./password-store";

describe("looksLikeKde", () => {
  it.each<[string, Record<string, string>]>([
    ["Plasma 6", { XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "6" }],
    ["Plasma 5", { XDG_CURRENT_DESKTOP: "KDE", DESKTOP_SESSION: "plasma" }],
    ["KDE in a list of names", { XDG_CURRENT_DESKTOP: "Hyprland:KDE" }],
    ["KDE with spaces around it", { XDG_CURRENT_DESKTOP: "Hyprland: KDE " }],
    ["the older DESKTOP_SESSION=kde4", { DESKTOP_SESSION: "kde4" }],
    ["the older DESKTOP_SESSION=kde-plasma", { DESKTOP_SESSION: "kde-plasma" }],
    ["the older KDE_FULL_SESSION", { KDE_FULL_SESSION: "true" }],
    [
      "a name that only contains kde, which the loose test accepts",
      { XDG_CURRENT_DESKTOP: "NotKDE" },
    ],
  ])("is true for %s, which keeps Chromium's KWallet", (_name, env) => {
    expect(looksLikeKde(env)).toBe(true);
  });

  it.each<[string, Record<string, string>]>([
    ["Hyprland", { XDG_CURRENT_DESKTOP: "Hyprland" }],
    ["sway", { XDG_CURRENT_DESKTOP: "sway" }],
    ["a session started by hand, with no desktop variables", { WAYLAND_DISPLAY: "wayland-1" }],
    ["LXQt", { XDG_CURRENT_DESKTOP: "LXQt" }],
    ["GNOME", { XDG_CURRENT_DESKTOP: "GNOME" }],
    ["X-Cinnamon", { XDG_CURRENT_DESKTOP: "X-Cinnamon" }],
    ["XFCE", { XDG_CURRENT_DESKTOP: "XFCE", DESKTOP_SESSION: "xfce" }],
  ])("is false for %s, which gets gnome-libsecret", (_name, env) => {
    expect(looksLikeKde(env)).toBe(false);
  });
});
