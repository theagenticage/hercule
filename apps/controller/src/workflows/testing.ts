/**
 * Shared helpers for the workflow tests: a set-up controller with a provider
 * for Agents and a local GitHub plugin for triggers, HTTP helpers that create,
 * update and list workflows and triggers, a reader for validation errors, and
 * sample workflow sources. The suites share them so that they all run against
 * the same controller setup and the same sources.
 */
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import type { Issue, Trigger, Workflow } from "@hercule/contract";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  registerEventSource,
  type Plugin,
} from "@hercule/plugin-host";
import {
  completeSetup,
  get,
  post,
  readErrorBody,
  send,
  withServer,
  type ServerHarness,
} from "../http/testing";
import { createPluginFixture, buildProviderDefinition } from "../plugins/testing";
import type { WorkflowPage } from "./service";

/** A valid UUIDv7 that is not the id of anything on the test controller. */
export const ABSENT_ID = "0192f0a1-0000-7000-8000-00000000dead";

/** The token the local GitHub connection type accepts. */
export const ACCEPTED_GITHUB_TOKEN = "ghp_a-token";

/** The provider an agent step's Agent runs on. */
export const AGENT_PROVIDER = buildProviderDefinition("test-provider", { token: "t" });

/**
 * A local stand-in for the GitHub plugin, with its Connection type and the one
 * event kind these tests use. The real plugin's `validate` calls
 * api.github.com to check a token, and tests must not make network calls. The
 * ids it declares, and so the qualified ids, are the same as the real
 * plugin's.
 */
const localGithubPlugin: Plugin = {
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

/** A controller that has completed first-run setup, and the user's token for it. */
export interface SetUpController {
  readonly harness: ServerHarness;
  readonly base: string;
  readonly token: string;
}

/**
 * Starts a controller, completes first-run setup, and runs `body` against it.
 * The controller has a provider for Agents and the local GitHub plugin for
 * triggers. `additionalPlugins` are installed too, for tests that need a
 * Connection type or a workflow action that GitHub does not declare.
 */
export const withSetUpController = (
  body: (controller: SetUpController) => Promise<void>,
  additionalPlugins: ReadonlyArray<Plugin> = [],
): Promise<void> =>
  withServer(
    async (harness) => {
      const token = await completeSetup(harness.base);
      await body({ harness, base: harness.base, token });
    },
    {
      plugins: [
        createPluginFixture({ id: "providers", definitions: [AGENT_PROVIDER] }).plugin,
        localGithubPlugin,
        ...additionalPlugins,
      ],
    },
  );

/**
 * Builds the YAML lines of a valid action step that creates a task, for use
 * under `steps:`. Each extra line is added to the step. Most tests need valid
 * steps, so that the one broken part is the only error.
 */
export const buildTaskStep = (id: string, ...extraLines: ReadonlyArray<string>): string =>
  [
    `  - id: ${id}`,
    "    kind: action",
    "    action: task.create",
    "    params:",
    `      title: File the ${id} task`,
    "      description: Filed by a workflow.",
    ...extraLines.map((line) => `    ${line}`),
  ].join("\n");

/**
 * Builds the smallest valid workflow source: one step that creates a task.
 * `description` becomes the workflow's description if given.
 */
export const buildFileTaskSource = (name: string, description?: string): string =>
  [
    `name: ${name}`,
    ...(description === undefined ? [] : [`description: ${description}`]),
    "steps:",
    buildTaskStep("file_task"),
    "",
  ].join("\n");

// The sources below fail to parse, so they never reach the controller's
// validation. Each one is broken in exactly one place, so the error points at
// that place and nowhere else.

/** Line 9 of this source has a stray word after a closing quote, at column 20. */
export const SYNTAX_ERROR_SOURCE = `# A workflow with one broken line.
name: broken

steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: "one" two
      description: body
`;

/** A step with an unknown kind. */
export const WRONG_KIND_SOURCE = `name: wrong kind
steps:
  - id: file_task
    kind: script
    action: task.create
`;

/** Two steps with one id. */
export const DUPLICATE_STEP_ID_SOURCE = `name: two steps, one id
steps:
${buildTaskStep("file_task")}
${buildTaskStep("file_task")}
`;

/** A step id that is not snake_case. The snake_case form is open_pr. */
export const KEBAB_CASE_STEP_ID_SOURCE = `name: kebab step
steps:
${buildTaskStep("open-pr")}
`;

export const createWorkflow = (base: string, token: string, body: unknown): Promise<Response> =>
  post(base, "/api/v1/workflows", body, token);

export const updateWorkflow = (
  base: string,
  token: string,
  id: string,
  body: unknown,
): Promise<Response> => send("PATCH", base, `/api/v1/workflows/${id}`, { body, token });

/**
 * Returns the issues of a 400 `validation` error response, each with its path
 * and message. Asserts the status first, so if the request succeeded, the test
 * fails here and shows the response body.
 */
export const readIssues = async (response: Response): Promise<ReadonlyArray<Issue>> => {
  expect(response.status, await response.clone().text()).toBe(400);
  const refusal = await readErrorBody(response);
  expect(refusal.code).toBe("validation");
  return (JSON.parse(refusal.text) as { error: { details: { issues: ReadonlyArray<Issue> } } })
    .error.details.issues;
};

/**
 * Creates a workflow and returns it, or fails the test if the create fails.
 * Accepts either 200 or 201, because these tests are not about which success
 * status a create returns.
 */
export const createWorkflowOrFail = async (
  base: string,
  token: string,
  body: unknown,
): Promise<Workflow> => {
  const response = await createWorkflow(base, token, body);
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return ((await response.json()) as { workflow: Workflow }).workflow;
};

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
): Promise<ReadonlyArray<Trigger>> => {
  const response = await get(base, `/api/v1/triggers${query}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Trigger> }).items;
};

/** Asserts that no workflow and no trigger is stored, for example after a failed save. */
export const expectNothingStored = async (base: string, token: string): Promise<void> => {
  expect((await queryWorkflows(base, token)).items).toEqual([]);
  expect(await queryTriggers(base, token)).toEqual([]);
};

/** Creates an Agent on the test provider and returns its id, for use in an agent step. */
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
 * Creates a Connection of a qualified type, such as `github/github`, and
 * returns its id, for use in a trigger on one of that type's event kinds.
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
