/**
 * Tests how main answers one IPC message: the sender check, the decoding of
 * the request, and the reply and log line of a refused message. The frames
 * are plain objects, so no test needs Electron.
 */
import { describe, expect, it } from "vitest";
import { Effect, Logger } from "effect";
import { answerIpcMessage, type IpcMessage } from "./message";

const mainFrame = { origin: "app://hercule" };

/** Returns main's reply to `message` on controllerUrl.read, whose handler returns a controller URL. */
const answerUrlRead = (message: IpcMessage) =>
  Effect.runSync(
    answerIpcMessage("controllerUrl.read", () => Effect.succeed("http://127.0.0.1:4937"), message),
  );

/** Returns main's reply to `args` on controllerUrl.save, whose handler saves the URL it is sent. */
const answerUrlSave = (args: ReadonlyArray<unknown>) =>
  Effect.runSync(
    answerIpcMessage(
      "controllerUrl.save",
      (url) => Effect.succeed({ _tag: "Saved", origin: url } as const),
      { senderFrame: mainFrame, mainFrame, args },
    ),
  );

describe("answerIpcMessage", () => {
  it("replies with the handler's response to the main frame at app://hercule", () => {
    expect(answerUrlRead({ senderFrame: mainFrame, mainFrame, args: [] })).toEqual({
      response: "http://127.0.0.1:4937",
    });
  });

  it("refuses a frame inside the page, even at app://hercule", () => {
    const subframe = { origin: "app://hercule" };
    expect(answerUrlRead({ senderFrame: subframe, mainFrame, args: [] })).toEqual({
      refusal:
        "Main refused a message on controllerUrl.read: it comes from a frame inside the page.",
    });
  });

  it("refuses a main frame at any other origin", () => {
    const page = { origin: "http://127.0.0.1:5173" };
    expect(answerUrlRead({ senderFrame: page, mainFrame: page, args: [] })).toEqual({
      refusal:
        "Main refused a message on controllerUrl.read: it comes from http://127.0.0.1:5173, not app://hercule.",
    });
  });

  it("refuses an origin that only starts with app://hercule", () => {
    const page = { origin: "app://hercule.example" };
    expect(answerUrlRead({ senderFrame: page, mainFrame: page, args: [] })).toEqual({
      refusal:
        "Main refused a message on controllerUrl.read: it comes from app://hercule.example, not app://hercule.",
    });
  });

  it("refuses a message whose frame is gone", () => {
    expect(answerUrlRead({ senderFrame: null, mainFrame, args: [] })).toEqual({
      refusal: "Main refused a message on controllerUrl.read: the frame that sent it is gone.",
    });
  });

  it("decodes the message's one argument as the request", () => {
    expect(answerUrlSave(["http://127.0.0.1:4937"])).toEqual({
      response: { _tag: "Saved", origin: "http://127.0.0.1:4937" },
    });
  });

  it("refuses a message with more than one argument", () => {
    expect(answerUrlSave(["http://127.0.0.1:4937", "http://127.0.0.1:1"])).toEqual({
      refusal:
        "Main refused a message on controllerUrl.save: it carries 2 arguments, and a message carries at most one, the request.",
    });
  });

  it("replies with the refusal, and does not run the handler, when the request does not decode", () => {
    let ran = false;
    const reply = Effect.runSync(
      answerIpcMessage(
        "controllerUrl.read",
        () =>
          Effect.sync(() => {
            ran = true;
            return null;
          }),
        { senderFrame: mainFrame, mainFrame, args: [42] },
      ),
    );
    expect(ran).toBe(false);
    expect(reply).toEqual({
      refusal:
        "Main refused a message on controllerUrl.read: its request does not match the contract: Expected undefined.",
    });
  });

  it("replies with the refusal, the error's message as the reason, when the handler fails", () => {
    const reply = Effect.runSync(
      answerIpcMessage("token.write", () => Effect.fail(new Error("no controller URL is saved")), {
        senderFrame: mainFrame,
        mainFrame,
        args: ["a token"],
      }),
    );
    expect(reply).toEqual({
      refusal: "Main refused a message on token.write: no controller URL is saved.",
    });
  });

  it("replies with an outcome the user caused as the response", () => {
    const reply = Effect.runSync(
      answerIpcMessage(
        "controllerUrl.save",
        () => Effect.succeed({ _tag: "Unreachable", origin: "http://127.0.0.1:1" } as const),
        { senderFrame: mainFrame, mainFrame, args: ["http://127.0.0.1:1"] },
      ),
    );
    expect(reply).toEqual({ response: { _tag: "Unreachable", origin: "http://127.0.0.1:1" } });
  });

  it("logs each refusal once, as a warning", () => {
    const logged: Array<{ level: string; message: unknown }> = [];
    const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
      logged.push({ level: logLevel, message });
    });
    Effect.runSync(
      answerIpcMessage("controllerUrl.read", () => Effect.succeed("http://127.0.0.1:4937"), {
        senderFrame: null,
        mainFrame,
        args: [],
      }).pipe(Effect.provide(Logger.layer([logger]))),
    );
    expect(logged).toEqual([
      {
        level: "Warn",
        message: ["Main refused a message on controllerUrl.read: the frame that sent it is gone."],
      },
    ]);
  });
});
