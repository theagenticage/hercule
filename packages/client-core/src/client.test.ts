import { assert, describe, expectTypeOf, it } from "vitest";
import { ApiError, ConnectionError, RequestError, createClient, type FetchLike } from "./index";

const BASE = "http://controller.test";

/** A `fetch` that answers every call with one canned response and records it. */
const stubFetch = (respond: (request: Request) => Response) => {
  const seen: Array<Request> = [];
  const fetch: FetchLike = (url, init) => {
    const request = new Request(url, init);
    seen.push(request);
    return Promise.resolve(respond(request));
  };
  const readSentRequest = (index: number): Request => {
    const request = seen[index];
    assert.isDefined(request, `no request at index ${index}`);
    return request;
  };
  return { fetch, sent: readSentRequest, seen };
};

const buildJsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createClient", () => {
  it("decodes a success round trip", async () => {
    const { fetch, sent } = stubFetch(() => buildJsonResponse({ complete: false }));
    const client = createClient({ baseUrl: BASE, fetch });

    assert.deepStrictEqual(await client.setup.read(), { complete: false });
    assert.strictEqual(sent(0).url, `${BASE}/api/v1/setup`);
    assert.strictEqual(sent(0).method, "GET");
  });

  it("sends the bearer token only while one is held", async () => {
    const { fetch, sent } = stubFetch(() => buildJsonResponse({ complete: false }));
    const client = createClient({ baseUrl: BASE });

    // No token to start with.
    const anonymous = createClient({ baseUrl: BASE, fetch });
    await anonymous.setup.read();
    assert.strictEqual(sent(0).headers.get("authorization"), null);

    const held = createClient({ baseUrl: BASE, token: "tok_1", fetch });
    await held.setup.read();
    assert.strictEqual(sent(1).headers.get("authorization"), "Bearer tok_1");

    held.setToken("tok_2");
    await held.setup.read();
    assert.strictEqual(sent(2).headers.get("authorization"), "Bearer tok_2");
    assert.strictEqual(held.getToken(), "tok_2");

    held.setToken(null);
    await held.setup.read();
    assert.strictEqual(sent(3).headers.get("authorization"), null);

    assert.strictEqual(client.getToken(), null);
  });

  it("turns an error envelope into an ApiError", async () => {
    const { fetch } = stubFetch(() =>
      buildJsonResponse(
        {
          error: {
            code: "forbidden",
            message: "missing grant secret.write",
            details: { grant: "secret.write" },
          },
        },
        403,
      ),
    );
    const client = createClient({ baseUrl: BASE, token: "tok", fetch });

    const error = await client.secret
      .delete({ params: { ownerKind: "runner", ownerId: "r1", name: "ssh" } })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    assert.instanceOf(error, ApiError);
    assert.strictEqual(error.code, "forbidden");
    assert.strictEqual(error.status, 403);
    assert.strictEqual(error.message, "missing grant secret.write");
    assert.deepStrictEqual(error.details, { grant: "secret.write" });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(error)), {
      error: {
        code: "forbidden",
        message: "missing grant secret.write",
        details: { grant: "secret.write" },
      },
    });
  });

  it("turns a refused connection into a ConnectionError", async () => {
    const refused = new Error("connect ECONNREFUSED 127.0.0.1:7717");
    const client = createClient({
      baseUrl: BASE,
      fetch: () => Promise.reject(refused),
    });

    const error = await client.setup.read().then(
      () => undefined,
      (e: unknown) => e,
    );

    assert.instanceOf(error, ConnectionError);
    assert.strictEqual(error.message, `cannot reach ${BASE}`);
    assert.strictEqual(error.url, BASE);
  });

  it("turns a response it cannot decode into an internal ApiError", async () => {
    const { fetch } = stubFetch(() => new Response("<html>502</html>", { status: 502 }));
    const client = createClient({ baseUrl: BASE, fetch });

    const error = await client.setup.read().then(
      () => undefined,
      (e: unknown) => e,
    );

    assert.instanceOf(error, ApiError);
    assert.strictEqual(error.code, "internal");
  });

  it("turns a request it cannot encode into a RequestError, having sent nothing", async () => {
    const { fetch, seen } = stubFetch(() => buildJsonResponse({}));
    const client = createClient({ baseUrl: BASE, fetch });

    const error = await client.task
      .create({
        payload: {
          title: "a task",
          description: "",
          provenance: [{ note: "names nothing" }],
        } as never,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    assert.instanceOf(error, RequestError);
    assert.deepStrictEqual(error.issues, [
      {
        path: ["provenance", "0"],
        message: "A provenance entry names at least one of ref, eventId and runId.",
      },
    ]);
    assert.strictEqual(seen.length, 0);
  });

  it("exposes promises and plain types, never Effect ones", () => {
    const client = createClient({ baseUrl: BASE });

    expectTypeOf(client.setup.read).toEqualTypeOf<() => Promise<{ readonly complete: boolean }>>();
    expectTypeOf(client.auth.login).parameter(0).toEqualTypeOf<{
      readonly payload: { readonly username: string; readonly password: string };
    }>();
    expectTypeOf(client.auth.login).returns.toEqualTypeOf<
      Promise<{ readonly token: string; readonly expiresAt: string }>
    >();
    expectTypeOf(client.profile.read).parameter(0).toEqualTypeOf<{
      readonly params: { readonly id: string };
    }>();
    expectTypeOf(client.setToken).toEqualTypeOf<(token: string | null) => void>();
    expectTypeOf(client.presentToken).toEqualTypeOf<(token: string | null) => void>();
  });

  it("reaches every plugin operation on the route the contract names", async () => {
    // The listing answers an array and every other plugin call answers one
    // plugin, so the stub tells them apart by the route it was called on.
    const detail = {
      id: "claude-code",
      displayName: "Claude Code",
      hostApi: 1,
      capabilities: ["providers"],
      enabled: true,
      status: { _tag: "active" },
      config: {},
      contributions: [],
    };
    const { fetch, sent } = stubFetch((request) =>
      buildJsonResponse(request.url.endsWith("/api/v1/plugins") ? [detail] : detail),
    );
    const client = createClient({ baseUrl: BASE, fetch });
    const params = { id: "claude-code" };

    await client.plugin.query();
    await client.plugin.read({ params });
    await client.plugin.enable({ params });
    await client.plugin.disable({ params });
    await client.plugin.retry({ params });
    await client.plugin.resetState({ params });
    await client.plugin.configure({ params, payload: { config: { model: "sonnet" } } });

    const calls = [0, 1, 2, 3, 4, 5, 6].map((index) => {
      const request = sent(index);
      return `${request.method} ${request.url.slice(BASE.length)}`;
    });
    assert.deepStrictEqual(calls, [
      "GET /api/v1/plugins",
      "GET /api/v1/plugins/claude-code",
      "POST /api/v1/plugins/claude-code/enable",
      "POST /api/v1/plugins/claude-code/disable",
      "POST /api/v1/plugins/claude-code/retry",
      "POST /api/v1/plugins/claude-code/reset-state",
      "PUT /api/v1/plugins/claude-code/config",
    ]);
    assert.deepStrictEqual(await sent(6).json(), { config: { model: "sonnet" } });
  });

  it("sends several statuses as repeated query keys", async () => {
    const { fetch, sent } = stubFetch(() => buildJsonResponse({ items: [] }));
    const client = createClient({ baseUrl: BASE, fetch });

    await client.session.query({ query: { status: ["queued", "starting", "idle", "busy"] } });

    const url = new URL(sent(0).url);
    assert.deepStrictEqual(url.searchParams.getAll("status"), [
      "queued",
      "starting",
      "idle",
      "busy",
    ]);

    // One status still travels bare, which is what every other caller sends.
    await client.session.query({ query: { status: "exited" } });
    assert.deepStrictEqual(new URL(sent(1).url).searchParams.getAll("status"), ["exited"]);
  });
});

/** A token store over a plain variable, so a test can read what it kept. */
const createFakeStore = (initial: string | null = null) => {
  let held = initial;
  return {
    read: () => held,
    write: (token: string | null) => {
      held = token;
    },
    get held() {
      return held;
    },
  };
};

const PROFILE = { params: { id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" } };

describe("createClient with a token store", () => {
  it("starts with the token the store holds", async () => {
    const { fetch, sent } = stubFetch(() => buildJsonResponse({}));
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: createFakeStore("tok_kept") });

    await client.auth.logout();
    assert.strictEqual(sent(0).headers.get("authorization"), "Bearer tok_kept");
  });

  it("prefers an explicit token over the stored one, and keeps it", () => {
    const store = createFakeStore("tok_kept");
    const client = createClient({ baseUrl: BASE, token: "tok_given", tokenStore: store });

    assert.strictEqual(client.getToken(), "tok_given");
    assert.strictEqual(store.held, "tok_given");
  });

  it("writes through what setToken is given", () => {
    const store = createFakeStore();
    const client = createClient({ baseUrl: BASE, tokenStore: store });

    client.setToken("tok_1");
    assert.strictEqual(store.held, "tok_1");

    client.setToken(null);
    assert.strictEqual(store.held, null);
  });

  it("sends a presented token without writing it", async () => {
    const store = createFakeStore();
    const { fetch, sent } = stubFetch(() => buildJsonResponse({ complete: false }));
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: store });

    client.presentToken("tok_one_time");
    assert.strictEqual(store.held, null);

    await client.setup.read();
    assert.strictEqual(sent(0).headers.get("authorization"), "Bearer tok_one_time");
    assert.strictEqual(store.held, null);
  });

  it("keeps the token setup.complete hands back", async () => {
    const store = createFakeStore();
    const { fetch } = stubFetch(() => buildJsonResponse({ token: "tok_setup" }));
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: store });

    await client.setup.complete({
      payload: { username: "rogier", password: "correct horse battery staple", timezone: "UTC" },
    });

    assert.strictEqual(store.held, "tok_setup");
    assert.strictEqual(client.getToken(), "tok_setup");
  });

  it("keeps the token auth.login hands back", async () => {
    const store = createFakeStore();
    const { fetch } = stubFetch(() =>
      buildJsonResponse({ token: "tok_login", expiresAt: "2026-10-07T07:14:00.000Z" }),
    );
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: store });

    await client.auth.login({ payload: { username: "rogier", password: "hunter2hunter2" } });

    assert.strictEqual(store.held, "tok_login");
  });

  it("clears the token on logout", async () => {
    const store = createFakeStore("tok_kept");
    const { fetch } = stubFetch(() => buildJsonResponse({}));
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: store });

    await client.auth.logout();

    assert.strictEqual(store.held, null);
    assert.strictEqual(client.getToken(), null);
  });

  it("clears the token on an unauthenticated answer, and still surfaces it", async () => {
    const store = createFakeStore("tok_stale");
    const { fetch } = stubFetch(() =>
      buildJsonResponse({ error: { code: "unauthenticated", message: "token expired" } }, 401),
    );
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: store });

    const error = await client.profile.read(PROFILE).then(
      () => undefined,
      (e: unknown) => e,
    );

    assert.instanceOf(error, ApiError);
    assert.strictEqual(error.code, "unauthenticated");
    assert.strictEqual(store.held, null);
    assert.strictEqual(client.getToken(), null);
  });

  it("keeps the token on any other failure", async () => {
    const store = createFakeStore("tok_kept");
    const { fetch } = stubFetch(() =>
      buildJsonResponse(
        {
          error: {
            code: "forbidden",
            message: "missing grant profile.read",
            details: { grant: "profile.read" },
          },
        },
        403,
      ),
    );
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: store });

    await client.profile.read(PROFILE).then(
      () => undefined,
      () => undefined,
    );

    assert.strictEqual(store.held, "tok_kept");
    assert.strictEqual(client.getToken(), "tok_kept");
  });
});
