/**
 * Resources over the real API: what a repo resource's canonical remote is, what
 * makes a second one a conflict, what a folder and a mailbox may say, and what
 * a resource holds up - its own deletion while a workspace stands on it, and
 * the deletion of the Connection it names.
 *
 * Everything here goes through `POST/GET/PATCH/DELETE
 * /api/v1/resources` and `DELETE /api/v1/connections/{id}`; the fleet is here
 * because one criterion - a resource a workspace stands on - cannot be arranged
 * without a machine to provision that workspace on.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  type Plugin,
} from "@hydra/plugin-host";
import type { ModelDescriptor, RunnerFacts } from "@hydra/protocol";
import { del, get, post, send } from "../http/testing";
import { fixture, providerDefinition } from "../plugins/testing";
import type { AuditKind } from "../events";
import { until, withFleet as sharedWithFleet, type Arranged } from "../sessions/testing";

/** The account the GitHub type names, which is what a login is read off. */
const LOGIN = "octocat";

const PAT = "ghp_a-token";

/**
 * The GitHub connection type, locally. The shipped plugin's `validate` asks
 * `api.github.com` who the token belongs to, which no test may do; the word it
 * declares and the qualified id the host mints from it are the shipped ones, so
 * what a request names here is what a request names in production.
 */
const githubPlugin: Plugin = {
  manifest: {
    id: "github",
    displayName: "GitHub",
    hostApi: HOST_API,
    capabilities: ["connections"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    registerConnectionType(host, {
      type: "github",
      displayName: "GitHub",
      setup: [{ kind: "credentials", fields: [{ name: "pat", label: "Personal access token" }] }],
      validate: (credentials: Record<string, string>) =>
        credentials["pat"] === PAT
          ? Effect.succeed({ displayName: LOGIN })
          : Effect.fail(new ConnectionValidationFailed({ message: "GitHub rejected the token." })),
    }),
  activate: () => Effect.succeed(Effect.void),
};

/** A connection type that is not GitHub, which a repo resource may not name. */
const otherPlugin: Plugin = {
  manifest: {
    id: "mailer",
    displayName: "Mailer",
    hostApi: HOST_API,
    capabilities: ["connections"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    registerConnectionType(host, {
      type: "mailbox",
      displayName: "Mailbox",
      setup: [{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }],
      validate: () => Effect.succeed({ displayName: "work@example.com" }),
    }),
  activate: () => Effect.succeed(Effect.void),
};

const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [{ name: "git", version: "2.50.1", path: "/usr/bin/git" }],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["test-provider"],
  identityPort: 4939,
};

const MODELS: ReadonlyArray<ModelDescriptor> = [
  { slug: "clever", name: "Clever", isDefault: true, options: [] },
];

const withResources = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, {
    plugins: [
      fixture({ id: "providers", definitions: [providerDefinition("test-provider")] }).plugin,
      githubPlugin,
      otherPlugin,
    ],
    facts: FACTS,
    models: MODELS,
  });

/** A resource as the API hands it back; only the fields asserted here are read. */
interface ResourceRecord {
  readonly id: string;
  readonly kind: string;
  readonly remote?: string | null;
  readonly canonicalRemote?: string | null;
  readonly label?: string | null;
  readonly connectionId?: string | null;
  readonly setupCommand?: string | null;
  readonly workspaceInclude?: boolean;
  readonly projectIds?: ReadonlyArray<string>;
}

const codeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

/**
 * A create answered the way this controller answers a create. The two shipped
 * spellings differ (a connection answers 201, a task 200), and which one a
 * resource takes is not in the criterion, so either is accepted and the body is
 * what is asserted.
 */
const okCreate = async (response: Response): Promise<ResourceRecord> => {
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return (await response.json()) as ResourceRecord;
};

const createResource = (arranged: Arranged, body: unknown): Promise<Response> =>
  post(arranged.harness.base, "/api/v1/resources", body, arranged.token);

const repo = (arranged: Arranged, body: Record<string, unknown> = {}): Promise<ResourceRecord> =>
  createResource(arranged, {
    kind: "repo",
    remote: "https://github.com/acme/web.git",
    ...body,
  }).then(okCreate);

const readResource = async (arranged: Arranged, id: string): Promise<ResourceRecord> => {
  const response = await get(arranged.harness.base, `/api/v1/resources/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ResourceRecord;
};

const queryResources = async (
  arranged: Arranged,
  search = "",
): Promise<ReadonlyArray<ResourceRecord>> => {
  const response = await get(arranged.harness.base, `/api/v1/resources${search}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<ResourceRecord> }).items;
};

const patchResource = (arranged: Arranged, id: string, body: unknown): Promise<Response> =>
  send("PATCH", arranged.harness.base, `/api/v1/resources/${id}`, { body, token: arranged.token });

const project = async (arranged: Arranged, name: string): Promise<string> => {
  const response = await post(arranged.harness.base, "/api/v1/projects", { name }, arranged.token);
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return ((await response.json()) as { id: string }).id;
};

const connection = async (
  arranged: Arranged,
  type: string,
  credentials: Record<string, string>,
): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/connections",
    { type, label: "work", labels: ["Code"], credentials },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

/** What the audit log holds under a kind this feature adds. */
const auditRows = (arranged: Arranged, kind: string) => arranged.harness.audit(kind as AuditKind);

describe("resource.create", () => {
  it("canonicalises a repo's remote to host/owner/repo, however it was spelled", async () => {
    await withResources(async (arranged) => {
      const https = await repo(arranged, { remote: "https://GitHub.com/acme/web" });
      expect(https.kind).toBe("repo");
      expect(https.remote).toBe("https://GitHub.com/acme/web");
      expect(https.canonicalRemote).toBe("github.com/acme/web");

      // The same repo, spelled as ssh with the case the owner writes it in and
      // the `.git` suffix: one repository, one canonical remote.
      const conflict = await createResource(arranged, {
        kind: "repo",
        remote: "git@github.com:Acme/Web.git",
      });
      expect(await codeOf(conflict)).toBe("conflict");

      // And nothing was created by the refused call.
      expect((await queryResources(arranged)).map((one) => one.id)).toEqual([https.id]);
    });
  });

  it("refuses a repo whose connection is not a GitHub one", async () => {
    await withResources(async (arranged) => {
      const mailbox = await connection(arranged, "mailer/mailbox", { token: "t" });
      const refused = await createResource(arranged, {
        kind: "repo",
        remote: "https://github.com/acme/web",
        connectionId: mailbox,
      });
      expect(await codeOf(refused)).toBe("validation");

      const github = await connection(arranged, "github/github", { pat: PAT });
      const accepted = await repo(arranged, { connectionId: github });
      expect(accepted.connectionId).toBe(github);
    });
  });

  it("takes a folder and a mailbox with a label and no remote", async () => {
    await withResources(async (arranged) => {
      const mailbox = await connection(arranged, "mailer/mailbox", { token: "t" });

      const folder = await okCreate(
        await createResource(arranged, { kind: "folder", label: "Notes" }),
      );
      expect(folder.kind).toBe("folder");
      expect(folder.label).toBe("Notes");
      expect(folder.remote ?? null).toBeNull();
      expect(folder.canonicalRemote ?? null).toBeNull();

      const inbox = await okCreate(
        await createResource(arranged, {
          kind: "mailbox",
          label: "Work mail",
          connectionId: mailbox,
        }),
      );
      expect(inbox.kind).toBe("mailbox");
      expect(inbox.label).toBe("Work mail");
      expect(inbox.connectionId).toBe(mailbox);
      expect(inbox.remote ?? null).toBeNull();
    });
  });

  it("appends an audit row for the resource it created", async () => {
    await withResources(async (arranged) => {
      const created = await repo(arranged);
      const rows = await auditRows(arranged, "resource.created");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor).toBe("user");
      expect(JSON.stringify(rows[0]?.payload)).toContain(created.id);
    });
  });
});

describe("resource.query and resource.read", () => {
  it("filters by kind and by project, and reads one back whole", async () => {
    await withResources(async (arranged) => {
      const hydra = await project(arranged, "Hydra");
      const web = await repo(arranged, {
        remote: "https://github.com/acme/web",
        projectIds: [hydra],
        setupCommand: "pnpm install",
        workspaceInclude: true,
      });
      const api = await repo(arranged, { remote: "https://github.com/acme/api" });
      const notes = await okCreate(
        await createResource(arranged, { kind: "folder", label: "Notes" }),
      );

      expect((await queryResources(arranged, "?kind=repo")).map((one) => one.id).sort()).toEqual(
        [web.id, api.id].sort(),
      );
      expect((await queryResources(arranged, "?kind=folder")).map((one) => one.id)).toEqual([
        notes.id,
      ]);
      expect((await queryResources(arranged, `?projectId=${hydra}`)).map((one) => one.id)).toEqual([
        web.id,
      ]);

      const read = await readResource(arranged, web.id);
      expect(read).toMatchObject({
        id: web.id,
        kind: "repo",
        canonicalRemote: "github.com/acme/web",
        setupCommand: "pnpm install",
        workspaceInclude: true,
      });
      expect(read.projectIds).toEqual([hydra]);
    });
  });
});

describe("resource.update", () => {
  it("changes the remote, re-canonicalises it, and refuses one that collides", async () => {
    await withResources(async (arranged) => {
      const web = await repo(arranged, { remote: "https://github.com/acme/web" });
      const api = await repo(arranged, { remote: "https://github.com/acme/api" });

      const moved = await patchResource(arranged, api.id, {
        remote: "git@github.com:acme/API.git",
      });
      expect(moved.status, await moved.clone().text()).toBe(200);
      expect(((await moved.json()) as ResourceRecord).canonicalRemote).toBe("github.com/acme/api");

      const collides = await patchResource(arranged, api.id, {
        remote: "https://github.com/acme/web.git",
      });
      expect(await codeOf(collides)).toBe("conflict");
      // The refused change left the canonical remote where it was.
      expect((await readResource(arranged, api.id)).canonicalRemote).toBe("github.com/acme/api");
      expect((await readResource(arranged, web.id)).canonicalRemote).toBe("github.com/acme/web");
    });
  });

  it("changes the connection, the setup command, the include flag and the projects", async () => {
    await withResources(async (arranged) => {
      const hydra = await project(arranged, "Hydra");
      const side = await project(arranged, "Side");
      const github = await connection(arranged, "github/github", { pat: PAT });
      const web = await repo(arranged, { projectIds: [hydra] });

      const response = await patchResource(arranged, web.id, {
        connectionId: github,
        setupCommand: "pnpm install",
        workspaceInclude: true,
        projectIds: [side],
      });
      expect(response.status, await response.clone().text()).toBe(200);

      const read = await readResource(arranged, web.id);
      expect(read).toMatchObject({
        connectionId: github,
        setupCommand: "pnpm install",
        workspaceInclude: true,
      });
      // The join rows follow the list it was given: the old project no longer
      // finds it, the new one does.
      expect(read.projectIds).toEqual([side]);
      expect(await queryResources(arranged, `?projectId=${hydra}`)).toEqual([]);
      expect((await queryResources(arranged, `?projectId=${side}`)).map((one) => one.id)).toEqual([
        web.id,
      ]);
    });
  });

  it("appends an audit row for the change", async () => {
    await withResources(async (arranged) => {
      const web = await repo(arranged);
      await patchResource(arranged, web.id, { setupCommand: "make" });
      const rows = await auditRows(arranged, "resource.updated");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor).toBe("user");
    });
  });
});

describe("resource.delete", () => {
  it("deletes the row and its project joins, and appends an audit row", async () => {
    await withResources(async (arranged) => {
      const hydra = await project(arranged, "Hydra");
      const web = await repo(arranged, { projectIds: [hydra] });

      const response = await del(
        arranged.harness.base,
        `/api/v1/resources/${web.id}`,
        arranged.token,
      );
      expect([200, 204], await response.clone().text()).toContain(response.status);

      expect(await queryResources(arranged)).toEqual([]);
      expect(await queryResources(arranged, `?projectId=${hydra}`)).toEqual([]);
      const gone = await get(arranged.harness.base, `/api/v1/resources/${web.id}`, arranged.token);
      expect(await codeOf(gone)).toBe("not_found");

      const rows = await auditRows(arranged, "resource.deleted");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor).toBe("user");
    });
  });

  it("refuses while a workspace stands on it, and allows it once that workspace is gone", async () => {
    await withResources(async (arranged) => {
      const web = await repo(arranged);
      const provisioned = await post(
        arranged.harness.base,
        "/api/v1/workspaces",
        { resourceId: web.id, runnerId: arranged.runnerId },
        arranged.token,
      );
      expect([200, 201], await provisioned.clone().text()).toContain(provisioned.status);
      const workspace = (await provisioned.json()) as { id: string };

      const refused = await del(
        arranged.harness.base,
        `/api/v1/resources/${web.id}`,
        arranged.token,
      );
      expect(await codeOf(refused)).toBe("invalid_state");
      expect((await queryResources(arranged)).map((one) => one.id)).toEqual([web.id]);

      // A retired machine loses its workspaces, which is the one way a primary
      // reaches a terminal status.
      const retired = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/retire`,
        { body: {}, token: arranged.token },
      );
      expect(retired.status, await retired.clone().text()).toBe(200);
      await until("marked the workspace lost", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/workspaces/${workspace.id}`,
          arranged.token,
        );
        const row = (await response.json()) as { status?: string };
        return row.status === "lost" ? row : undefined;
      });

      const allowed = await del(
        arranged.harness.base,
        `/api/v1/resources/${web.id}`,
        arranged.token,
      );
      expect([200, 204], await allowed.clone().text()).toContain(allowed.status);
      expect(await queryResources(arranged)).toEqual([]);
    });
  });
});

describe("connection.delete", () => {
  it("is refused while a resource names the connection, and goes through once none does", async () => {
    await withResources(async (arranged) => {
      const github = await connection(arranged, "github/github", { pat: PAT });
      const web = await repo(arranged, { connectionId: github });

      const refused = await del(
        arranged.harness.base,
        `/api/v1/connections/${github}`,
        arranged.token,
      );
      expect(await codeOf(refused)).toBe("invalid_state");
      const still = await get(
        arranged.harness.base,
        `/api/v1/connections/${github}`,
        arranged.token,
      );
      expect(still.status).toBe(200);

      const cleared = await patchResource(arranged, web.id, { connectionId: null });
      expect(cleared.status, await cleared.clone().text()).toBe(200);

      const allowed = await del(
        arranged.harness.base,
        `/api/v1/connections/${github}`,
        arranged.token,
      );
      expect([200, 204], await allowed.clone().text()).toContain(allowed.status);
    });
  });
});
