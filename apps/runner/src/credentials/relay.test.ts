/**
 * Tests how the relay sends a helper's request to the controller and matches
 * the answer back to it. Two things matter:
 *
 * - each answer reaches the request it belongs to;
 * - a request with no answer fails with an error instead of being reported as
 *   a denial. The socket turns that error into an empty reply, which git reads
 *   as "try the next helper". A denial would tell the user they were refused.
 *
 * The runner's request for a session's GitHub token goes through the same
 * relay and follows the same rules. It is also never sent to a controller that
 * did not list the capability.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type {
  CredentialAnswer,
  CredentialRequest,
  GithubTokenAnswer,
  GithubTokenRequest,
} from "@hercule/protocol";
import { makeCredentialRelay } from "./relay";
import { CREDENTIAL_DEADLINE_MS } from "./socket";

const buildCredentialAnswer = (requestId: string, token: string): CredentialAnswer => ({
  _tag: "credentialAnswer",
  requestId,
  token,
  username: "octocat",
});

const buildGithubTokenAnswer = (requestId: string, token: string): GithubTokenAnswer => ({
  _tag: "githubTokenAnswer",
  requestId,
  token,
});

/**
 * Attaches a fake connection that records every sent request, and keeps it
 * while `body` runs. The fake controller lists the GitHub token capability
 * unless `githubTokens` is false.
 */
const withConnectedRelay = async (
  relay: ReturnType<typeof makeCredentialRelay>,
  sent: Array<CredentialRequest | GithubTokenRequest>,
  body: () => Promise<void>,
  options: { readonly githubTokens?: boolean } = {},
): Promise<void> => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* relay.attachConnection(
          (frame) =>
            Effect.sync(() => {
              sent.push(frame);
            }),
          { answersGithubTokens: options.githubTokens !== false },
        );
        yield* Effect.promise(body);
      }),
    ),
  );
};

describe("what the relay does with an answer", () => {
  it("matches each answer to its request by id, even when answers arrive out of order", async () => {
    const relay = makeCredentialRelay();
    const sent: Array<CredentialRequest | GithubTokenRequest> = [];

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

    expect(sent.map((frame) => ("remote" in frame ? frame.remote : undefined))).toEqual([
      "github.com/acme/web",
      "github.com/acme/api",
    ]);
  });

  it("delivers a GitHub token answer to the request for it, with the session's token", async () => {
    const relay = makeCredentialRelay();
    const sent: Array<CredentialRequest | GithubTokenRequest> = [];

    await withConnectedRelay(relay, sent, async () => {
      const asking = relay.askGithubToken("the-session");
      await Promise.resolve();
      expect(sent).toEqual([
        { _tag: "githubTokenRequest", requestId: sent[0]!.requestId, sessionToken: "the-session" },
      ]);
      relay.deliver(buildGithubTokenAnswer(sent[0]!.requestId, "ghs_new"));

      await expect(asking).resolves.toMatchObject({ token: "ghs_new" });
    });
  });

  it("does not let an answer of one kind resolve a request of the other", async () => {
    const relay = makeCredentialRelay({ deadlineMs: 20 });
    const sent: Array<CredentialRequest | GithubTokenRequest> = [];

    await withConnectedRelay(relay, sent, async () => {
      const asking = relay.askGithubToken("the-session");
      await Promise.resolve();
      relay.deliver(buildCredentialAnswer(sent[0]!.requestId, "not-a-github-answer"));

      await expect(asking).rejects.toThrow("did not answer");
    });
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

  it("fails a GitHub token request when the controller does not answer in time", async () => {
    const relay = makeCredentialRelay({ deadlineMs: 5 });

    await withConnectedRelay(relay, [], async () => {
      await expect(relay.askGithubToken("the-session")).rejects.toThrow("did not answer");
    });
  });

  it("gives up on a GitHub token request before the shim's client gives up on the runner", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const relay = makeCredentialRelay();
      let gitSettled = false;

      await withConnectedRelay(relay, [], async () => {
        const git = relay.ask({ remote: "github.com/acme/web", sessionToken: "one" });
        git.catch(() => undefined).finally(() => (gitSettled = true));
        const github = relay.askGithubToken("the-session");
        const githubFailure = expect(github).rejects.toThrow("did not answer");
        await Promise.resolve();

        // The client waits CREDENTIAL_DEADLINE_MS. The runner must be done before that, so it
        // can still answer from its own copy. git's request keeps the whole deadline.
        await vi.advanceTimersByTimeAsync(CREDENTIAL_DEADLINE_MS - 1);
        await githubFailure;
        expect(gitSettled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(git).rejects.toThrow("did not answer");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails every pending GitHub token request when the connection ends", async () => {
    const relay = makeCredentialRelay();
    let asking: Promise<GithubTokenAnswer> | undefined;

    await withConnectedRelay(relay, [], async () => {
      asking = relay.askGithubToken("the-session");
      asking.catch(() => undefined);
      await Promise.resolve();
    });

    await expect(asking).rejects.toThrow("connection to the controller ended");
  });

  it("sends no GitHub token request to a controller that did not list the capability", async () => {
    const relay = makeCredentialRelay();
    const sent: Array<CredentialRequest | GithubTokenRequest> = [];

    await withConnectedRelay(
      relay,
      sent,
      async () => {
        await expect(relay.askGithubToken("the-session")).rejects.toThrow(
          "does not answer GitHub token requests",
        );
      },
      { githubTokens: false },
    );

    expect(sent).toEqual([]);
  });

  it("forgets the capability of a connection that ended, so the next controller is asked again", async () => {
    const relay = makeCredentialRelay();
    await withConnectedRelay(relay, [], () => Promise.resolve());

    await withConnectedRelay(
      relay,
      [],
      async () => {
        await expect(relay.askGithubToken("the-session")).rejects.toThrow(
          "does not answer GitHub token requests",
        );
      },
      { githubTokens: false },
    );
  });

  it("fails a request made before any connection is attached", async () => {
    await expect(
      makeCredentialRelay().ask({ remote: "github.com/acme/web", sessionToken: "one" }),
    ).rejects.toThrow("no controller connection");
  });
});
