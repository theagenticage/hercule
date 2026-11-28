/**
 * Tests the commands that add an MCP server by its address and give it a
 * token, through the release binary: `hercule mcp-server create --url`,
 * `--token-stdin`, `read` and `set-token`.
 *
 * The commands are derived from the contract's CLI table, and the checks of a
 * server run in the controller, so the only way to know that a user can add a
 * server from a shell is to run what a release ships: `pnpm build:binary`
 * first, then `pnpm test:binary`.
 *
 * The servers the controller reaches are small MCP servers started in this
 * process, on the loopback address. They speak the 2025-11-25 revision with
 * plain JSON answers and refuse `server/discover`, which is how an older
 * server answers the newest handshake.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  completeSetup,
  runCli,
  startController,
  type Controller,
} from "../scripts/controller-process";
import { createTemporaryHome, parseJsonOutput, type TemporaryHome } from "./harness";

const binary = join(ROOT, "hercule");

let state: TemporaryHome;
let controller: Controller;

/** What `hercule mcp-server read --json` prints, as far as these tests look. */
interface McpServerRecord {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly tools: ReadonlyArray<{ readonly name: string }>;
}

/** A fake MCP server in this process, and what it saw. */
interface FakeMcpServer {
  readonly url: string;
  /** The `Authorization` header and JSON-RPC method of every request, in order. */
  readonly requests: Array<{ readonly authorization: string | null; readonly method: string }>;
  readonly stop: () => void;
}

/**
 * Starts an MCP server that lists one tool, `echo`, and answers a call of it
 * with its arguments. It lets a request in when `acceptedToken` is unset or
 * the request carries it as a bearer token. Any other request gets HTTP 401.
 */
const startFakeMcpServer = (acceptedToken?: string): FakeMcpServer => {
  const requests: FakeMcpServer["requests"] = [];
  const answer = (id: unknown, result: unknown, headers: Record<string, string> = {}) =>
    Response.json({ jsonrpc: "2.0", id, result }, { headers });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const authorization = request.headers.get("authorization");
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = (await request.json()) as {
        readonly id?: unknown;
        readonly method: string;
        readonly params?: { readonly protocolVersion?: string; readonly arguments?: unknown };
      };
      requests.push({ authorization, method: body.method });
      if (acceptedToken !== undefined && authorization !== `Bearer ${acceptedToken}`) {
        return new Response("unauthorized", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      switch (body.method) {
        case "initialize":
          return answer(
            body.id,
            {
              protocolVersion: body.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fake", version: "1" },
            },
            { "mcp-session-id": "fake-session" },
          );
        case "notifications/initialized":
          return new Response(null, { status: 202 });
        case "tools/list":
          return answer(body.id, {
            tools: [
              {
                name: "echo",
                description: "Echoes its text",
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
              },
            ],
          });
        case "tools/call":
          return answer(body.id, {
            content: [{ type: "text", text: JSON.stringify(body.params?.arguments) }],
          });
        default:
          // `server/discover` lands here: an older server does not know it.
          return Response.json(
            { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: "no method" } },
            { status: 404 },
          );
      }
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}/mcp`,
    requests,
    stop: () => void server.stop(true),
  };
};

/** Runs the CLI binary with the credential file the login wrote. */
const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: state.home, binary, stdin });

/** Parses the output of a command that must have succeeded, and fails with the command's own output otherwise. */
const expectJsonOutput = <A>(ran: { code: number; stdout: string; stderr: string }): A => {
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  return parseJsonOutput(ran) as A;
};

const readServer = async (id: string): Promise<McpServerRecord> =>
  expectJsonOutput(await runLoggedInCli(["mcp-server", "read", id, "--json"]));

/** Reads the server until its status is `status`, and returns it. Fails with the last record after 30 seconds. */
const waitForStatus = async (id: string, status: string): Promise<McpServerRecord> => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const record = await readServer(id);
    if (record.status === status) return record;
    if (Date.now() > deadline) {
      throw new Error(`still not ${status} after 30 seconds: ${JSON.stringify(record)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

const fakes: Array<FakeMcpServer> = [];
const startFake = (acceptedToken?: string): FakeMcpServer => {
  const fake = startFakeMcpServer(acceptedToken);
  fakes.push(fake);
  return fake;
};

beforeAll(async () => {
  if (!existsSync(binary)) {
    throw new Error(
      `no binary at ${binary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }
  state = createTemporaryHome();
  controller = await startController({ home: state.home, binary });
  const completed = await completeSetup({ home: state.home, url: controller.url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
  const login = await runLoggedInCli(
    ["login", controller.url, "--username", USERNAME, "--password-stdin", "--name", "e2e-mcp"],
    PASSWORD,
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
}, 90_000);

afterAll(async () => {
  for (const fake of fakes) fake.stop();
  await controller?.stop().catch(() => -1);
  state?.remove();
});

describe("MCP servers added by address, through the binary", () => {
  it("adds a server with no sign-in and lists its tools", async () => {
    const fake = startFake();

    const created = expectJsonOutput<McpServerRecord>(
      await runLoggedInCli([
        "mcp-server",
        "create",
        "--url",
        fake.url,
        "--name",
        "plain",
        "--json",
      ]),
    );

    expect(created.name).toBe("plain");
    const ready = await waitForStatus(created.id, "ready");
    expect(ready.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(new Set(fake.requests.map((request) => request.authorization))).toEqual(new Set([null]));
  }, 60_000);

  it("adds a server with the token read from stdin, and sends it as a bearer token", async () => {
    const fake = startFake("tok-from-stdin-1234");

    const created = expectJsonOutput<McpServerRecord>(
      await runLoggedInCli(
        ["mcp-server", "create", "--url", fake.url, "--name", "tokened", "--token-stdin", "--json"],
        "tok-from-stdin-1234\n",
      ),
    );

    const ready = await waitForStatus(created.id, "ready");
    expect(ready.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(new Set(fake.requests.map((request) => request.authorization))).toEqual(
      new Set(["Bearer tok-from-stdin-1234"]),
    );
  }, 60_000);

  it("refuses an address that was added before", async () => {
    const fake = startFake();
    const first = expectJsonOutput<McpServerRecord>(
      await runLoggedInCli([
        "mcp-server",
        "create",
        "--url",
        fake.url,
        "--name",
        "first",
        "--json",
      ]),
    );

    const again = await runLoggedInCli([
      "mcp-server",
      "create",
      "--url",
      fake.url,
      "--name",
      "again",
      "--json",
    ]);

    expect(again.code, `${again.stdout}\n${again.stderr}`).toBe(1);
    expect(parseJsonOutput(again)).toMatchObject({
      error: {
        code: "conflict",
        message: expect.stringContaining("You added this server before, as first") as unknown,
      },
    });
    const listed = expectJsonOutput<{ items: ReadonlyArray<McpServerRecord> }>(
      await runLoggedInCli(["mcp-server", "list", "--json"]),
    );
    expect(listed.items.filter((server) => server.id === first.id)).toHaveLength(1);
    expect(listed.items.map((server) => server.name)).not.toContain("again");
  }, 60_000);

  it("refuses --url together with --plugin in the CLI, before anything is sent", async () => {
    const fake = startFake();

    const refused = await runLoggedInCli([
      "mcp-server",
      "create",
      "--url",
      fake.url,
      "--plugin",
      "sentry/sentry",
      "--name",
      "mixed",
    ]);

    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("cannot be given with");
    const listed = expectJsonOutput<{ items: ReadonlyArray<McpServerRecord> }>(
      await runLoggedInCli(["mcp-server", "list", "--json"]),
    );
    expect(listed.items.map((server) => server.name)).not.toContain("mixed");
    expect(fake.requests).toEqual([]);
  }, 60_000);

  it("takes a server out of needs-sign-in when set-token gives it the token it accepts", async () => {
    const fake = startFake("tok-the-new-one-5678");
    const created = expectJsonOutput<McpServerRecord>(
      await runLoggedInCli(
        ["mcp-server", "create", "--url", fake.url, "--name", "rotated", "--token-stdin", "--json"],
        "tok-the-old-one-1234\n",
      ),
    );
    await waitForStatus(created.id, "needs-sign-in");

    const set = await runLoggedInCli(
      ["mcp-server", "set-token", created.id, "--json"],
      "tok-the-new-one-5678\n",
    );

    expect(set.code, `${set.stdout}\n${set.stderr}`).toBe(0);
    const ready = await waitForStatus(created.id, "ready");
    expect(ready.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(fake.requests.at(-1)?.authorization).toBe("Bearer tok-the-new-one-5678");
  }, 60_000);
});
