/**
 * The github plugin: what it puts in the catalog, and what it makes of what
 * GitHub answers.
 *
 * `validate` needs an `HttpClient` and nothing else, so the whole of it is
 * exercised here against a stub client: the request it builds is asserted as it
 * was handed over, and every answer GitHub can give is played back.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Result } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type { ConnectionTypeContribution, Plugin, RegistrationHost } from "@hercule/plugin-host";
import { github } from "./index";

/** Runs `register` and hands back everything the plugin contributed. */
const registered = async (plugin: Plugin): Promise<ReadonlyArray<ConnectionTypeContribution>> => {
  const contributions: Array<ConnectionTypeContribution> = [];
  const host: RegistrationHost = {
    connections: {
      registerType: (contribution) =>
        Effect.sync(() => {
          contributions.push(contribution);
        }),
    },
  };
  await Effect.runPromise(plugin.register(host));
  return contributions;
};

/** The requests the stub was handed, and what it answered them with. */
interface Stub {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: Array<HttpClientRequest.HttpClientRequest>;
}

const stub = (
  answer: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
): Stub => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    return answer(request);
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests };
};

/** A stub that answers every request with this status and body. */
const answering = (status: number, body: unknown): Stub =>
  stub((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );

const PAT = "ghp_a-real-looking-token";

/** The one type the plugin contributes, for the tests that drive its `validate`. */
const connectionType = async (): Promise<ConnectionTypeContribution> => {
  const contribution = (await registered(github))[0];
  if (contribution === undefined) throw new Error("the plugin registered no connection type");
  return contribution;
};

/** Runs `validate` against a stub and hands back what it answered, either way. */
const validating = async (
  of: Stub,
): Promise<Result.Result<{ readonly displayName: string }, { readonly message: string }>> => {
  const type = await connectionType();
  return Effect.runPromise(
    Effect.result(type.validate({ pat: PAT })).pipe(Effect.provide(of.layer)),
  );
};

/** The message a refusal carries, for the tests about what it says. */
const messageOf = (
  outcome: Result.Result<{ readonly displayName: string }, { readonly message: string }>,
): string => {
  if (!Result.isFailure(outcome)) throw new Error("validate was expected to fail");
  return outcome.failure.message;
};

describe("what the github plugin registers", () => {
  it("asks for the connections capability and contributes one credentials-flow type", async () => {
    expect(github.manifest).toMatchObject({ id: "github", capabilities: ["connections"] });

    const contributions = await registered(github);

    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({
      type: "github",
      displayName: "GitHub",
      setup: [
        {
          kind: "credentials",
          fields: [expect.objectContaining({ name: "pat", label: "Personal access token" })],
        },
      ],
    });
    // A personal access token is pasted, never redirected for.
    expect(contributions[0]?.oauth).toBeUndefined();
  });
});

describe("what the github plugin makes of GitHub's answer", () => {
  it("asks who the token belongs to, as GitHub requires the question to be asked", async () => {
    const of = answering(200, { login: "octocat" });

    const outcome = await validating(of);

    expect(outcome).toMatchObject({ success: { displayName: "octocat" } });
    const request = of.requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe("https://api.github.com/user");
    expect(request?.headers["authorization"]).toBe(`Bearer ${PAT}`);
    expect(request?.headers["accept"]).toBe("application/vnd.github+json");
    expect(request?.headers["user-agent"] ?? "").not.toBe("");
  });

  it("says the token was rejected when GitHub says the credentials are bad", async () => {
    const outcome = await validating(answering(401, { message: "Bad credentials" }));

    expect(messageOf(outcome)).toContain("rejected");
  });

  it("names the status when GitHub is broken", async () => {
    const outcome = await validating(answering(500, { message: "Server Error" }));

    expect(messageOf(outcome)).toContain("500");
  });

  it("fails, saying something, when the request never got there", async () => {
    const of = stub((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "connection refused",
          }),
        }),
      ),
    );

    const outcome = await validating(of);

    expect(messageOf(outcome).length).toBeGreaterThan(0);
  });
});
