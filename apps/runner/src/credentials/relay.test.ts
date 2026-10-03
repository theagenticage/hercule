/**
 * Tests how the relay sends a helper's request to the controller and matches
 * the answer back to it. Two things matter:
 *
 * - each answer reaches the request it belongs to;
 * - a request with no answer fails with an error instead of being reported as
 *   a denial. The socket turns that error into an empty reply, which git reads
 *   as "try the next helper". A denial would tell the user they were refused.
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

/** Attaches a fake connection that records every sent request, and keeps it while `body` runs. */
const withConnectedRelay = async (
  relay: ReturnType<typeof makeCredentialRelay>,
  sent: Array<CredentialRequest>,
  body: () => Promise<void>,
): Promise<void> => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        relay.attachConnection((frame) =>
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
  it("matches each answer to its request by id, even when answers arrive out of order", async () => {
    const relay = makeCredentialRelay();
    const sent: Array<CredentialRequest> = [];

    await withConnectedRelay(relay, sent, async () => {
      const first = relay.ask({ remote: "github.com/acme/web", sessionToken: "one" });
      const second = relay.ask({ remote: "github.com/acme/api", sessionToken: "two" });
      await Promise.resolve();
      // Answer out of order, so only the request id can tell them apart.
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

  it("ignores an answer to a request that is not pending", async () => {
    const relay = makeCredentialRelay();

    await withConnectedRelay(relay, [], async () => {
      relay.deliver(buildCredentialAnswer(crypto.randomUUID(), "for-nobody"));
      await Promise.resolve();
    });
  });
});

describe("when no answer arrives", () => {
  it("fails with an error, not a denial, when the controller does not answer in time", async () => {
    const relay = makeCredentialRelay({ deadlineMs: 5 });

    await withConnectedRelay(relay, [], async () => {
      await expect(
        relay.ask({ remote: "github.com/acme/web", sessionToken: "one" }),
      ).rejects.toThrow("did not answer");
    });
  });

  it("fails every pending request when the connection ends", async () => {
    const relay = makeCredentialRelay();
    let asking: Promise<CredentialAnswer> | undefined;

    await withConnectedRelay(relay, [], async () => {
      asking = relay.ask({ remote: "github.com/acme/web", sessionToken: "one" });
      // Catch here so the rejection that arrives when the scope closes is not
      // reported as unhandled.
      asking.catch(() => undefined);
      await Promise.resolve();
    });

    await expect(asking).rejects.toThrow("connection to the controller ended");
  });

  it("fails a request made before any connection is attached", async () => {
    await expect(
      makeCredentialRelay().ask({ remote: "github.com/acme/web", sessionToken: "one" }),
    ).rejects.toThrow("no controller connection");
  });
});
