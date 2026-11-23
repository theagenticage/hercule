import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  MenuCommand,
  RENDERER_TO_MAIN_IPC_CHANNELS,
  SignInReturnListenOutcome,
  SignInReturnWaitOutcome,
  type RendererToMainIpcChannelName,
} from "./contract";

/** Builds the Go menu's list of `length` threads. */
const buildGoMenuItems = (length: number) =>
  Array.from({ length }, (_, index) => ({
    destination: { kind: "thread", sessionId: `s-${String(index)}` },
    title: "A thread",
  }));

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
    { name: "goMenu.set", valid: buildGoMenuItems(9), invalid: buildGoMenuItems(10) },
    {
      name: "goMenu.set",
      valid: [{ destination: { kind: "assistant", assistantId: "a-1" }, title: "Ada" }],
      invalid: [{ destination: { kind: "assistant", sessionId: "s-1" }, title: "Ada" }],
    },
    {
      name: "waiting.set",
      valid: [
        {
          destination: { kind: "thread", sessionId: "s-1" },
          requestId: "r-1",
          openRequestIds: ["r-1"],
          title: "A thread",
          body: "Run git push?",
        },
        {
          destination: { kind: "assistant", assistantId: "a-1" },
          requestId: "r-3",
          openRequestIds: ["r-2", "r-3"],
          title: "Ada",
          body: "Book the train?\n+1 more waiting",
        },
      ],
      invalid: [
        {
          destination: { kind: "thread", sessionId: "s-1" },
          openRequestIds: ["r-1"],
          title: "A thread",
          body: "Run git push?",
        },
      ],
    },
    {
      name: "waiting.set",
      valid: [],
      invalid: [
        {
          destination: { kind: "thread", sessionId: "s-1" },
          requestId: "r-1",
          title: "A thread",
          body: "Run git push?",
        },
      ],
    },
    {
      name: "waiting.set",
      valid: [],
      invalid: [
        {
          destination: { kind: "office" },
          requestId: "r-1",
          openRequestIds: ["r-1"],
          title: "The office",
          body: "Run git push?",
        },
      ],
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
    {
      name: "link.open",
      valid: { url: "https://example.com" },
      invalid: { url: "https://user:pass@example.com/" },
    },
    // The renderer names a skill of the last pick, and never sends a path.
    { name: "skillFolders.pick", valid: undefined, invalid: "~/.agents/skills" },
    { name: "skillArchive.build", valid: { name: "teach" }, invalid: { path: "/etc" } },
    // The renderer names a listener and the URL it opens; a web page only.
    { name: "signInReturn.listen", valid: undefined, invalid: { port: 4937 } },
    {
      name: "signInReturn.wait",
      valid: { listenerId: "l-1", authorizationUrl: "https://mcp.example/authorize?state=s" },
      invalid: { listenerId: "l-1", authorizationUrl: "file:///etc" },
    },
    {
      name: "signInReturn.wait",
      valid: { listenerId: "l-1", authorizationUrl: "http://127.0.0.1:4937/authorize" },
      invalid: { authorizationUrl: "https://mcp.example/authorize?state=s" },
    },
    { name: "signInReturn.cancel", valid: { listenerId: "l-1" }, invalid: "l-1" },
  ];

  it.each(cases)("$name decodes $valid and refuses $invalid", ({ name, valid, invalid }) => {
    const decode = Schema.decodeUnknownSync(RENDERER_TO_MAIN_IPC_CHANNELS[name].request);
    expect(decode(valid)).toEqual(valid);
    expect(() => decode(invalid)).toThrow();
  });
});

describe("the menu commands", () => {
  const decode = Schema.decodeUnknownSync(MenuCommand);

  it.each([
    "signOut",
    "newThread",
    "openOffice",
    "openInbox",
    "openWorkflows",
    "openSettings",
    "send",
    "undo",
    "redo",
    "showThreadsFace",
    "showOrchestrationFace",
  ])("decodes %s", (command) => {
    expect(decode(command)).toBe(command);
  });

  it("refuses a command no menu item sends", () => {
    expect(() => decode("openPreferences")).toThrow();
  });
});

describe("the responses of the sign-in return's channels", () => {
  const decodeListen = Schema.decodeUnknownSync(SignInReturnListenOutcome);
  const decodeWait = Schema.decodeUnknownSync(SignInReturnWaitOutcome);

  it("decodes the outcomes of listen", () => {
    const listening = {
      _tag: "listening",
      listenerId: "l-1",
      redirectUri: "http://127.0.0.1:50000/callback",
    };
    expect(decodeListen(listening)).toEqual(listening);
    expect(decodeListen({ _tag: "unavailable" })).toEqual({ _tag: "unavailable" });
    expect(() => decodeListen({ _tag: "listening" })).toThrow();
  });

  it("decodes the outcomes of wait", () => {
    const received = { _tag: "received", callbackQuery: "code=a&state=s" };
    expect(decodeWait(received)).toEqual(received);
    expect(decodeWait({ _tag: "cancelled" })).toEqual({ _tag: "cancelled" });
    expect(decodeWait({ _tag: "timed-out" })).toEqual({ _tag: "timed-out" });
    expect(() => decodeWait({ _tag: "received" })).toThrow();
    expect(() => decodeWait({ _tag: "timedOut" })).toThrow();
  });
});
