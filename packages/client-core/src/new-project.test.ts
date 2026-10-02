import { describe, expect, it } from "vitest";
import { buildErrorBody, createApiStub, type Handler } from "./api-stub";
import { createClient } from "./client";
import {
  createProjectWithRepositories,
  isNewProjectCreated,
  PROJECT_NAME_REFUSAL,
  type NewProjectDraft,
  type RepositoryDraft,
} from "./new-project";
import { REMOTE_REFUSAL } from "./remote";
import { buildProject, buildRepo } from "./threads/workspaces.testing";

const PROJECT = buildProject("01a06d02-7000-7000-8000-000000000009", "webshop");
const REPO_ID = "01a06d02-7100-7000-8000-000000000009";
const CONNECTION_ID = "01a06d02-7200-7000-8000-000000000009";

const REPOSITORY: RepositoryDraft = {
  remote: " git@github.com:rogier/webshop.git ",
  setupCommand: "",
  connectionId: null,
  createdId: null,
  message: null,
};

const DRAFT: NewProjectDraft = {
  name: " webshop ",
  projectId: null,
  failure: null,
  repositories: [REPOSITORY],
};

/** Returns a client on a stub controller that answers the two writes with `handlers`. */
const buildController = (handlers: Readonly<Record<string, Handler>> = {}) => {
  const api = createApiStub({
    "POST /api/v1/projects": { body: PROJECT },
    "POST /api/v1/resources": {
      body: buildRepo(REPO_ID, "git@github.com:rogier/webshop.git", "github.com/rogier/webshop"),
    },
    ...handlers,
  });
  return { api, client: createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch }) };
};

const listWrites = (api: ReturnType<typeof buildController>["api"]) =>
  api.calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body]);

describe("createProjectWithRepositories", () => {
  it("creates the project, then each repository in it", async () => {
    const { api, client } = buildController();

    const next = await createProjectWithRepositories(client, {
      ...DRAFT,
      repositories: [
        { ...REPOSITORY, setupCommand: " pnpm install ", connectionId: CONNECTION_ID },
      ],
    });

    expect(listWrites(api)).toEqual([
      ["/api/v1/projects", { name: "webshop" }],
      [
        "/api/v1/resources",
        {
          kind: "repo",
          remote: "git@github.com:rogier/webshop.git",
          connectionId: CONNECTION_ID,
          setupCommand: "pnpm install",
          projectIds: [PROJECT.id],
        },
      ],
    ]);
    expect(next.projectId).toBe(PROJECT.id);
    expect(next.repositories[0]?.createdId).toBe(REPO_ID);
    expect(isNewProjectCreated(next)).toBe(true);
  });

  it("creates a project with no repository, for work that is not code", async () => {
    const { api, client } = buildController();

    const next = await createProjectWithRepositories(client, { ...DRAFT, repositories: [] });

    expect(listWrites(api)).toEqual([["/api/v1/projects", { name: "webshop" }]]);
    expect(isNewProjectCreated(next)).toBe(true);
  });

  it("sends no setup command and no Connection when there is none", async () => {
    const { api, client } = buildController();

    await createProjectWithRepositories(client, DRAFT);

    expect(listWrites(api)[1]?.[1]).toEqual({
      kind: "repo",
      remote: "git@github.com:rogier/webshop.git",
      projectIds: [PROJECT.id],
    });
  });

  it("sends nothing for a blank name", async () => {
    const { api, client } = buildController();

    const next = await createProjectWithRepositories(client, { ...DRAFT, name: "  " });

    expect(next.failure).toBe(PROJECT_NAME_REFUSAL);
    expect(api.calls).toEqual([]);
  });

  it("sends nothing when a remote is one git would not accept, and says which", async () => {
    const { api, client } = buildController();

    const next = await createProjectWithRepositories(client, {
      ...DRAFT,
      repositories: [REPOSITORY, { ...REPOSITORY, remote: "/Users/rogier/webshop" }],
    });

    expect(next.repositories.map((repository) => repository.message)).toEqual([
      null,
      REMOTE_REFUSAL,
    ]);
    expect(api.calls).toEqual([]);
  });

  it("returns the controller's reason when the project is refused, and creates no repository", async () => {
    const { api, client } = buildController({
      "POST /api/v1/projects": {
        status: 500,
        body: buildErrorBody("internal", "the database is locked"),
      },
    });

    const next = await createProjectWithRepositories(client, DRAFT);

    expect(next.failure).toBe("the database is locked");
    expect(next.projectId).toBeNull();
    expect(listWrites(api)).toHaveLength(1);
  });

  it("keeps the project when a repository is refused, and sends only that repository again", async () => {
    let refuse = true;
    const { api, client } = buildController({
      "POST /api/v1/resources": () =>
        refuse
          ? { status: 409, body: buildErrorBody("conflict", "that repo is already a resource") }
          : { body: buildRepo(REPO_ID, "git@github.com:rogier/webshop.git", null) },
    });

    const first = await createProjectWithRepositories(client, DRAFT);
    expect(first.projectId).toBe(PROJECT.id);
    expect(first.repositories[0]?.message).toBe("that repo is already a resource");
    expect(isNewProjectCreated(first)).toBe(false);

    refuse = false;
    const second = await createProjectWithRepositories(client, first);

    expect(listWrites(api).map(([path]) => path)).toEqual([
      "/api/v1/projects",
      "/api/v1/resources",
      "/api/v1/resources",
    ]);
    expect(second.repositories[0]).toMatchObject({ createdId: REPO_ID, message: null });
    expect(isNewProjectCreated(second)).toBe(true);
  });

  it("keeps the fields a caller adds to each repository", async () => {
    const { client } = buildController();

    const next = await createProjectWithRepositories(client, {
      ...DRAFT,
      repositories: [{ ...REPOSITORY, key: "source-1" }],
    });

    expect(next.repositories[0]?.key).toBe("source-1");
  });
});
