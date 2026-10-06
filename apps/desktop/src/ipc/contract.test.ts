import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  MenuCommand,
  RENDERER_TO_MAIN_IPC_CHANNELS,
  type RendererToMainIpcChannelName,
} from "./contract";

/** Builds the Go menu's list of `length` threads. */
const buildGoMenuThreads = (length: number) =>
  Array.from({ length }, (_, index) => ({ sessionId: `s-${String(index)}`, title: "A thread" }));

describe("the requests of the renderer-to-main channels", () => {
  const cases: ReadonlyArray<{
    readonly name: RendererToMainIpcChannelName;
    readonly valid: unknown;
    readonly invalid: unknown;
  }> = [
    // A channel that needs no request is sent with no argument, which main
    // decodes as undefined.
    { name: "controllerUrl.read", valid: undefined, invalid: 42 },
    { name: "controllerUrl.save", valid: "http://127.0.0.1:4937", invalid: 42 },
    { name: "token.read", valid: undefined, invalid: "a token" },
    { name: "token.write", valid: "a token", invalid: 42 },
    { name: "token.write", valid: null, invalid: "" },
    // Only the ten ports a runner's identity endpoint can listen on.
    { name: "runnerIdentity.read", valid: { port: 4939 }, invalid: { port: 4938 } },
    { name: "runnerIdentity.read", valid: { port: 4948 }, invalid: { port: 4949 } },
    { name: "runnerIdentity.read", valid: { port: 4940 }, invalid: { port: 22 } },
    // The Go menu has a shortcut for each of the first nine threads only.
    { name: "goMenu.set", valid: buildGoMenuThreads(9), invalid: buildGoMenuThreads(10) },
    {
      name: "waitingThreads.set",
      valid: [
        { sessionId: "s-1", title: "A thread", body: "Run git push?", openRequestIds: ["r-1"] },
      ],
      invalid: [
        { sessionId: "s-1", title: "A thread", body: "Run git push?", openRequestIds: "r-1" },
      ],
    },
    // A thread waits only while a Request is open, so its list of open
    // Requests is never empty. A body still being worked out is null.
    {
      name: "waitingThreads.set",
      valid: [{ sessionId: "s-1", title: "A thread", body: null, openRequestIds: ["r-1"] }],
      invalid: [{ sessionId: "s-1", title: "A thread", body: null, openRequestIds: [] }],
    },
    { name: "localController.find", valid: undefined, invalid: "now" },
    { name: "localController.start", valid: undefined, invalid: "now" },
    {
      name: "firstRunProgress.save",
      valid: { putOff: ["providers", "github"] },
      invalid: { putOff: ["tour"] },
    },
    { name: "firstRunProgress.save", valid: null, invalid: { putOff: "github" } },
    // Only a web page opens in the browser.
    {
      name: "link.open",
      valid: { url: "https://github.com/settings" },
      invalid: { url: "ftp://x.test" },
    },
    { name: "link.open", valid: { url: "http://127.0.0.1:4937" }, invalid: { url: "file:///etc" } },
  ];

  it.each(cases)("$name decodes $valid and refuses $invalid", ({ name, valid, invalid }) => {
    const decode = Schema.decodeUnknownSync(RENDERER_TO_MAIN_IPC_CHANNELS[name].request);
    expect(decode(valid)).toEqual(valid);
    expect(() => decode(invalid)).toThrow();
  });
});

describe("the menu commands", () => {
  const decode = Schema.decodeUnknownSync(MenuCommand);

  it.each(["signOut", "newThread", "openOffice", "openSettings", "send"])(
    "decodes %s",
    (command) => {
      expect(decode(command)).toBe(command);
    },
  );

  it("refuses a command no menu item sends", () => {
    expect(() => decode("openPreferences")).toThrow();
  });
});
