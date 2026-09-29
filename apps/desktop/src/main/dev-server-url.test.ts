import { describe, expect, it } from "vitest";
import { buildDevServerUrl } from "./dev-server-url";

const DEV_SERVER = "http://127.0.0.1:5173/";

describe("buildDevServerUrl", () => {
  it.each([
    ["app://hercule/", "http://127.0.0.1:5173/"],
    ["app://hercule/@vite/client", "http://127.0.0.1:5173/@vite/client"],
    [
      "app://hercule/src/main.tsx?t=1727600000000",
      "http://127.0.0.1:5173/src/main.tsx?t=1727600000000",
    ],
    ["app://hercule/index.html#top", "http://127.0.0.1:5173/index.html"],
  ])("forwards %s to %s", (requestUrl, target) => {
    expect(buildDevServerUrl(DEV_SERVER, requestUrl)).toBe(target);
  });

  it.each([
    ["app://hercule//elsewhere.example/x", "http://127.0.0.1:5173//elsewhere.example/x"],
    ["app://hercule/\\\\elsewhere.example/x", "http://127.0.0.1:5173///elsewhere.example/x"],
    ["app://hercule/%2F%2Felsewhere.example/x", "http://127.0.0.1:5173/%2F%2Felsewhere.example/x"],
    ["app://hercule/..//elsewhere.example", "http://127.0.0.1:5173//elsewhere.example"],
    ["app://hercule/@elsewhere.example", "http://127.0.0.1:5173/@elsewhere.example"],
  ])("keeps %s on the dev server", (requestUrl, target) => {
    expect(buildDevServerUrl(DEV_SERVER, requestUrl)).toBe(target);
  });

  it.each(["app://elsewhere/", "app://hercule.example/", "https://example.com/", "not a url"])(
    "refuses %j, which is not on the renderer's origin",
    (requestUrl) => expect(buildDevServerUrl(DEV_SERVER, requestUrl)).toBeNull(),
  );
});
