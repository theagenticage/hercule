import { api } from "@hercule/contract";
import { Effect } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import { assert, describe, expectTypeOf, it, vi } from "vitest";
import type { RequiredClientMiddleware } from "./client";
import { ApiError, ConnectionError, RequestError, createClient, type FetchLike } from "./index";

// Wraps the real `HttpApiClient.endpoint` in a spy, so a test can see which
// operations the client builds. Every call still reaches the real function.
vi.mock("effect/unstable/httpapi/HttpApiClient", async (importOriginal) => {
  const actual = await importOriginal<typeof HttpApiClient>();
  return { ...actual, endpoint: vi.fn(actual.endpoint) };
});

const BASE = "http://controller.test";

/** Returns a `fetch` that responds to every call with one canned response and records the call. */
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

  it("sends the bearer token only while one is set", async () => {
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

  it("sends no header beyond the bearer token and the body's content type", async () => {
    // The controller's CORS preflight allows only these two request headers.
    // Any other header a page may not send freely, such as a tracing header,
    // would make the browser refuse every request from the desktop app.
    const { fetch, sent } = stubFetch((request) =>
      buildJsonResponse(
        request.url.endsWith("/api/v1/setup")
          ? { complete: true }
          : { token: "tok_2", expiresAt: "2026-10-07T07:14:00.000Z" },
      ),
    );
    const client = createClient({ baseUrl: BASE, token: "tok_1", fetch });

    await client.auth.login({ payload: { username: "rogier", password: "hunter2hunter2" } });
    await client.setup.read();

    assert.deepStrictEqual([...sent(0).headers.keys()], ["authorization", "content-type"]);
    assert.deepStrictEqual([...sent(1).headers.keys()], ["authorization"]);
  });

  it("builds an operation on its first call only, and no operation before that", async () => {
    const build = vi.mocked(HttpApiClient.endpoint);
    build.mockClear();
    const { fetch } = stubFetch(() => buildJsonResponse({ complete: false }));
    const client = createClient({ baseUrl: BASE, fetch });
    assert.strictEqual(build.mock.calls.length, 0);

    await client.setup.read();
    await client.setup.read();

    assert.deepStrictEqual(
      build.mock.calls.map(([, options]) => [options.group, options.endpoint]),
      [["setup", "read"]],
    );
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

  it("turns a failed connection into a ConnectionError", async () => {
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

  it.each([
    ["a time limit aborts the request", new DOMException("too slow", "TimeoutError")],
    ["the request is aborted", new DOMException("aborted", "AbortError")],
    ["the network fails", new TypeError("terminated")],
  ])("turns a body cut off because %s into a ConnectionError", async (_, cause) => {
    // The status and headers arrive, then reading the body fails with
    // `cause`, which is how fetch fails a body read in each of these cases.
    const body = new ReadableStream({
      start: (controller) => controller.error(cause),
    });
    const { fetch } = stubFetch(
      () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const client = createClient({ baseUrl: BASE, fetch });

    const error = await client.setup.read().then(
      () => undefined,
      (e: unknown) => e,
    );

    assert.instanceOf(error, ConnectionError);
    assert.strictEqual(error.url, BASE);
  });

  it("turns a malformed body into an internal ApiError", async () => {
    const { fetch } = stubFetch(
      () =>
        new Response('{"complete":', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createClient({ baseUrl: BASE, fetch });

    const error = await client.setup.read().then(
      () => undefined,
      (e: unknown) => e,
    );

    assert.instanceOf(error, ApiError);
    assert.strictEqual(error.code, "internal");
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
        message: "A provenance entry must include at least one of ref, eventId and runId.",
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

  it("refuses to compile a build of an operation that requires client-side middleware", () => {
    // An API with one operation, whose middleware requires a client-side part.
    class NeedsClientPart extends HttpApiMiddleware.Service<NeedsClientPart>()(
      "test/NeedsClientPart",
      { requiredForClient: true },
    ) {}
    const needsClientPart = HttpApi.make("test").add(
      HttpApiGroup.make("test")
        .add(HttpApiEndpoint.get("read", "/read"))
        .middleware(NeedsClientPart),
    );
    const httpClient = Effect.runSync(Effect.provide(HttpClient.HttpClient, FetchHttpClient.layer));

    // Built and typed the way `createClient` builds each operation.
    const build = HttpApiClient.endpoint(needsClientPart, {
      group: "test" as never,
      endpoint: "read" as never,
      httpClient,
    }) as Effect.Effect<unknown, never, RequiredClientMiddleware<typeof needsClientPart>>;

    // @ts-expect-error Nothing provides the client-side part the middleware requires.
    Effect.runSync(build);
    expectTypeOf<RequiredClientMiddleware<typeof api>>().toBeNever();
  });

  it("calls every plugin operation on the route the contract defines", async () => {
    // The list operation returns an array and every other plugin operation
    // returns one plugin, so the stub picks its response by route.
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

    // A single status is still sent as a plain value, as every other caller sends it.
    await client.session.query({ query: { status: "exited" } });
    assert.deepStrictEqual(new URL(sent(1).url).searchParams.getAll("status"), ["exited"]);
  });

  const IMAGE = {
    id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    name: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 4,
  };

  it("uploads an image as raw bytes, named in the query", async () => {
    const { fetch, sent } = stubFetch(() => buildJsonResponse(IMAGE, 201));
    const client = createClient({ baseUrl: BASE, token: "tok_1", fetch });
    const file = Object.assign(new Blob([new Uint8Array([137, 80, 78, 71])]), {
      name: "screenshot.png",
    });

    assert.deepStrictEqual(await client.uploadAttachment(file), IMAGE);
    const request = sent(0);
    assert.strictEqual(request.method, "POST");
    assert.strictEqual(new URL(request.url).pathname, "/api/v1/attachments");
    assert.strictEqual(new URL(request.url).searchParams.get("name"), "screenshot.png");
    assert.strictEqual(request.headers.get("content-type"), "application/octet-stream");
    assert.strictEqual(request.headers.get("authorization"), "Bearer tok_1");
    assert.deepStrictEqual([...new Uint8Array(await request.arrayBuffer())], [137, 80, 78, 71]);
  });

  it("reads an image as a Blob of its type, with the token in a header and never in the URL", async () => {
    const { fetch, sent } = stubFetch(
      () =>
        new Response(new Uint8Array([71, 73, 70, 56]), {
          headers: { "content-type": "image/gif" },
        }),
    );
    const client = createClient({ baseUrl: BASE, token: "tok_1", fetch });

    const blob = await client.readAttachmentContent(IMAGE.id);
    assert.strictEqual(blob.type, "image/gif");
    assert.deepStrictEqual([...new Uint8Array(await blob.arrayBuffer())], [71, 73, 70, 56]);
    assert.strictEqual(new URL(sent(0).url).pathname, `/api/v1/attachments/${IMAGE.id}/content`);
    assert.notInclude(sent(0).url, "tok_1");
    assert.strictEqual(sent(0).headers.get("authorization"), "Bearer tok_1");
  });

  it("turns a failed image read into an ApiError like any other call", async () => {
    const { fetch } = stubFetch(() =>
      buildJsonResponse({ error: { code: "not_found", message: "No such attachment." } }, 404),
    );
    const client = createClient({ baseUrl: BASE, fetch });

    const error: unknown = await client.readAttachmentContent(IMAGE.id).catch((e: unknown) => e);
    assert.instanceOf(error, ApiError);
    assert.strictEqual(error.code, "not_found");
  });
});

/** A token store backed by a plain variable, so a test can read what it stored. */
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

/**
 * Returns a `fetch` that holds back the response to requests for `path` until
 * the test calls `release`, and answers every other request with `respond` at
 * once. A test uses it to finish one request after a later one.
 */
const holdResponseTo = (path: string, respond: (request: Request) => Response) => {
  const seen: Array<Request> = [];
  let release: (response: Response) => void = () => undefined;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetch: FetchLike = (url, init) => {
    const request = new Request(url, init);
    seen.push(request);
    return new URL(request.url).pathname.startsWith(path)
      ? held
      : Promise.resolve(respond(request));
  };
  return { fetch, seen, release };
};

/** Returns the first request in `seen` sent to `path`, and fails the test when there is none. */
const findRequestTo = (seen: ReadonlyArray<Request>, path: string): Request => {
  const request = seen.find((candidate) => new URL(candidate.url).pathname.startsWith(path));
  assert.isDefined(request, `no request to ${path}`);
  return request;
};

const PROFILE = { params: { id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" } };

describe("createClient with a token store", () => {
  it("starts with the stored token", async () => {
    const { fetch, sent } = stubFetch(() => buildJsonResponse({}));
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: createFakeStore("tok_kept") });

    await client.auth.logout();
    assert.strictEqual(sent(0).headers.get("authorization"), "Bearer tok_kept");
  });

  it("prefers an explicit token over the stored one, and stores it", () => {
    const store = createFakeStore("tok_kept");
    const client = createClient({ baseUrl: BASE, token: "tok_given", tokenStore: store });

    assert.strictEqual(client.getToken(), "tok_given");
    assert.strictEqual(store.held, "tok_given");
  });

  it("stores the token passed to setToken", () => {
    const store = createFakeStore();
    const client = createClient({ baseUrl: BASE, tokenStore: store });

    client.setToken("tok_1");
    assert.strictEqual(store.held, "tok_1");

    client.setToken(null);
    assert.strictEqual(store.held, null);
  });

  it("sends a presented token without storing it", async () => {
    const store = createFakeStore();
    const { fetch, sent } = stubFetch(() => buildJsonResponse({ complete: false }));
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: store });

    client.presentToken("tok_one_time");
    assert.strictEqual(store.held, null);

    await client.setup.read();
    assert.strictEqual(sent(0).headers.get("authorization"), "Bearer tok_one_time");
    assert.strictEqual(store.held, null);
  });

  it("stores the token setup.complete returns", async () => {
    const store = createFakeStore();
    const { fetch } = stubFetch(() => buildJsonResponse({ token: "tok_setup" }));
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: store });

    await client.setup.complete({
      payload: { username: "rogier", password: "correct horse battery staple", timezone: "UTC" },
    });

    assert.strictEqual(store.held, "tok_setup");
    assert.strictEqual(client.getToken(), "tok_setup");
  });

  it("stores the token auth.login returns", async () => {
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

  it("clears the token on an unauthenticated error, and still throws the error", async () => {
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

  it("keeps a newer token when an older request later fails as unauthenticated", async () => {
    const store = createFakeStore("tok_old");
    const { fetch, seen, release } = holdResponseTo("/api/v1/profiles", () =>
      buildJsonResponse({ token: "tok_new", expiresAt: "2026-10-07T07:14:00.000Z" }),
    );
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: store });

    const late = client.profile.read(PROFILE).then(
      () => undefined,
      (e: unknown) => e,
    );
    await client.auth.login({ payload: { username: "rogier", password: "hunter2hunter2" } });
    release(
      buildJsonResponse({ error: { code: "unauthenticated", message: "token expired" } }, 401),
    );

    const error = await late;
    assert.instanceOf(error, ApiError);
    assert.strictEqual(error.code, "unauthenticated");
    assert.strictEqual(
      findRequestTo(seen, "/api/v1/profiles").headers.get("authorization"),
      "Bearer tok_old",
    );
    assert.strictEqual(client.getToken(), "tok_new");
    assert.strictEqual(store.held, "tok_new");
  });

  it("keeps a newer token when an older logout finishes after a login", async () => {
    const store = createFakeStore("tok_old");
    const { fetch, seen, release } = holdResponseTo("/api/v1/auth/logout", () =>
      buildJsonResponse({ token: "tok_new", expiresAt: "2026-10-07T07:14:00.000Z" }),
    );
    const client = createClient({ baseUrl: BASE, fetch, tokenStore: store });

    const late = client.auth.logout();
    await client.auth.login({ payload: { username: "rogier", password: "hunter2hunter2" } });
    release(buildJsonResponse({}));
    await late;

    assert.strictEqual(
      findRequestTo(seen, "/api/v1/auth/logout").headers.get("authorization"),
      "Bearer tok_old",
    );
    assert.strictEqual(client.getToken(), "tok_new");
    assert.strictEqual(store.held, "tok_new");
  });
});
