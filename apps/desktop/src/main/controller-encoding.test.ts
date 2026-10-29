import { describe, expect, it } from "vitest";
import { isControllerRequest } from "./controller-encoding";

describe("isControllerRequest", () => {
  it("matches any path and query on the saved controller's origin", () => {
    expect(
      isControllerRequest(
        "http://atlas.lan:4937/api/v1/workspaces?limit=400",
        "http://atlas.lan:4937",
      ),
    ).toBe(true);
  });

  it("matches the origin of a saved URL that has a path", () => {
    expect(
      isControllerRequest("http://atlas.lan:4937/api/v1/x", "http://atlas.lan:4937/web/"),
    ).toBe(true);
  });

  it("treats a default port written out as the same origin", () => {
    expect(isControllerRequest("http://atlas.lan/api/v1/x", "http://atlas.lan:80")).toBe(true);
  });

  it("refuses another port, another host and another scheme on the same host", () => {
    const controllerUrl = "http://atlas.lan:4937";
    expect(isControllerRequest("http://atlas.lan:4938/api/v1/x", controllerUrl)).toBe(false);
    expect(isControllerRequest("http://example.com:4937/api/v1/x", controllerUrl)).toBe(false);
    expect(isControllerRequest("https://atlas.lan:4937/api/v1/x", controllerUrl)).toBe(false);
  });

  it("refuses every request before a controller is saved", () => {
    expect(isControllerRequest("http://atlas.lan:4937/api/v1/x", null)).toBe(false);
  });
});
