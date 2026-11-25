/**
 * A memory of the lines that cross the wire, kept beside the vendored client.
 *
 * The vendored client decodes what it reads and drops what it does not know,
 * and it hands its handlers only the decoded value. A handler that must give
 * its caller the untouched message (`raw`), or must say which message failed,
 * or which reply belonged to which call, asks this memory, which saw the line
 * first.
 *
 * It imports nothing from the vendored client, so `connection.ts` passes in
 * the one thing it needs from there: how the client names a request id.
 */

type JsonObject = Readonly<Record<string, unknown>>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRequestId = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";

/** The longest harness text that `quoteHarnessText` leaves whole. */
const QUOTE_LENGTH = 200;

/** Parses `line` as JSON. Returns `undefined` when the line is not JSON. */
const parseLine = (line: string): { readonly value: unknown } | undefined => {
  try {
    return { value: JSON.parse(line) };
  } catch {
    return undefined;
  }
};

/** A request of the harness that has not been answered yet. */
export interface HarnessRequest {
  /** The JSON-RPC id the harness gave it. */
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
  /** The whole parsed line. */
  readonly message: JsonObject;
}

/** An answer with an error that was written to the harness for one of its requests. */
export interface RefusedRequest {
  readonly request: HarnessRequest;
  readonly error: unknown;
}

/** A call of ours that waits for its reply. The memory fills in `reply`. */
export interface CallTicket {
  /** The `result` of the harness's reply, exactly as it was sent. `undefined` until the reply arrives. */
  readonly reply: unknown;
}

/** A line of the harness that is not an ordinary message. */
export interface LineProblem {
  /** A sentence for a person: what the harness wrote and what that means. */
  readonly reason: string;
  /** Whether nothing the harness writes can be trusted after this line. */
  readonly endsConnection: boolean;
}

export interface WireMemory {
  /**
   * Remembers a line of the harness's output. Call it before the vendored
   * client reads the line. Returns what is wrong with the line, if anything:
   *
   * - A JSON array (a batch) or a request whose id is still open ends the
   *   connection, because `raw` of the messages could no longer be known.
   * - A JSON value that is not an object is reported.
   *
   * A reply to no call of ours is not a problem: the vendored client drops it.
   */
  readonly noteLineRead: (line: string) => LineProblem | undefined;
  /**
   * Remembers a line written to the harness. Call it before the line is
   * written, because a harness may reply at once. Returns the harness request
   * the line refused, when it did.
   */
  readonly noteLineWritten: (line: string) => RefusedRequest | undefined;
  /** Returns the last line read. `message` is the parsed line, or the line itself when it is not JSON. */
  readonly getLastLineRead: () => {
    readonly line: string;
    readonly message: unknown;
    /** The `params` of the message, or `undefined` when the line is not an object with `params`. */
    readonly params: unknown;
  };
  /**
   * Returns the open request of the harness that `requestKey` names. Throws
   * when there is none, which cannot happen: the request line is remembered
   * before the vendored client hands the request to a handler.
   */
  readonly readOpenRequest: (requestKey: string) => HarnessRequest;
  /** Creates a ticket for a call. It receives no reply until `bindTicket` gives it the id of the call. */
  readonly openTicket: () => CallTicket;
  /**
   * Makes the reply with JSON-RPC id `id` the reply of `ticket`. Call it
   * before the call is written, because a harness may reply at once.
   */
  readonly bindTicket: (ticket: CallTicket, id: string | number) => void;
  /** Forgets `ticket`. Call it when the call ends, however it ends. */
  readonly dropTicket: (ticket: CallTicket) => void;
  /**
   * Returns `text` with the value of every header that was written to the
   * harness in a session request replaced by `[hidden]`. A harness may echo
   * what it was sent, and the headers hold the session's bearer token.
   */
  readonly hideSecrets: (text: string) => string;
  /**
   * Returns `text` of the harness as it may appear in a sentence for a person:
   * the secrets hidden first, so that a cut never leaves half of one, then cut
   * to 200 characters with `...` when something was cut. Every harness text
   * put into a message goes through it, except a `harnessMessage`, which is
   * hidden but whole.
   */
  readonly quoteHarnessText: (text: string) => string;
}

/**
 * Reads the secrets in the headers of the MCP servers in the `params` of a
 * session request: each header value, and the credential after the scheme
 * (`abc` of `Bearer abc`), because a harness may echo the credential alone.
 * Returns an empty list for any other shape.
 */
const readHeaderSecrets = (params: unknown): ReadonlyArray<string> => {
  if (!isJsonObject(params) || !Array.isArray(params["mcpServers"])) return [];
  return (params["mcpServers"] as ReadonlyArray<unknown>)
    .flatMap((server) =>
      isJsonObject(server) && Array.isArray(server["headers"])
        ? (server["headers"] as ReadonlyArray<unknown>)
        : [],
    )
    .flatMap((header) => {
      const value = isJsonObject(header) ? header["value"] : undefined;
      if (typeof value !== "string" || value === "") return [];
      const credential = /^\S+\s+(\S.*)$/.exec(value)?.[1];
      return credential === undefined ? [value] : [value, credential];
    });
};

/**
 * Creates an empty memory. `buildRequestKey` turns a JSON-RPC id into the text
 * the vendored client calls that request, so `readOpenRequest` can be asked
 * with the name the client's handlers get.
 */
export const createWireMemory = (buildRequestKey: (id: string | number) => string): WireMemory => {
  let lastLine: ReturnType<WireMemory["getLastLineRead"]> = {
    line: "",
    message: undefined,
    params: undefined,
  };
  const openRequests = new Map<string, HarnessRequest>();
  // By request key. A call has one ticket, so there are few.
  const tickets = new Map<string, { reply: unknown }>();
  const secrets = new Set<string>();

  const hideSecrets = (text: string): string =>
    [...secrets].reduce((hidden, secret) => hidden.replaceAll(secret, "[hidden]"), text);

  const quoteHarnessText = (text: string): string => {
    const hidden = hideSecrets(text);
    return hidden.length > QUOTE_LENGTH ? `${hidden.slice(0, QUOTE_LENGTH)}...` : hidden;
  };

  return {
    noteLineRead: (line) => {
      const parsed = parseLine(line);
      const message = parsed === undefined ? line : parsed.value;
      lastLine = {
        line,
        message,
        params: isJsonObject(message) ? message["params"] : undefined,
      };
      // The vendored client skips blank lines and ends the connection on a line that is not JSON.
      if (parsed === undefined || line.trim() === "") return undefined;
      if (Array.isArray(message)) {
        return {
          reason:
            "The harness wrote a batch (a JSON array). ACP does not use batches, and the messages in it could not be told apart.",
          endsConnection: true,
        };
      }
      if (!isJsonObject(message)) {
        return {
          reason: "The harness wrote a line that is JSON but not a message (not a JSON object).",
          endsConnection: false,
        };
      }
      if (typeof message["method"] !== "string") {
        // A reply. One that matches no call of ours is dropped, as the vendored client does.
        const id = message["id"];
        const ticket = isRequestId(id) ? tickets.get(buildRequestKey(id)) : undefined;
        if (ticket !== undefined && "result" in message) ticket.reply = message["result"];
        return undefined;
      }
      const { id, method } = message;
      if (!isRequestId(id)) return undefined;
      const key = buildRequestKey(id);
      if (openRequests.has(key)) {
        return {
          reason: `The harness sent a second request with the id ${quoteHarnessText(JSON.stringify(id))} before the first was answered.`,
          endsConnection: true,
        };
      }
      openRequests.set(key, { id, method, params: message["params"], message });
      return undefined;
    },
    noteLineWritten: (line) => {
      const written = parseLine(line)?.value;
      if (!isJsonObject(written) || !isRequestId(written["id"])) return undefined;
      const { id, method } = written;
      if (typeof method === "string") {
        for (const secret of readHeaderSecrets(written["params"])) secrets.add(secret);
        return undefined;
      }
      const key = buildRequestKey(id);
      const request = openRequests.get(key);
      openRequests.delete(key);
      return request !== undefined && "error" in written
        ? { request, error: written["error"] }
        : undefined;
    },
    getLastLineRead: () => lastLine,
    readOpenRequest: (requestKey) => {
      const request = openRequests.get(requestKey);
      if (request === undefined) {
        throw new Error(`The request ${requestKey} of the harness is not open.`);
      }
      return request;
    },
    openTicket: () => ({ reply: undefined }),
    bindTicket: (ticket, id) => {
      tickets.set(buildRequestKey(id), ticket);
    },
    dropTicket: (ticket) => {
      for (const [key, candidate] of tickets) if (candidate === ticket) tickets.delete(key);
    },
    hideSecrets,
    quoteHarnessText,
  };
};
