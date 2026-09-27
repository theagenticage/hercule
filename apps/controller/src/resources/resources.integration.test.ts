/**
 * Resources over the real API:
 *
 * - how a repo's remote is canonicalized, and when a second repo conflicts
 * - which fields a folder and a mailbox may have
 * - what a resource blocks: its own deletion while a workspace uses it, and
 *   the deletion of its Connection
 *
 * Everything here goes through `POST/GET/PATCH/DELETE /api/v1/resources` and
 * `DELETE /api/v1/connections/{id}`. The tests need a fleet because a
 * resource used by a workspace cannot be set up without a runner to provision
 * that workspace on.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  type Plugin,
} from "@hercule/plugin-host";
import { del, get, post, send } from "../http/testing";
import type { AuditKind } from "../events";
import { waitUntil, type Arranged } from "../sessions/testing";
import { readErrorCode, withFleet } from "../workspaces/testing";

/** The login the local GitHub type returns for `PAT`. */
const LOGIN = "octocat";

const PAT = "ghp_a-token";

/**
 * A local GitHub connection type. The shipped plugin's `validate` asks
 * `api.github.com` who the token belongs to, which no test may do. The type
 * name and the qualified id the host builds from it are the same as the
 * shipped ones, so requests here use the same ids as in production.
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

/** A connection type that is not GitHub, which a repo resource may not use. */
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

const withResources = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  withFleet(body, { plugins: [githubPlugin, otherPlugin] });

/** A resource as the API returns it; only the fields these tests assert on are listed. */
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

/**
 * Checks that a create succeeded, and returns the created resource. Other
 * create operations differ (a connection returns 201, a task 200), and the
 * spec does not say which one a resource returns, so either status is accepted
 * and the tests assert on the body.
 */
const parseCreatedResource = async (response: Response): Promise<ResourceRecord> => {
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return (await response.json()) as ResourceRecord;
};

const createResource = (arranged: Arranged, body: unknown): Promise<Response> =>
  post(arranged.harness.base, "/api/v1/resources", body, arranged.token);

const createRepo = (
  arranged: Arranged,
  body: Record<string, unknown> = {},
): Promise<ResourceRecord> =>
  createResource(arranged, {
    kind: "repo",
    remote: "https://github.com/acme/web.git",
    ...body,
  }).then(parseCreatedResource);

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

const createProject = async (arranged: Arranged, name: string): Promise<string> => {
  const response = await post(arranged.harness.base, "/api/v1/projects", { name }, arranged.token);
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return ((await response.json()) as { id: string }).id;
};

const createConnection = async (
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

/** Reads the audit rows of one kind. */
const readAuditRows = (arranged: Arranged, kind: AuditKind) => arranged.harness.audit(kind);

describe("resource.create", () => {
  it("canonicalizes a repo's remote to host/owner/repo, however it was written", async () => {
    await withResources(async (arranged) => {
      const https = await createRepo(arranged, { remote: "https://GitHub.com/acme/web" });
      expect(https.kind).toBe("repo");
      expect(https.remote).toBe("https://GitHub.com/acme/web");
      expect(https.canonicalRemote).toBe("github.com/acme/web");

      // The same repo, written in scp-like form, with different case and a
      // `.git` suffix: one repository, one canonical remote.
      const conflict = await createResource(arranged, {
        kind: "repo",
        remote: "git@github.com:Acme/Web.git",
      });
      expect(await readErrorCode(conflict)).toBe("conflict");

      // The rejected call created nothing.
      expect((await queryResources(arranged)).map((one) => one.id)).toEqual([https.id]);
    });
  });

  it("rejects a repo whose connection is not a GitHub connection", async () => {
    await withResources(async (arranged) => {
      const mailbox = await createConnection(arranged, "mailer/mailbox", { token: "t" });
      const refused = await createResource(arranged, {
        kind: "repo",
        remote: "https://github.com/acme/web",
        connectionId: mailbox,
      });
      expect(await readErrorCode(refused)).toBe("validation");

      const github = await createConnection(arranged, "github/github", { pat: PAT });
      const accepted = await createRepo(arranged, { connectionId: github });
      expect(accepted.connectionId).toBe(github);
    });
  });

  it("accepts a folder and a mailbox with a label and no remote", async () => {
    await withResources(async (arranged) => {
      const mailbox = await createConnection(arranged, "mailer/mailbox", { token: "t" });

      const folder = await parseCreatedResource(
        await createResource(arranged, { kind: "folder", label: "Notes" }),
      );
      expect(folder.kind).toBe("folder");
      expect(folder.label).toBe("Notes");
      expect(folder.remote ?? null).toBeNull();
      expect(folder.canonicalRemote ?? null).toBeNull();

      const inbox = await parseCreatedResource(
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
      // Neither is ever checked out, so neither has the two fields that only
      // apply to a checkout.
      expect(folder.setupCommand ?? null).toBeNull();
      expect(folder.workspaceInclude).toBe(false);
      expect(inbox.workspaceInclude).toBe(false);
    });
  });

  /**
   * Each kind accepts only the fields that mean something for it:
   *
   * - A repo is named by its remote, so a label would be a second name that
   *   nothing reads.
   * - A folder and a mailbox are never checked out, so a setup command and
   *   the include flag would apply to a checkout that can never exist.
   *
   * Both are rejected rather than stored.
   */
  it("rejects a label on a repo, and the checkout fields on any other kind", async () => {
    await withResources(async (arranged) => {
      const labelled = await createResource(arranged, {
        kind: "repo",
        remote: "https://github.com/acme/web",
        label: "Web",
      });
      expect(labelled.status, await labelled.clone().text()).toBe(400);
      expect(await labelled.text()).toContain("named by its remote");

      for (const field of [{ setupCommand: "pnpm install" }, { workspaceInclude: true }]) {
        const refused = await createResource(arranged, {
          kind: "folder",
          label: "Notes",
          ...field,
        });
        expect(refused.status, await refused.clone().text()).toBe(400);
        expect(await refused.text()).toContain("never checked out");
      }
    });
  });

  it("rejects the same fields on an update", async () => {
    await withResources(async (arranged) => {
      const web = await createRepo(arranged);
      const folder = await parseCreatedResource(
        await createResource(arranged, { kind: "folder", label: "Notes" }),
      );

      const labelled = await patchResource(arranged, web.id, { label: "Web" });
      expect(labelled.status, await labelled.clone().text()).toBe(400);

      const included = await patchResource(arranged, folder.id, { workspaceInclude: true });
      expect(included.status, await included.clone().text()).toBe(400);
      // Clearing a label a repo never had adds no second name, so it is an
      // allowed no-op.
      const cleared = await patchResource(arranged, web.id, { label: null });
      expect(cleared.status, await cleared.clone().text()).toBe(200);
    });
  });

  it("appends an audit row for the resource it created", async () => {
    await withResources(async (arranged) => {
      const created = await createRepo(arranged);
      const rows = await readAuditRows(arranged, "resource.created");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor).toBe("user");
      expect(JSON.stringify(rows[0]?.payload)).toContain(created.id);
    });
  });
});

describe("resource.query and resource.read", () => {
  it("filters by kind and by project, and reads one resource with all its fields", async () => {
    await withResources(async (arranged) => {
      const hercule = await createProject(arranged, "Hercule");
      const web = await createRepo(arranged, {
        remote: "https://github.com/acme/web",
        projectIds: [hercule],
        setupCommand: "pnpm install",
        workspaceInclude: true,
      });
      const api = await createRepo(arranged, { remote: "https://github.com/acme/api" });
      const notes = await parseCreatedResource(
        await createResource(arranged, { kind: "folder", label: "Notes" }),
      );

      expect((await queryResources(arranged, "?kind=repo")).map((one) => one.id).sort()).toEqual(
        [web.id, api.id].sort(),
      );
      expect((await queryResources(arranged, "?kind=folder")).map((one) => one.id)).toEqual([
        notes.id,
      ]);
      expect(
        (await queryResources(arranged, `?projectId=${hercule}`)).map((one) => one.id),
      ).toEqual([web.id]);

      const read = await readResource(arranged, web.id);
      expect(read).toMatchObject({
        id: web.id,
        kind: "repo",
        canonicalRemote: "github.com/acme/web",
        setupCommand: "pnpm install",
        workspaceInclude: true,
      });
      expect(read.projectIds).toEqual([hercule]);
    });
  });
});

describe("resource.update", () => {
  it("changes the remote, canonicalizes it again, and rejects a remote another repo has", async () => {
    await withResources(async (arranged) => {
      const web = await createRepo(arranged, { remote: "https://github.com/acme/web" });
      const api = await createRepo(arranged, { remote: "https://github.com/acme/api" });

      const moved = await patchResource(arranged, api.id, {
        remote: "git@github.com:acme/API.git",
      });
      expect(moved.status, await moved.clone().text()).toBe(200);
      expect(((await moved.json()) as ResourceRecord).canonicalRemote).toBe("github.com/acme/api");

      const collides = await patchResource(arranged, api.id, {
        remote: "https://github.com/acme/web.git",
      });
      expect(await readErrorCode(collides)).toBe("conflict");
      // The rejected change left the canonical remote unchanged.
      expect((await readResource(arranged, api.id)).canonicalRemote).toBe("github.com/acme/api");
      expect((await readResource(arranged, web.id)).canonicalRemote).toBe("github.com/acme/web");
    });
  });

  it("changes the connection, the setup command, the include flag and the projects", async () => {
    await withResources(async (arranged) => {
      const hercule = await createProject(arranged, "Hercule");
      const side = await createProject(arranged, "Side");
      const github = await createConnection(arranged, "github/github", { pat: PAT });
      const web = await createRepo(arranged, { projectIds: [hercule] });

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
      // The join rows match the new list: filtering by the old project no
      // longer finds the resource, and filtering by the new one does.
      expect(read.projectIds).toEqual([side]);
      expect(await queryResources(arranged, `?projectId=${hercule}`)).toEqual([]);
      expect((await queryResources(arranged, `?projectId=${side}`)).map((one) => one.id)).toEqual([
        web.id,
      ]);
    });
  });

  it("appends an audit row for the change", async () => {
    await withResources(async (arranged) => {
      const web = await createRepo(arranged);
      await patchResource(arranged, web.id, { setupCommand: "make" });
      const rows = await readAuditRows(arranged, "resource.updated");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor).toBe("user");
    });
  });
});

describe("resource.delete", () => {
  it("deletes the row and its project joins, and appends an audit row", async () => {
    await withResources(async (arranged) => {
      const hercule = await createProject(arranged, "Hercule");
      const web = await createRepo(arranged, { projectIds: [hercule] });

      const response = await del(
        arranged.harness.base,
        `/api/v1/resources/${web.id}`,
        arranged.token,
      );
      expect([200, 204], await response.clone().text()).toContain(response.status);

      expect(await queryResources(arranged)).toEqual([]);
      expect(await queryResources(arranged, `?projectId=${hercule}`)).toEqual([]);
      const gone = await get(arranged.harness.base, `/api/v1/resources/${web.id}`, arranged.token);
      expect(await readErrorCode(gone)).toBe("not_found");

      const rows = await readAuditRows(arranged, "resource.deleted");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor).toBe("user");
    });
  });

  it("fails while a workspace uses the resource, and succeeds once that workspace is gone", async () => {
    await withResources(async (arranged) => {
      const web = await createRepo(arranged);
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
      expect(await readErrorCode(refused)).toBe("invalid_state");
      expect((await queryResources(arranged)).map((one) => one.id)).toEqual([web.id]);

      // Retiring a runner marks its workspaces lost, which is the only way a
      // primary reaches a final status.
      const retired = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/retire`,
        { body: {}, token: arranged.token },
      );
      expect(retired.status, await retired.clone().text()).toBe(200);
      await waitUntil("marked the workspace lost", async () => {
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
  it("fails while a resource uses the connection, and succeeds once none does", async () => {
    await withResources(async (arranged) => {
      const github = await createConnection(arranged, "github/github", { pat: PAT });
      const web = await createRepo(arranged, { connectionId: github });

      const refused = await del(
        arranged.harness.base,
        `/api/v1/connections/${github}`,
        arranged.token,
      );
      expect(await readErrorCode(refused)).toBe("invalid_state");
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
