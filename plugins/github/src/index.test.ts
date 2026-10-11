/**
 * Tests the github plugin: what it adds to the catalog, and how its
 * connection type handles GitHub's responses. Each workflow action's requests
 * and responses are tested beside it, in `actions/`.
 *
 * `validate` needs an `HttpClient` and nothing else, so it is tested in full
 * against the stub client from `testing.ts`: the test checks the request it builds, and replays
 * every kind of response GitHub can give.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result, Schema, SchemaAST } from "effect";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import type {
  ConnectionTypeContribution,
  EventSourceContribution,
  ExternalAccount,
  Plugin,
  RegistrationHost,
  WorkflowActionContribution,
} from "@hercule/plugin-host";
import { FINE_GRAINED_TOKEN_WARNING, NO_READ_ORG_WARNING } from "./connection-type";
import { github } from "./index";
import { runAgainstStub, stubAnswer, stubGithub, stubHttpClient, type GithubStub } from "./testing";

/** Runs `register` and returns everything the plugin contributed. */
const collectContributions = async (
  plugin: Plugin,
): Promise<{
  readonly types: ReadonlyArray<ConnectionTypeContribution>;
  readonly sources: ReadonlyArray<EventSourceContribution>;
  readonly actions: ReadonlyArray<WorkflowActionContribution>;
}> => {
  const types: Array<ConnectionTypeContribution> = [];
  const sources: Array<EventSourceContribution> = [];
  const actions: Array<WorkflowActionContribution> = [];
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
    workflowActions: {
      register: (contribution) =>
        Effect.sync(() => {
          actions.push(contribution);
        }),
    },
  };
  await Effect.runPromise(plugin.register(host));
  return { types, sources, actions };
};

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
  stub: GithubStub,
  credentials: Readonly<Record<string, string>> = { pat: PAT },
): Promise<Result.Result<ExternalAccount, { readonly message: string }>> => {
  const type = await readConnectionType();
  return runAgainstStub(type.validate(credentials), stub);
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
  "github.mentioned",
  "github.pr.opened",
  "github.pr.synchronized",
  "github.pr.review-requested",
  "github.pr.review-request-removed",
  "github.pr.review-submitted",
  "github.pr.commented",
  "github.pr.merged",
  "github.pr.closed",
  "github.pr.labeled",
  "github.pr.checks-completed",
] as const;

/** The actions spec 05 section 4.4 lists, in the order the plugin registers them. */
const ACTIONS = [
  "issue.read",
  "issue.comment",
  "issue.update",
  "pr.read",
  "pr.comment",
  "pr.review",
  "pr.update",
  "pr.merge",
  "pr.create",
  "checks.rerun",
];

describe("what the github plugin registers", () => {
  it("requests the capabilities its connection type, ingest and actions use", () => {
    expect(github.manifest).toMatchObject({
      id: "github",
      capabilities: ["connections", "event-sources", "events", "resources", "workflow-actions"],
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

  it("keeps the kinds that only end a signal or would flood triage away from triage", async () => {
    const kinds = (await collectContributions(github)).sources[0]?.kinds ?? {};

    const hidden = Object.entries(kinds)
      .filter(([, declaration]) => !declaration.availableToTriage)
      .map(([kind]) => kind)
      .sort();
    expect(hidden).toEqual([
      "github.pr.checks-completed",
      "github.pr.labeled",
      "github.pr.review-request-removed",
      "github.pr.synchronized",
    ]);
  });

  it("declares the six signal kinds, reading only the source's own event kinds", async () => {
    const source = (await collectContributions(github)).sources[0]!;
    const signalKinds = source.signalKinds ?? [];

    expect(signalKinds.map((kind) => kind.word)).toEqual([
      "review-requested",
      "team-review-requested",
      "mentioned",
      "assigned",
      "changes-requested",
      "checks-failed",
    ]);
    for (const kind of signalKinds) {
      for (const eventKind of [...kind.from, ...kind.ends.map((end) => end.eventKind)]) {
        expect(source.kinds[eventKind], `${kind.word} reads ${eventKind}`).toBeDefined();
      }
    }
  });

  it("lets a Signal's answer run the five actions spec 05 lists, and no other", async () => {
    const actions = (await collectContributions(github)).actions;

    const answers = actions
      .filter((action) => action.usableIn?.some((place) => place === "signal.answer") === true)
      .map((action) => action.id);
    expect(answers).toEqual([
      "issue.comment",
      "pr.comment",
      "pr.review",
      "pr.merge",
      "checks.rerun",
    ]);
  });

  it("contributes the ten actions, each acting through a GitHub Connection", async () => {
    const actions = (await collectContributions(github)).actions;

    expect(actions.map((action) => action.id)).toEqual(ACTIONS);
    for (const action of actions) {
      expect(action.connection, action.id).toEqual({ type: "github/github" });
      expect(action.displayName, action.id).not.toBe("");
      expect(action.description, action.id).not.toBe("");
    }
  });

  it("gives every action a struct input the host can register, with no connection field", async () => {
    const actions = (await collectContributions(github)).actions;

    for (const action of actions) {
      // The host refuses an id with a `/`, and an input that is not a struct.
      expect(action.id).not.toContain("/");
      const ast = action.input.ast;
      if (!SchemaAST.isObjects(ast)) throw new Error(`the input of ${action.id} is not a struct`);
      // The step's `connection` param names the Connection, and the host
      // removes it before decoding the rest.
      const fields = ast.propertySignatures.map((field) => field.name);
      expect(fields, action.id).not.toContain("connection");
      expect(fields, action.id).toContain("repo");
      // The catalog stores both schemas as JSON Schema.
      expect(() => Schema.toJsonSchemaDocument(action.input), action.id).not.toThrow();
      expect(() => Schema.toJsonSchemaDocument(action.output), action.id).not.toThrow();
    }
  });

  it("describes every field of every action's input", async () => {
    const actions = (await collectContributions(github)).actions;

    for (const action of actions) {
      const document = Schema.toJsonSchemaDocument(action.input);
      const properties = (document.schema["properties"] ?? {}) as Record<
        string,
        { readonly description?: string }
      >;
      expect(Object.keys(properties), action.id).toContain("repo");
      for (const [name, property] of Object.entries(properties)) {
        expect(property.description ?? "", `${action.id}.${name}`).not.toBe("");
      }
    }
  });

  it("refuses a repo that is not written as owner/repo", async () => {
    const read = (await collectContributions(github)).actions.find(
      (action) => action.id === "issue.read",
    );
    if (read === undefined) throw new Error("the plugin registered no issue.read");
    const decode = Schema.decodeUnknownResult(read.input as Schema.Decoder<unknown>);

    for (const repo of [
      "octocat",
      "octocat/hello/world",
      "octocat/..",
      "octocat/.",
      "/x",
      "a b/c",
    ]) {
      expect(Result.isFailure(decode({ repo, number: 1 })), repo).toBe(true);
    }
    expect(Result.isFailure(decode({ repo: "octocat/hello-world", number: 0 }))).toBe(true);
    expect(Result.isSuccess(decode({ repo: "octocat/hello-world.js", number: 1 }))).toBe(true);
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

  it("accepts a fine-grained token with a warning that names what it cannot read", async () => {
    const stub = stubAnswer(200, { login: "octocat", id: 583231 });

    const outcome = await runValidate(stub, { pat: "github_pat_11ABC" });

    expect(outcome).toMatchObject({ success: { warning: FINE_GRAINED_TOKEN_WARNING } });
    const classic = await runValidate(stub);
    expect(Result.isSuccess(classic) && "warning" in classic.success).toBe(false);
  });

  it("warns when a classic token may not read the user's teams", async () => {
    const answerWithScopes = (scopes: string) =>
      stubGithub(() => ({
        status: 200,
        body: { login: "octocat", id: 583231 },
        headers: { "x-oauth-scopes": scopes },
      }));

    const withoutOrg = await runValidate(answerWithScopes("repo, notifications"));
    const withOrg = await runValidate(answerWithScopes("repo, read:org, notifications"));

    expect(withoutOrg).toMatchObject({ success: { warning: NO_READ_ORG_WARNING } });
    expect(Result.isSuccess(withOrg) && "warning" in withOrg.success).toBe(false);
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
