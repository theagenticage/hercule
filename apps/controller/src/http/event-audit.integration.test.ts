/**
 * Who may read a security entry: `event.query` and `event.read` over a real
 * socket, against a log whose rows were written by real requests.
 *
 * The log holds two populations behind one `event.read` grant. The security
 * kinds - the audit kinds of the families the shipped agent profiles withhold -
 * are the exception: they are returned only to an actor that also holds
 * `event.audit`, which neither `assistant` nor `worker` has. What is asserted
 * here is what each caller gets back: the worker session sees its own work in
 * the log and none of the security entries, and asking for one by id is told
 * there is no such entry; the user and a profile holding `event.audit` see
 * everything.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionStart } from "@hydra/protocol";
import type { Profile, Session } from "@hydra/contract";
import { fixture, providerDefinition } from "../plugins/testing";
import {
  framesOf,
  report,
  spawned,
  until,
  WAIT_DEADLINE_MS,
  withFleet as sharedWithFleet,
  type Arranged,
} from "../sessions/testing";
import { completeSetup, get, post, send, withServer, PASSWORD, USERNAME } from "./testing";

/** The fleet is stood up before every case, and a session started on it. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const PROVIDER = providerDefinition("full-provider", { token: "t" });

const FACTS = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [],
  providers: [{ name: "harness", present: true, path: "/usr/local/bin/harness" }],
  adapters: ["full-provider"],
  identityPort: 4939,
} as const;

const MODELS = [{ slug: "fast", name: "Fast", isDefault: true, options: [] }];

const withFleet = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  sharedWithFleet(body, {
    plugins: [fixture({ id: "providers", definitions: [PROVIDER] }).plugin],
    facts: FACTS,
    models: MODELS,
  });

const at = "2026-09-07T10:00:00.000Z";

const SECRET_OWNER = "connection/0198e4b0-0000-7000-8000-000000000001";

/** One page of the log, as the wire hands it back. */
interface EventPage {
  readonly items: ReadonlyArray<Record<string, unknown>>;
}

const events = async (base: string, token: string, query = ""): Promise<EventPage> => {
  const response = await get(base, `/api/v1/events${query}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as EventPage;
};

const kinds = (page: EventPage): ReadonlyArray<unknown> => page.items.map((item) => item.kind);

/** The error code a refusal names. */
const codeOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { readonly error: { readonly code: string } }).error.code;

const profileNamed = async (arranged: Arranged, name: string): Promise<Profile> => {
  const response = await get(arranged.harness.base, "/api/v1/profiles", arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  const items = ((await response.json()) as { items: ReadonlyArray<Profile> }).items;
  const found = items.find((one) => one.name === name);
  expect(found, name).toBeDefined();
  return found!;
};

/** A profile of this test's own making, for a grant set no shipped one has. */
const profileOf = async (
  arranged: Arranged,
  name: string,
  grants: ReadonlyArray<string>,
): Promise<Profile> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/profiles",
    { name, grants },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Profile;
};

/** The start frames the controller has sent for one session, once there are this many. */
const startFrames = (
  arranged: Arranged,
  sessionId: string,
  count: number,
): Promise<ReadonlyArray<SessionStart>> =>
  until(`sent ${String(count)} start frames for the session`, () => {
    const found = framesOf<SessionStart>(arranged.wire, "sessionStart").filter(
      (frame) => frame.sessionId === sessionId,
    );
    return found.length >= count ? found : undefined;
  });

const readSession = async (arranged: Arranged, id: string): Promise<Session> => {
  const response = await get(arranged.harness.base, `/api/v1/sessions/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

/** A session on a named profile, started, with the token its machine was handed. */
const agentOn = async (arranged: Arranged, profile: Profile): Promise<string> => {
  const opened = await spawned(arranged, { prompt: "hello", permissionProfileId: profile.id });
  const frame = (await startFrames(arranged, opened.id, 1))[0]!;
  const token: unknown = frame.token;
  expect(typeof token === "string" && token !== "", "the start frame carries a token").toBe(true);
  report(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: opened.id,
    at,
    _tag: "session.started",
    providerRefs: { nativeSessionId: "native-1" },
  });
  await until("started the session", async () =>
    (await readSession(arranged, opened.id)).status === "idle" ? true : undefined,
  );
  return frame.token;
};

/**
 * Writes one row of each population through the API, as the user: a task the
 * agent profiles may read, and one security entry per family the profiles
 * withhold.
 */
const writeTheLog = async (arranged: Arranged): Promise<void> => {
  const base = arranged.harness.base;

  const task = await post(
    base,
    "/api/v1/tasks",
    { title: "a task the log should hold", description: "" },
    arranged.token,
  );
  expect(task.status, await task.clone().text()).toBe(200);

  // `auth.login.failed`: a login that cannot succeed.
  const login = await send("POST", base, "/api/v1/auth/login", {
    body: { username: USERNAME, password: "not the password" },
  });
  expect(login.status).toBe(401);

  // `secret.created`: a secret stored under a connection.
  const secret = await send("PUT", base, `/api/v1/secrets/${SECRET_OWNER}/api-token`, {
    body: { value: "ghp_a-real-looking-token" },
    token: arranged.token,
  });
  expect(secret.status, await secret.clone().text()).toBe(200);

  // `user.passwordChanged`: the user's own credential, changed.
  const password = await post(
    base,
    "/api/v1/user/password",
    { current: PASSWORD, next: "a different correct horse" },
    arranged.token,
  );
  expect(password.status, await password.clone().text()).toBe(200);
};

/** The kinds the log holds that no actor without `event.audit` may see. */
const SECURITY_KINDS = ["auth.login.failed", "secret.created", "user.passwordChanged"] as const;

/** One security entry's id, read by the user, who may see it. */
const securityEntryId = async (arranged: Arranged, kind: string): Promise<number> => {
  const page = await events(arranged.harness.base, arranged.token, `?kind=${kind}`);
  expect(kinds(page), kind).toEqual([kind]);
  return page.items[0]!.id as number;
};

describe("AC-6: security entries in the event log", () => {
  it("keeps them off a worker session's page, and leaves the rest of the log on it", async () => {
    await withFleet(async (arranged) => {
      await writeTheLog(arranged);
      const token = await agentOn(arranged, await profileNamed(arranged, "worker"));
      const base = arranged.harness.base;

      const page = await events(base, token, "?limit=500");
      for (const kind of SECURITY_KINDS) expect(kinds(page), kind).not.toContain(kind);

      // The rest of the log is untouched: a worker still reads the entries its
      // own work is recorded in.
      expect(kinds(page)).toContain("task.created");

      // Asking for a security kind by name is the same answer, not a way round
      // the filter.
      for (const kind of SECURITY_KINDS) {
        expect((await events(base, token, `?kind=${kind}`)).items, kind).toEqual([]);
      }

      // And the user, on the same log, sees every one of them.
      const theirs = await events(base, arranged.token, "?limit=500");
      for (const kind of SECURITY_KINDS) expect(kinds(theirs), kind).toContain(kind);
    });
  });

  it("answers a worker session's read of one with a not-found, and the user's with the entry", async () => {
    await withFleet(async (arranged) => {
      await writeTheLog(arranged);
      const token = await agentOn(arranged, await profileNamed(arranged, "worker"));
      const base = arranged.harness.base;

      for (const kind of SECURITY_KINDS) {
        const id = await securityEntryId(arranged, kind);

        const refused = await get(base, `/api/v1/events/${String(id)}`, token);
        expect(refused.status, kind).toBe(404);
        expect(await codeOf(refused), kind).toBe("not_found");

        const mine = await get(base, `/api/v1/events/${String(id)}`, arranged.token);
        expect(mine.status, kind).toBe(200);
        expect((await mine.json()) as Record<string, unknown>).toMatchObject({ id, kind });
      }

      // What is withheld is the security kind and nothing else: the same
      // session reads a non-security entry by id.
      const created = await events(base, token, "?kind=task.created");
      const id = created.items[0]!.id as number;
      const readable = await get(base, `/api/v1/events/${String(id)}`, token);
      expect(readable.status, await readable.clone().text()).toBe(200);
    });
  });

  it("returns them to a session whose profile holds event.audit", async () => {
    await withFleet(async (arranged) => {
      await writeTheLog(arranged);
      const auditor = await profileOf(arranged, "auditor", ["event.read", "event.audit"]);
      const token = await agentOn(arranged, auditor);
      const base = arranged.harness.base;

      const page = await events(base, token, "?limit=500");
      for (const kind of SECURITY_KINDS) expect(kinds(page), kind).toContain(kind);

      for (const kind of SECURITY_KINDS) {
        const id = await securityEntryId(arranged, kind);
        const response = await get(base, `/api/v1/events/${String(id)}`, token);
        expect(response.status, kind).toBe(200);
        expect((await response.json()) as Record<string, unknown>).toMatchObject({ id, kind });
      }
    });
  });
});

describe("AC-6: event.audit as a grant a profile may hold", () => {
  it("is accepted by profile.create and comes back on the profile", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const response = await post(
        base,
        "/api/v1/profiles",
        { name: "auditor", grants: ["event.audit"] },
        token,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      expect((await response.json()) as Profile).toMatchObject({
        name: "auditor",
        grants: ["event.audit"],
      });
    });
  });
});
