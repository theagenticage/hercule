/**
 * Carrying one helper's question to the controller and finding its answer
 * again. What matters is that an answer reaches the question that asked it, and
 * that a question nobody answered is absent rather than refused: the socket
 * turns an absent answer into an empty one, which git reads as "ask the next
 * helper", where a refusal would tell the user they were denied.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { CredentialAnswer, CredentialRequest } from "@hercule/protocol";
import { makeCredentialRelay } from "./relay";

const buildCredentialAnswer = (requestId: string, token: string): CredentialAnswer => ({
  _tag: "credentialAnswer",
  requestId,
  token,
  username: "octocat",
});

/** A connection that records what went out, held open for the body of a test. */
const withConnectedRelay = async (
  relay: ReturnType<typeof makeCredentialRelay>,
  sent: Array<CredentialRequest>,
  body: () => Promise<void>,
): Promise<void> => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        relay.attached((frame) =>
          Effect.sync(() => {
            sent.push(frame);
          }),
        ),
        () => Effect.promise(body),
      ),
    ),
  );
};

describe("what the relay does with an answer", () => {
  it("gives each question the answer that names it, however they interleave", async () => {
    const relay = makeCredentialRelay();
    const sent: Array<CredentialRequest> = [];

    await withConnectedRelay(relay, sent, async () => {
      const first = relay.ask({ remote: "github.com/acme/web", sessionToken: "one" });
      const second = relay.ask({ remote: "github.com/acme/api", sessionToken: "two" });
      await Promise.resolve();
      // Answered out of order: only the request id says which is which.
      relay.deliver(buildCredentialAnswer(sent[1]!.requestId, "for-the-api"));
      relay.deliver(buildCredentialAnswer(sent[0]!.requestId, "for-the-web"));

      const web = await first;
      const api = await second;
      expect("token" in web ? web.token : undefined).toBe("for-the-web");
      expect("token" in api ? api.token : undefined).toBe("for-the-api");
    });

    expect(sent.map((frame) => frame.remote)).toEqual([
      "github.com/acme/web",
      "github.com/acme/api",
    ]);
  });

  it("ignores an answer to a question nobody is waiting on", async () => {
    const relay = makeCredentialRelay();

    await withConnectedRelay(relay, [], async () => {
      relay.deliver(buildCredentialAnswer(crypto.randomUUID(), "for-nobody"));
      await Promise.resolve();
    });
  });
});

describe("when nothing answers", () => {
  it("gives up on a controller that says nothing, rather than reporting a refusal", async () => {
    const relay = makeCredentialRelay({ deadlineMs: 5 });

    await withConnectedRelay(relay, [], async () => {
      await expect(
        relay.ask({ remote: "github.com/acme/web", sessionToken: "one" }),
      ).rejects.toThrow("did not answer");
    });
  });

  it("gives up on every question still open when the connection ends", async () => {
    const relay = makeCredentialRelay();
    let asking: Promise<CredentialAnswer> | undefined;

    await withConnectedRelay(relay, [], async () => {
      asking = relay.ask({ remote: "github.com/acme/web", sessionToken: "one" });
      // Caught here so the rejection that arrives with the scope's close is not
      // an unhandled one.
      asking.catch(() => undefined);
      await Promise.resolve();
    });

    await expect(asking).rejects.toThrow("connection to the controller ended");
  });

  it("has nobody to ask before a connection is up", async () => {
    await expect(
      makeCredentialRelay().ask({ remote: "github.com/acme/web", sessionToken: "one" }),
    ).rejects.toThrow("no controller connection");
  });
});
