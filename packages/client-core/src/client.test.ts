import { assert, describe, expectTypeOf, it } from "vitest";
import { ApiError, ConnectionError, createClient, type FetchLike } from "./index";

const BASE = "http://controller.test";

/** A `fetch` that answers every call with one canned response and records it. */
const stubFetch = (respond: (request: Request) => Response) => {
  const seen: Array<Request> = [];
  const fetch: FetchLike = (url, init) => {
    const request = new Request(url, init);
    seen.push(request);
    return Promise.resolve(respond(request));
  };
  const sent = (index: number): Request => {
    const request = seen[index];
    assert.isDefined(request, `no request at index ${index}`);
    return request;
  };
  return { fetch, sent };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("createClient", () => {
  it("decodes a success round trip", async () => {
    const { fetch, sent } = stubFetch(() => json({ complete: false }));
    const client = createClient({ baseUrl: BASE, fetch });

    assert.deepStrictEqual(await client.setup.read(), { complete: false });
    assert.strictEqual(sent(0).url, `${BASE}/api/v1/setup`);
    assert.strictEqual(sent(0).method, "GET");
  });

  it("sends the bearer token only while one is held", async () => {
    const { fetch, sent } = stubFetch(() => json({}));
    const client = createClient({ baseUrl: BASE });

    // No token to start with.
    const anonymous = createClient({ baseUrl: BASE, fetch });
    await anonymous.auth.logout();
    assert.strictEqual(sent(0).headers.get("authorization"), null);

    const held = createClient({ baseUrl: BASE, token: "tok_1", fetch });
    await held.auth.logout();
    assert.strictEqual(sent(1).headers.get("authorization"), "Bearer tok_1");

    held.setToken("tok_2");
    await held.auth.logout();
    assert.strictEqual(sent(2).headers.get("authorization"), "Bearer tok_2");
    assert.strictEqual(held.getToken(), "tok_2");

    held.setToken(null);
    await held.auth.logout();
    assert.strictEqual(sent(3).headers.get("authorization"), null);

    assert.strictEqual(client.getToken(), null);
  });

  it("turns an error envelope into an ApiError", async () => {
    const { fetch } = stubFetch(() =>
      json(
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
  });
});
