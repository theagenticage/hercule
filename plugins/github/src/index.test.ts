/**
 * Tests the github plugin: what it adds to the catalog, and how it handles
 * GitHub's responses.
 *
 * `validate` needs an `HttpClient` and nothing else, so it is tested in full
 * against a stub client: the test checks the request it builds, and replays
 * every kind of response GitHub can give.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Result } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type {
  ConnectionTypeContribution,
  EventSourceDefinition,
  ExternalAccount,
  Plugin,
  RegistrationHost,
} from "@hercule/plugin-host";
import { github } from "./index";

/** Runs `register` and returns everything the plugin contributed. */
const collectContributions = async (
  plugin: Plugin,
): Promise<{
  readonly types: ReadonlyArray<ConnectionTypeContribution>;
  readonly sources: ReadonlyArray<EventSourceDefinition>;
}> => {
  const types: Array<ConnectionTypeContribution> = [];
  const sources: Array<EventSourceDefinition> = [];
  const host: RegistrationHost = {
    connections: {
      registerType: (contribution) =>
        Effect.sync(() => {
          types.push(contribution);
        }),
    },
    eventSources: {
      register: (definition) =>
        Effect.sync(() => {
          sources.push(definition);
        }),
    },
  };
  await Effect.runPromise(plugin.register(host));
  return { types, sources };
};

/** The requests the stub received, and the response it returned. */
interface Stub {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly requests: Array<HttpClientRequest.HttpClientRequest>;
}

const stubHttpClient = (
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

/** Builds a stub that responds to every request with this status and body. */
const stubAnswer = (status: number, body: unknown): Stub =>
  stubHttpClient((request) =>
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
const readConnectionType = async (): Promise<ConnectionTypeContribution> => {
  const contribution = (await collectContributions(github)).types[0];
  if (contribution === undefined) throw new Error("the plugin registered no connection type");
  return contribution;
};

/**
 * Runs `validate` against a stub and returns its result, success or failure.
 * The credentials default to a pasted token.
 */
const runValidate = async (
  stub: Stub,
  credentials: Readonly<Record<string, string>> = { pat: PAT },
): Promise<Result.Result<ExternalAccount, { readonly message: string }>> => {
  const type = await readConnectionType();
  return Effect.runPromise(
    Effect.result(type.validate(credentials)).pipe(Effect.provide(stub.layer)),
  );
};

/** Returns the message of a failed validation. */
const readFailureMessage = (
  outcome: Result.Result<ExternalAccount, { readonly message: string }>,
): string => {
  if (!Result.isFailure(outcome)) throw new Error("validate was expected to fail");
  return outcome.failure.message;
};

/** The kinds the pipeline spec lists, written out because the list itself is what is tested. */
const KINDS = [
  "github.notification",
  "github.issue.opened",
  "github.issue.closed",
  "github.issue.reopened",
  "github.issue.labeled",
  "github.issue.assigned",
  "github.issue.commented",
  "github.pr.opened",
  "github.pr.synchronized",
  "github.pr.review-submitted",
  "github.pr.commented",
  "github.pr.merged",
  "github.pr.closed",
  "github.pr.labeled",
  "github.pr.checks-completed",
] as const;

describe("what the github plugin registers", () => {
  it("requests the connections and event-sources capabilities", () => {
    expect(github.manifest).toMatchObject({
      id: "github",
      capabilities: ["connections", "event-sources"],
    });
  });

  it("contributes one type that offers a device flow and a pasted token", async () => {
    const contributions = (await collectContributions(github)).types;

    expect(contributions).toHaveLength(1);
    expect(contributions[0]).toMatchObject({
      type: "github",
      displayName: "GitHub",
      setup: [
        { kind: "device" },
        {
          kind: "credentials",
          fields: [expect.objectContaining({ name: "pat", label: "Personal access token" })],
        },
      ],
      device: {
        deviceCodeUrl: "https://github.com/login/device/code",
        tokenUrl: "https://github.com/login/oauth/access_token",
        scopes: ["repo", "read:org", "notifications", "workflow"],
      },
    });
    expect(contributions[0]?.device?.clientId ?? "").not.toBe("");
    // A type offers a redirect flow or a device flow, never both.
    expect(contributions[0]?.oauth).toBeUndefined();
  });

  it("contributes one event source that declares every kind", async () => {
    const sources = (await collectContributions(github)).sources;

    expect(sources).toHaveLength(1);
    expect(sources[0]?.id).toBe("github");
    expect(sources[0]?.connectionType).toBe("github/github");
    expect(Object.keys(sources[0]?.kinds ?? {}).sort()).toEqual([...KINDS].sort());
    for (const kind of KINDS) {
      expect(sources[0]?.kinds[kind]?.description ?? "", kind).not.toBe("");
    }
  });
});

describe("how the github plugin handles GitHub's response", () => {
  it("asks which account the token belongs to, with the headers GitHub requires", async () => {
    const stub = stubAnswer(200, { login: "octocat", id: 583231 });

    const outcome = await runValidate(stub);

    expect(outcome).toMatchObject({ success: { displayName: "octocat", accountId: "583231" } });
    const request = stub.requests[0];
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe("https://api.github.com/user");
    expect(request?.headers["authorization"]).toBe(`Bearer ${PAT}`);
    expect(request?.headers["accept"]).toBe("application/vnd.github+json");
    expect(request?.headers["user-agent"] ?? "").not.toBe("");
  });

  it("sends the access token the device flow obtained when no token was pasted", async () => {
    const stub = stubAnswer(200, { login: "octocat", id: 583231 });

    const outcome = await runValidate(stub, { accessToken: "gho_device-token" });

    expect(outcome).toMatchObject({ success: { displayName: "octocat", accountId: "583231" } });
    expect(stub.requests[0]?.headers["authorization"]).toBe("Bearer gho_device-token");
  });

  it("fails without calling GitHub when it was given no token", async () => {
    const stub = stubAnswer(200, { login: "octocat", id: 583231 });

    const outcome = await runValidate(stub, {});

    expect(readFailureMessage(outcome)).toContain("No GitHub token");
    expect(stub.requests).toEqual([]);
  });

  it("fails when GitHub's response has no user id, which a reconnect needs to compare", async () => {
    const outcome = await runValidate(stubAnswer(200, { login: "octocat" }));

    expect(readFailureMessage(outcome)).toBe(
      "GitHub's response did not include the account's login and user id.",
    );
  });

  it("reports the token as rejected when GitHub returns 401", async () => {
    const outcome = await runValidate(stubAnswer(401, { message: "Bad credentials" }));

    expect(readFailureMessage(outcome)).toContain("rejected");
  });

  it("includes the status in the message when GitHub fails", async () => {
    const outcome = await runValidate(stubAnswer(500, { message: "Server Error" }));

    expect(readFailureMessage(outcome)).toContain("500");
  });

  it("fails with a message when the request never reached GitHub", async () => {
    const stub = stubHttpClient((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "connection refused",
          }),
        }),
      ),
    );

    const outcome = await runValidate(stub);

    expect(readFailureMessage(outcome).length).toBeGreaterThan(0);
  });
});
