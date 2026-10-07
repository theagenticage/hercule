import { describe, expect, it } from "vitest";
import { buildErrorBody, createApiStub, type Handler } from "./api-stub";
import { createClient } from "./client";
import {
  createProjectWithRepositories,
  isNewProjectCreated,
  type NewProjectForm,
  type RepositorySubmission,
} from "./new-project";
import { buildProject, buildRepo } from "./threads/workspaces.testing";

const PROJECT = buildProject("01a06d02-7000-7000-8000-000000000009", "webshop");
const REPO_ID = "01a06d02-7100-7000-8000-000000000009";

const REPOSITORY: RepositorySubmission = {
  remote: " git@github.com:rogier/webshop.git ",
  setupCommand: "",
  connectionId: null,
  createdId: null,
  message: null,
};

const FORM: NewProjectForm = {
  name: " webshop ",
  projectId: null,
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

describe("onboarding reuses the canonical Resource", () => {
  it.each(["https://github.com/rogier/webshop.git", "ssh://git@github.com/rogier/webshop"])(
    "adds a new project to the existing canonical resource for %s without creating another identity",
    async (remote) => {
      const existing = buildRepo(
        REPO_ID,
        "git@github.com:rogier/webshop.git",
        "github.com/rogier/webshop",
      );
      const otherProject = "01a06d02-7000-7000-8000-0000000000aa";
      const { api, client } = buildController({
        "GET /api/v1/resources": {
          body: { items: [{ ...existing, projectIds: [otherProject] }] },
        },
        [`PATCH /api/v1/resources/${REPO_ID}`]: {
          body: { ...existing, projectIds: [otherProject, PROJECT.id] },
        },
        "POST /api/v1/resources": {
          status: 409,
          body: buildErrorBody("conflict", "Repository already registered"),
        },
      });
      const result = await createProjectWithRepositories(client, {
        ...FORM,
        repositories: [{ ...REPOSITORY, remote }],
      });
      expect(isNewProjectCreated(result)).toBe(true);
      expect(result.repositories[0]?.createdId).toBe(REPO_ID);
      expect(
        api.calls.filter((call) => call.method === "POST" && call.path === "/api/v1/resources"),
      ).toEqual([]);
      expect(api.calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
        { projectIds: [otherProject, PROJECT.id] },
      ]);
      const callsBeforeRetry = api.calls.length;
      expect(isNewProjectCreated(await createProjectWithRepositories(client, result))).toBe(true);
      expect(api.calls.slice(callsBeforeRetry).filter((call) => call.method !== "GET")).toEqual([]);
    },
  );
});
