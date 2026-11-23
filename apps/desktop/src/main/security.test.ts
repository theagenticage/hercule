/**
 * Tests how main opens a link for the renderer (`link.open`): the outcome the
 * renderer gets, and what main logs, when the system cannot open the browser.
 * The link is one a sign-in made, with a one-time `state` in its query, which
 * must reach neither the reply nor the log. Electron's `shell` is faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Logger } from "effect";
import { answerIpcMessage } from "./ipc/message";
import { openInBrowser } from "./security";

const electron = vi.hoisted(() => ({
  openExternal: (() => Promise.resolve()) as (url: string) => Promise<void>,
}));

vi.mock("electron", () => ({
  shell: { openExternal: (url: string) => electron.openExternal(url) },
}));

const SIGN_IN_URL = "https://auth.docs.example/authorize?state=one-time-state&client_id=x";
const mainFrame = { origin: "app://hercule" };

/** Runs `link.open` as main answers it, and returns the reply and every line main logged. */
const answerLinkOpen = async (url: string) => {
  const logged: unknown[] = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    logged.push(message);
  });
  const reply = await Effect.runPromise(
    answerIpcMessage("link.open", ({ url: requested }) => openInBrowser(requested), {
      senderFrame: mainFrame,
      mainFrame,
      args: [{ url }],
    }).pipe(Effect.provide(Logger.layer([logger]))),
  );
  return { reply, logged };
};

describe("link.open", () => {
  beforeEach(() => {
    electron.openExternal = () => Promise.resolve();
  });

  it("answers Opened after handing the link to the system", async () => {
    const opened: string[] = [];
    electron.openExternal = (url) => {
      opened.push(url);
      return Promise.resolve();
    };

    const { reply, logged } = await answerLinkOpen(SIGN_IN_URL);

    expect(reply).toEqual({ response: { _tag: "Opened" } });
    expect(opened).toEqual([SIGN_IN_URL]);
    expect(logged).toEqual([]);
  });

  it("answers NotOpened with a sentence when the system cannot open the browser, and the sentence, the reply and the log never hold the link", async () => {
    electron.openExternal = (url) =>
      Promise.reject(new Error(`Failed to open ${url}: no application is set for https`));

    const { reply, logged } = await answerLinkOpen(SIGN_IN_URL);

    expect(reply).toEqual({
      response: {
        _tag: "NotOpened",
        reason: "The system could not open your default browser. Check that one is set.",
      },
    });
    expect(logged).toEqual([
      ["Could not open a link to https://auth.docs.example in the browser."],
    ]);
    const everything = JSON.stringify([reply, logged]);
    expect(everything).not.toContain("one-time-state");
    expect(everything).not.toContain("authorize");
    expect(everything).not.toContain("no application is set");
  });
});
