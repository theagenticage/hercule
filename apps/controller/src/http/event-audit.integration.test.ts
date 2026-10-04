/**
 * Tests who may read a security entry: `event.query` and `event.read` over a
 * real socket, on a log whose rows were written by real requests.
 *
 * The `event.read` grant covers the whole log, with one exception: the
 * security kinds. These are the audit kinds of the families the built-in
 * agent profiles do not grant. They are returned only to an actor that also
 * has `event.audit`, which neither `assistant` nor `worker` has. The tests
 * check what each caller gets:
 *
 * - a worker session sees its own work in the log and none of the security
 *   entries, and reading one by id fails with not found;
 * - the user, and a profile with `event.audit`, see everything.
 */
import { describe, expect, it, vi } from "vitest";
import type { Profile } from "@hercule/contract";
import {
  spawnThreadUnder,
  readProfileNamed,
  createProfile,
  WAIT_DEADLINE_MS,
  withAgentFleet as withFleet,
  type Arranged,
} from "../sessions/testing";
import { completeSetup, get, post, send, withServer, PASSWORD, USERNAME } from "./testing";

/** Long enough to start a fleet and a session for each test. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const SECRET_OWNER = "runner/0198e4b0-0000-7000-8000-000000000001";

/** One page of the log, as the API returns it. */
interface EventPage {
  readonly items: ReadonlyArray<Record<string, unknown>>;
}

const listEvents = async (base: string, token: string, query = ""): Promise<EventPage> => {
  const response = await get(base, `/api/v1/events${query}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as EventPage;
};

const listKinds = (page: EventPage): ReadonlyArray<unknown> => page.items.map((item) => item.kind);

/** Returns the error code of an error response. */
const readErrorCode = async (response: Response): Promise<string> =>
  ((await response.json()) as { readonly error: { readonly code: string } }).error.code;

/**
 * Writes entries of both kinds through the API, as the user: a task the agent
 * profiles may read, and one security entry for each family the profiles do
 * not grant.
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

  // `secret.created`: a secret stored under a runner.
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

/** The security kinds in the log, which only an actor with `event.audit` may see. */
const SECURITY_KINDS = ["auth.login.failed", "secret.created", "user.passwordChanged"] as const;

/** Returns the id of one security entry, read as the user, who may see it. */
const readSecurityEntryId = async (arranged: Arranged, kind: string): Promise<number> => {
  const page = await listEvents(arranged.harness.base, arranged.token, `?kind=${kind}`);
  expect(listKinds(page), kind).toEqual([kind]);
  return page.items[0]!.id as number;
};

describe("security entries in the event log", () => {
  it("leaves them out of a worker session's page, and keeps the rest of the log in it", async () => {
    await withFleet(async (arranged) => {
      await writeTheLog(arranged);
      const { token } = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "worker"),
      );
      const base = arranged.harness.base;

      const page = await listEvents(base, token, "?limit=500");
      for (const kind of SECURITY_KINDS) expect(listKinds(page), kind).not.toContain(kind);

      // The rest of the log is unaffected: a worker still reads the entries
      // that record its own work.
      expect(listKinds(page)).toContain("task.created");

      // Filtering by a security kind returns the same result; it is not a way
      // around the filter.
      for (const kind of SECURITY_KINDS) {
        expect((await listEvents(base, token, `?kind=${kind}`)).items, kind).toEqual([]);
      }

      // The user, on the same log, sees all of them.
      const theirs = await listEvents(base, arranged.token, "?limit=500");
      for (const kind of SECURITY_KINDS) expect(listKinds(theirs), kind).toContain(kind);
    });
  });

  it("fails a worker session's read of one with not_found, and returns the entry to the user", async () => {
    await withFleet(async (arranged) => {
      await writeTheLog(arranged);
      const { token } = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "worker"),
      );
      const base = arranged.harness.base;

      for (const kind of SECURITY_KINDS) {
        const id = await readSecurityEntryId(arranged, kind);

        const refused = await get(base, `/api/v1/events/${String(id)}`, token);
        expect(refused.status, kind).toBe(404);
        expect(await readErrorCode(refused), kind).toBe("not_found");

        const mine = await get(base, `/api/v1/events/${String(id)}`, arranged.token);
        expect(mine.status, kind).toBe(200);
        expect((await mine.json()) as Record<string, unknown>).toMatchObject({ id, kind });
      }

      // Only security kinds are hidden: the same session can read a
      // non-security entry by id.
      const created = await listEvents(base, token, "?kind=task.created");
      const id = created.items[0]!.id as number;
      const readable = await get(base, `/api/v1/events/${String(id)}`, token);
      expect(readable.status, await readable.clone().text()).toBe(200);
    });
  });

  it("returns them to a session whose profile holds event.audit", async () => {
    await withFleet(async (arranged) => {
      await writeTheLog(arranged);
      const auditor = await createProfile(arranged, "auditor", ["event.read", "event.audit"]);
      const { token } = await spawnThreadUnder(arranged, auditor);
      const base = arranged.harness.base;

      const page = await listEvents(base, token, "?limit=500");
      for (const kind of SECURITY_KINDS) expect(listKinds(page), kind).toContain(kind);

      for (const kind of SECURITY_KINDS) {
        const id = await readSecurityEntryId(arranged, kind);
        const response = await get(base, `/api/v1/events/${String(id)}`, token);
        expect(response.status, kind).toBe(200);
        expect((await response.json()) as Record<string, unknown>).toMatchObject({ id, kind });
      }
    });
  });
});

describe("event.audit as a grant a profile may hold", () => {
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
