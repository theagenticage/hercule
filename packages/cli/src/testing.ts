/**
 * Test doubles for the CLI. Imported only by `*.test.ts`.
 *
 * The CLI's whole contact with the world is `Io`, so a stub controller is a
 * function from a request to a response and a stub terminal is three arrays.
 * No server is started anywhere in this package's tests.
 */
import type { ErrorCode } from "@hercule/contract";
import type { FetchLike } from "@hercule/client-core";
import type { Io } from "./io";

export interface StubRequest {
  readonly method: string;
  /** The path with its query string, e.g. `/api/v1/profiles?limit=2`. */
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

export type Handler = (request: StubRequest) => unknown;

/** The request body as an object, whatever shape the HTTP client handed `fetch`. */
const decodeBody = (body: unknown): unknown => {
  if (body === null || body === undefined) return undefined;
  const text =
    typeof body === "string"
      ? body
      : body instanceof Uint8Array
        ? new TextDecoder().decode(body)
        : body instanceof ArrayBuffer
          ? new TextDecoder().decode(new Uint8Array(body))
          : undefined;
  if (text === undefined || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A controller that answers with whatever the handler returns. */
export const stubFetch = (handler: Handler): FetchLike & { readonly calls: Array<StubRequest> } => {
  const calls: Array<StubRequest> = [];
  const fetch = (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    const request: StubRequest = {
      method: init?.method ?? "GET",
      path: parsed.pathname,
      query: parsed.searchParams,
      body: decodeBody(init?.body),
      authorization: headers.get("authorization") ?? undefined,
    };
    calls.push(request);
    const answer = handler(request);
    return Promise.resolve(
      answer instanceof Response
        ? answer
        : new Response(JSON.stringify(answer ?? {}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
  };
  return Object.assign(fetch, { calls });
};

/** The error envelope, at the status the code maps to. */
export const envelope = (
  code: ErrorCode,
  status: number,
  message: string,
  details?: unknown,
): Response =>
  new Response(
    JSON.stringify({ error: { code, message, ...(details === undefined ? {} : { details }) } }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );

export interface StubIo extends Io {
  readonly stdout: Array<string>;
  readonly stderr: Array<string>;
  readonly prompts: Array<string>;
}

export interface StubIoOptions {
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: string;
  readonly tty?: boolean;
  readonly password?: string;
  readonly hostname?: string;
  readonly fetch?: FetchLike;
}

export const stubIo = (options: StubIoOptions = {}): StubIo => {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const prompts: Array<string> = [];
  return {
    env: options.env ?? {},
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    stdin: () => Promise.resolve(options.stdin ?? ""),
    isTty: () => options.tty === true,
    prompt: (label) => {
      prompts.push(label);
      return Promise.resolve(options.password ?? "");
    },
    hostname: () => options.hostname ?? "test-host",
    fetch: options.fetch ?? stubFetch(() => ({})),
    stdout,
    stderr,
    prompts,
  };
};

/** A canonical UUIDv7, distinguished by its last characters. */
export const id = (tail: string): string => {
  const padded = tail.padStart(12, "0");
  return `0192f0a1-0000-7000-8000-${padded}`;
};
