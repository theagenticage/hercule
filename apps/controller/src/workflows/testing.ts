/**
 * What the workflow HTTP tests build on: a controller past first-run setup with
 * a provider for Agents and a local GitHub for triggers, and the calls that
 * make and list what a case needs. Written once here, so two suites that check
 * different rules arrange the same controller.
 */
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  registerEventSource,
  type Plugin,
} from "@hercule/plugin-host";
import { completeSetup, get, post, withServer, type ServerHarness } from "../http/testing";
import { fixture, providerDefinition } from "../plugins/testing";

/** A canonical UUIDv7 that names nothing on this controller. */
export const ABSENT_ID = "0192f0a1-0000-7000-8000-00000000dead";

/** The token the local GitHub connection type accepts. */
export const ACCEPTED_GITHUB_TOKEN = "ghp_a-token";

/** The provider an agent step's Agent runs on. */
export const AGENT_PROVIDER = providerDefinition("test-provider", { token: "t" });

/**
 * GitHub, locally: its connection type and the one event kind these cases
 * name. The shipped plugin's `validate` asks api.github.com who a token
 * belongs to, which no test may do. The words it declares, and the qualified
 * ids the host makes from them, are the shipped ones.
 */
export const localGithubPlugin: Plugin = {
  manifest: {
    id: "github",
    displayName: "GitHub",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    Effect.andThen(
      registerConnectionType(host, {
        type: "github",
        displayName: "GitHub",
        setup: [{ kind: "credentials", fields: [{ name: "pat", label: "Personal access token" }] }],
        validate: (credentials: Record<string, string>) =>
          credentials["pat"] === ACCEPTED_GITHUB_TOKEN
            ? Effect.succeed({ displayName: "octocat" })
            : Effect.fail(
                new ConnectionValidationFailed({ message: "GitHub rejected the token." }),
              ),
      }),
      registerEventSource(host, {
        id: "github",
        connectionType: "github/github",
        kinds: {
          "github.pr.labeled": {
            description: "The labels on a pull request changed.",
            schema: Schema.Struct({
              subject: Schema.Struct({ repo: Schema.String, url: Schema.String }),
              added: Schema.Array(Schema.String),
              removed: Schema.Array(Schema.String),
            }),
          },
        },
      }),
    ),
  activate: () => Effect.succeed(Effect.void),
};

/** A controller past first-run setup, and the user's credential on it. */
export interface SetUpController {
  readonly harness: ServerHarness;
  readonly base: string;
  readonly token: string;
}

/** A controller past setup, with a provider for Agents and GitHub for triggers. */
export const withSetUpController = (
  body: (controller: SetUpController) => Promise<void>,
): Promise<void> =>
  withServer(
    async (harness) => {
      const token = await completeSetup(harness.base);
      await body({ harness, base: harness.base, token });
    },
    {
      plugins: [
        fixture({ id: "providers", definitions: [AGENT_PROVIDER] }).plugin,
        localGithubPlugin,
      ],
    },
  );

/** A workflow as `workflow.read` answers it. */
export interface WorkflowRecord {
  readonly id: string;
  readonly enabled: boolean;
  readonly source: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A workflow as one `workflow.query` item answers it. */
export interface WorkflowItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

/** A trigger as one `trigger.query` item answers it. */
export interface TriggerItem {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly triggerId: string;
  readonly kind: string;
  readonly eventKind: string;
  readonly connectionId?: string;
  readonly filter?: string;
  readonly schedule?: string;
  readonly timezone?: string;
  readonly status?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const createWorkflow = (base: string, token: string, body: unknown): Promise<Response> =>
  post(base, "/api/v1/workflows", body, token);

/**
 * A create that worked, answered with the record it stored. Which of the two
 * success statuses this controller uses for a create is not what these cases
 * are about, so either one is taken and the body is what is read.
 */
export const createWorkflowOrFail = async (
  base: string,
  token: string,
  body: unknown,
): Promise<WorkflowRecord> => {
  const response = await createWorkflow(base, token, body);
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return ((await response.json()) as { workflow: WorkflowRecord }).workflow;
};

export interface WorkflowPage {
  readonly items: ReadonlyArray<WorkflowItem>;
  readonly nextCursor?: string;
}

export const queryWorkflows = async (
  base: string,
  token: string,
  query = "",
): Promise<WorkflowPage> => {
  const response = await get(base, `/api/v1/workflows${query}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as WorkflowPage;
};

export const queryTriggers = async (
  base: string,
  token: string,
  query = "",
): Promise<ReadonlyArray<TriggerItem>> => {
  const response = await get(base, `/api/v1/triggers${query}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<TriggerItem> }).items;
};

/** A refusal left no workflow and no trigger row behind. */
export const expectNothingStored = async (base: string, token: string): Promise<void> => {
  expect((await queryWorkflows(base, token)).items).toEqual([]);
  expect(await queryTriggers(base, token)).toEqual([]);
};

/** An Agent on the test provider, which an agent step can name by its id. */
export const createAgent = async (base: string, token: string): Promise<string> => {
  const providers = await get(base, "/api/v1/providers", token);
  expect(providers.status, await providers.clone().text()).toBe(200);
  const instance = (
    (await providers.json()) as ReadonlyArray<{ id: string; providerId: string }>
  ).find((provider) => provider.providerId === AGENT_PROVIDER.id);
  expect(instance, AGENT_PROVIDER.id).toBeDefined();
  const profiles = await get(base, "/api/v1/profiles", token);
  expect(profiles.status, await profiles.clone().text()).toBe(200);
  const profile = (
    (await profiles.json()) as { items: ReadonlyArray<{ id: string; name: string }> }
  ).items.find((listed) => listed.name === "worker");
  expect(profile, "the shipped worker profile").toBeDefined();
  const response = await post(
    base,
    "/api/v1/agents",
    {
      name: "reviewer",
      systemPrompt: "You review pull requests.",
      instanceId: instance!.id,
      permissionProfileId: profile!.id,
    },
    token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { id: string }).id;
};

/**
 * A Connection of a qualified type, such as `github/github`, which a trigger on
 * one of that type's event kinds can name.
 */
export const createConnection = async (
  base: string,
  token: string,
  type: string,
  credentials: Record<string, string>,
): Promise<string> => {
  const response = await post(
    base,
    "/api/v1/connections",
    { type, label: "work", labels: ["Code"], credentials },
    token,
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
};
