/**
 * Tests the controller's telemetry against a stand-in OTLP collector: with
 * `telemetry.otlp_endpoint` set, the controller exports its spans as one tree
 * per request, and no span holds a secret or what the user typed (#1041).
 *
 * The run goes through every step that handles a secret an operator can see,
 * as `logs.test.ts` does: the setup token (which travels in a URL's query),
 * the bearer token setup returns, the password, the API key login creates and
 * a stored secret value. It also runs a transcript search, whose text travels
 * in the query of a GET, and sends requests that fail and carry text a client
 * chose: a path that is no id, a `User-Agent`, a bearer token the controller
 * does not know, and a wrong password. The collector's bodies are read after
 * the controller has stopped, which flushes the exporter.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  USERNAME,
  completeSetup,
  runCli,
  startController,
  type Controller,
} from "../scripts/controller-process";
import {
  createTemporaryHome,
  findReleaseBinary,
  parseJsonOutputOrFail,
  readApiKey,
  type TemporaryHome,
} from "./harness";

/** One span as OTLP/JSON encodes it, with only the fields these tests read. */
interface ExportedSpan {
  readonly name: string;
  readonly kind: number;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly attributes?: ReadonlyArray<{
    readonly key: string;
    readonly value: { readonly stringValue?: string };
  }>;
}

/** A body the controller posted to `/v1/traces`, with only the fields these tests read. */
interface ExportedTraces {
  readonly resourceSpans: ReadonlyArray<{
    readonly resource: {
      readonly attributes: ReadonlyArray<{
        readonly key: string;
        readonly value: { readonly stringValue?: string };
      }>;
    };
    readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<ExportedSpan> }>;
  }>;
}

/** OTLP's number for a server span. */
const SPAN_KIND_SERVER = 2;

/** The text the transcript search looks for: what a user typed, so it may not be exported. */
const SEARCH_TEXT = "needle-the-user-typed";

let state: TemporaryHome;
let controller: Controller | undefined;
let collector: ReturnType<typeof Bun.serve> | undefined;

/** The bodies the collector received, as text, in arrival order. */
const bodies: Array<string> = [];

/** Every secret value the run handled, by what it is, so a failure names the one that leaked. */
const secrets: Record<string, string> = {};

const binary = findReleaseBinary();

beforeAll(async () => {
  collector = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname === "/v1/traces") bodies.push(await request.text());
      return Response.json({});
    },
  });

  state = createTemporaryHome();
  controller = await startController({
    home: state.home,
    binary,
    extraArgs: ["-c", `telemetry.otlp_endpoint=http://127.0.0.1:${String(collector.port)}`],
  });
  const url = controller.url;

  // Read before setup completes, which deletes the file.
  const setupUrl = readFileSync(join(state.home, "setup-url"), "utf8").trim();
  secrets["the setup token"] = new URL(setupUrl).searchParams.get("token")!;

  const completed = await completeSetup({ home: state.home, url, binary });
  secrets["the bearer token setup returned"] = parseJsonOutputOrFail<{ token: string }>(
    completed,
  ).token;
  secrets["the password"] = PASSWORD;

  const login = await runCli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-telemetry"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  secrets["the API key"] = readApiKey(state.home);

  secrets["a stored secret value"] = "s3cret-value-that-no-span-may-hold";
  const stored = await runCli(["secret", "set", "plugin", "p1", "key1", "--value-stdin"], {
    home: state.home,
    binary,
    stdin: secrets["a stored secret value"],
  });
  expect(stored.code, `${stored.stdout}\n${stored.stderr}`).toBe(0);

  const searched = await runCli(["transcript", "list", "--text", SEARCH_TEXT], {
    home: state.home,
    binary,
  });
  expect(searched.code, `${searched.stdout}\n${searched.stderr}`).toBe(0);
  secrets["the text of a search"] = SEARCH_TEXT;

  // Requests that fail, each carrying text a client chose.
  secrets["text in a path"] = "text-in-a-path-not-an-id";
  secrets["a User-Agent"] = "user-agent-the-client-chose";
  secrets["an unknown bearer token"] = "hercule_unknown-bearer-token";
  const refused = await fetch(`${url}/api/v1/sessions/${secrets["text in a path"]}`, {
    headers: {
      authorization: `Bearer ${secrets["an unknown bearer token"]}`,
      "user-agent": secrets["a User-Agent"],
    },
  });
  expect(refused.status).toBe(401);
  secrets["a wrong password"] = "wrong-password-the-user-typed";
  const failedLogin = await fetch(`${url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: secrets["a wrong password"] }),
  });
  expect(failedLogin.status).toBe(401);

  const code = await controller.stop();
  controller = undefined;
  expect(code).toBe(0);
}, 180_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  await collector?.stop(true);
  state?.remove();
});

/** Returns every span the collector received, from every body. */
const listSpans = (): ReadonlyArray<ExportedSpan> =>
  bodies.flatMap((body) =>
    (JSON.parse(body) as ExportedTraces).resourceSpans.flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );

describe("the controller's exported spans", () => {
  it("name the controller as their service", () => {
    expect(bodies.length, "the collector received nothing").toBeGreaterThan(0);
    const services = bodies.flatMap((body) =>
      (JSON.parse(body) as ExportedTraces).resourceSpans.map(
        (resource) =>
          resource.resource.attributes.find((attribute) => attribute.key === "service.name")?.value
            .stringValue,
      ),
    );
    expect(new Set(services)).toEqual(new Set(["hercule-controller"]));
  });

  it("put an operation's span, and its SQL, under the request's server span, named for its route", () => {
    const spans = listSpans();
    const byId = new Map(spans.map((span) => [span.spanId, span]));
    const operation = spans.find((span) => span.name === "transcript.query");
    expect(operation, "no span for the transcript search").toBeDefined();
    const server = byId.get(operation!.parentSpanId ?? "");
    expect(server?.kind).toBe(SPAN_KIND_SERVER);
    // Named for its route, so a trace list tells one request from another.
    expect(server?.name).toBe("GET /api/v1/transcripts");

    const isUnder = (span: ExportedSpan, ancestor: ExportedSpan): boolean => {
      const parent = byId.get(span.parentSpanId ?? "");
      return parent !== undefined && (parent === ancestor || isUnder(parent, ancestor));
    };
    const sql = spans.filter(
      (span) =>
        isUnder(span, operation!) &&
        span.attributes?.some((attribute) => attribute.key === "db.system.name"),
    );
    expect(sql.length, "no SQL span under the transcript search").toBeGreaterThan(0);
  });

  it("hold no secret value and nothing the user typed", () => {
    const exported = bodies.join("\n");
    for (const [what, value] of Object.entries(secrets)) {
      expect(value, `${what} is empty, so the check would prove nothing`).not.toBe("");
      expect(exported.includes(value), `an exported span holds ${what}`).toBe(false);
    }
  });
});
