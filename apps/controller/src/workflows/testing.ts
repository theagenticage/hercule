/**
 * What the workflow tests build on: a controller past first-run setup with a
 * provider for Agents and a local GitHub for triggers, the calls that make,
 * change and list what a case needs, the read of what a refusal names, and
 * the sources that the cases send. Written once here, so the suites that check
 * different rules arrange the same controller and send the same sources.
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
  readRefusal,
  send,
  withServer,
  type ServerHarness,
} from "../http/testing";
import { fixture, providerDefinition } from "../plugins/testing";
import type { WorkflowPage } from "./service";

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

/** A controller past first-run setup, and the user's credential on it. */
export interface SetUpController {
  readonly harness: ServerHarness;
  readonly base: string;
  readonly token: string;
}

/**
 * A controller past setup, with a provider for Agents and GitHub for triggers.
 * `additionalPlugins` are installed beside the two, for a suite whose cases
 * need a Connection type or a workflow action that GitHub does not declare.
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
        fixture({ id: "providers", definitions: [AGENT_PROVIDER] }).plugin,
        localGithubPlugin,
        ...additionalPlugins,
      ],
    },
  );

/**
 * An action step that files a task, as YAML lines under `steps:`. Most cases
 * need steps that are valid in every way, so that the one broken element is
 * the only thing refused. Each extra line is written under the step.
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
 * The smallest workflow a controller accepts: one step that files a task.
 * `description` is the description of the workflow, where a case needs one.
 */
export const buildFileTaskSource = (name: string, description?: string): string =>
  [
    `name: ${name}`,
    ...(description === undefined ? [] : [`description: ${description}`]),
    "steps:",
    buildTaskStep("file_task"),
    "",
  ].join("\n");

// The sources below are refused by the parse, before any check of meaning.
// Each one is broken in one place and valid in every other way, so a refusal
// names exactly the place that is broken.

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

/** A step with a kind that does not exist. */
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

/** A step id that is not snake_case. The snake_case spelling is open_pr. */
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
 * The issues a validation refusal names, each with its path and its message.
 * A case that reads only the paths reads them from `readRefusal`. The status
 * is checked before the body is read as a refusal, so a save that was taken
 * fails here with the body it answered.
 */
export const readIssues = async (response: Response): Promise<ReadonlyArray<Issue>> => {
  expect(response.status, await response.clone().text()).toBe(400);
  const refusal = await readRefusal(response);
  expect(refusal.code).toBe("validation");
  return (JSON.parse(refusal.text) as { error: { details: { issues: ReadonlyArray<Issue> } } })
    .error.details.issues;
};

/**
 * A create that worked, answered with the record it stored. Which of the two
 * success statuses this controller uses for a create is not what these cases
 * are about, so either one is taken and the body is what is read.
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
