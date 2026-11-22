/**
 * `hercule mcp-server sign-in <id> [--paste]`.
 *
 * Signing a server in through OAuth takes two calls with a browser between
 * them: `mcpServer.startSignIn` returns the address to open, and
 * `mcpServer.finishSignIn` takes what the browser came back with. The
 * command-table executor makes one call and cannot listen for a browser, so
 * this command is run by hand, as `hercule login` is. Its table row still
 * gives it its spelling, its help and its `<id>` positional.
 *
 * The browser's return is caught in one of two ways:
 *
 * - By default the CLI listens on a free port of 127.0.0.1 and gives the
 *   authorization server that address as the place to return to. This works
 *   when the browser runs on the same computer as the CLI.
 * - With `--paste` nothing listens. The browser is sent to a port that
 *   answers nobody, fails to load the page, and the user copies the address
 *   it ended on and pipes it in on stdin. This works for a browser on another
 *   computer, as when the CLI runs over SSH.
 *
 * The CLI opens no browser: it prints the address.
 */
import {
  ApiError,
  buildPastedRedirectUri,
  createClient,
  type HerculeClient,
} from "@hercule/client-core";
import {
  parseCallbackQuery,
  readApprovalHost,
  readAuthorizationState,
  type McpServer,
} from "@hercule/contract";
import { coerceFieldValue, parseArguments } from "./commands/args";
import { resolveTails } from "./commands/execute";
import type { HandWrittenHelp } from "./commands/help";
import type { Command } from "./commands/tree";
import { resolveCredential } from "./credentials";
import { EXIT, UsageError } from "./exit";
import type { Io } from "./io";

/**
 * What this command adds to the help of its table row: the flag it takes
 * beyond its operation's fields, and what it prints. The table row's own
 * `returns` is the answer of `mcpServer.startSignIn`, which this command
 * prints only as the address to open, and it ends by printing the server.
 */
export const SIGN_IN_HELP: HandWrittenHelp = {
  flags: [
    {
      label: "--paste",
      notes: "optional; for a browser on another computer",
      help: "Listen for nothing. After you approve, your browser fails to load a page on 127.0.0.1: copy that page's whole address and give it on stdin, because the CLI never prompts. Example: `echo 'http://127.0.0.1:51234/callback?code=4b1f0c7e&state=Zr8m2Qk1' | hercule mcp-server sign-in 1f3a9c2e --paste`. At a terminal, `cat | hercule mcp-server sign-in <id> --paste` waits for it: paste the address, press Enter, then Ctrl-D.",
    },
  ],
  prints:
    'The address to open in your browser and the host that asks for the approval, and once the sign-in is finished the line "Signed in. <name> is <status>.". With --json, the address and the waiting text go to stderr, and stdout holds the server, as `hercule mcp-server read` prints it.',
};

/** What the browser is shown after it returns to the listener. */
const RETURN_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Hercule</title></head>
<body><p>You can close this tab and return to the terminal. The terminal shows how the sign-in ended.</p></body>
</html>
`;

/** The headers every answer of the listener carries: nothing is cached, and no address leaks onward. */
const LISTENER_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
} as const;

/** A listener for the browser's return, and the means to wait for it. */
interface ReturnListener {
  /** The address the authorization server redirects the browser to. */
  readonly redirectUri: string;
  /**
   * Starts accepting the return of the attempt whose address carries
   * `state`. A request with any other `state` is refused as unknown.
   */
  readonly acceptState: (state: string) => void;
  /** Resolves with the raw query string of the browser's return. */
  readonly returned: Promise<string>;
  /** Stops listening. */
  readonly close: () => void;
}

/**
 * Starts a listener on a free port of 127.0.0.1. It answers only
 * `GET /callback` with the state it accepts and a well-formed return
 * (`parseCallbackQuery`), and 404 to everything else, so a stray request, a
 * request carrying another attempt's state or a malformed return does not end
 * the wait. The controller refuses a malformed return without using the
 * attempt up, so the listener must not take it as the answer either.
 */
const listenForReturn = (): ReturnListener => {
  let acceptedState: string | undefined;
  let deliver: (query: string) => void = () => undefined;
  const returned = new Promise<string>((resolve) => {
    deliver = resolve;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      const callback = parseCallbackQuery(url.search);
      if (
        request.method === "GET" &&
        url.pathname === "/callback" &&
        callback._tag === "Callback" &&
        callback.state === acceptedState
      ) {
        deliver(url.search.slice(1));
        return new Response(RETURN_PAGE, {
          headers: { ...LISTENER_HEADERS, "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("Not found", { status: 404, headers: LISTENER_HEADERS });
    },
  });
  return {
    redirectUri: `http://127.0.0.1:${server.port}/callback`,
    acceptState: (state) => {
      acceptedState = state;
    },
    returned,
    close: () => void server.stop(),
  };
};

/**
 * Waits for `returned`, up to `expiresAt`, and returns what it resolves with.
 * Fails with an `invalid_state` error that says to run `again`, when time runs
 * out first. The listener's wait is not cancelled: the command ends right
 * after. A pasted address has no such wait: the controller refuses an expired
 * attempt, and the stdin read cannot be cancelled.
 */
const waitUntilExpiry = async (
  returned: Promise<string>,
  expiresAt: string,
  again: string,
): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ApiError(
            "invalid_state",
            `The sign-in expired before your browser came back. Run \`${again}\` again.`,
            { reason: "sign-in-expired" },
          ),
        ),
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
  });
  try {
    return await Promise.race([returned, expired]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Reads the address the user pasted from stdin. Returns it without
 * surrounding whitespace. Fails with a `UsageError` when stdin is empty.
 */
const readPastedAddress = async (io: Io): Promise<string> => {
  const address = (await io.stdin()).trim();
  if (address === "") {
    throw new UsageError(
      "no address was given on stdin. Give the whole address your browser ended on.",
      "mcp-server sign-in",
    );
  }
  return address;
};

/**
 * Runs `hercule mcp-server sign-in` with the tokens after its words. Returns
 * the exit code. Fails with a `UsageError` for a bad command line, and with
 * the client's `ApiError` or `ConnectionError` when a call fails.
 *
 * Nothing is sent to the controller until the command line is known to work:
 * a `--paste` with no piped stdin fails before an attempt is started.
 */
export const signInMcpServer = async (
  command: Command,
  tokens: ReadonlyArray<string>,
  home: string,
  io: Io,
): Promise<number> => {
  const paste = tokens.includes("--paste");
  const args = await parseArguments(
    command,
    tokens.filter((token) => token !== "--paste"),
    io.stdin,
    io.isTty(),
  );
  if (paste && io.isTty()) {
    throw new UsageError(
      "--paste reads the address from stdin and never prompts, and stdin is a terminal. Pipe it in, or let `cat` read what you paste: `cat | hercule mcp-server sign-in <id> --paste`.",
      command.spelling,
    );
  }

  const credential = resolveCredential(home, io.env);
  const client: HerculeClient = createClient({
    baseUrl: credential.url,
    token: credential.token,
    fetch: io.fetch,
  });
  const idField = command.positionals[0]!;
  const given = args.positionals[0]!;
  const id = (
    await resolveTails(
      client,
      command,
      [idField],
      { [idField.name]: coerceFieldValue(idField, given, command.spelling) },
      {},
    )
  )[idField.name] as string;
  const again = `hercule mcp-server sign-in ${given}`;

  // With `--json` stdout holds the answer alone, so the instructions go to stderr.
  const say = args.json ? io.err : io.out;
  const listener = paste ? undefined : listenForReturn();
  let server: McpServer;
  try {
    const started = await client.mcpServer.startSignIn({
      params: { id },
      payload: {
        redirectUri: listener?.redirectUri ?? buildPastedRedirectUri(),
      },
    });
    say("Open this address in your browser to sign in:");
    say(`  ${started.authorizationUrl}`);
    // The page that asks for the approval belongs to this host, which the
    // user may not know the server by.
    say(`You will approve on ${readApprovalHost(started.authorizationUrl)}.`);
    say("");

    let callbackQuery: string;
    if (listener === undefined) {
      say("After you approve, your browser fails to load a page on 127.0.0.1. That is expected.");
      say("Copy that page's whole address and give it on stdin.");
      callbackQuery = await readPastedAddress(io);
    } else {
      const state = readAuthorizationState(started.authorizationUrl);
      if (state === undefined) {
        throw new UsageError("the controller's sign-in address has no state", command.spelling);
      }
      listener.acceptState(state);
      const minutes = Math.max(1, Math.ceil((Date.parse(started.expiresAt) - Date.now()) / 60_000));
      say(
        `Waiting for your browser to come back to this computer, for up to ${minutes} minute${minutes === 1 ? "" : "s"}. Press Ctrl-C to cancel.`,
      );
      say("If your browser is on another computer, cancel and run this again with --paste.");
      callbackQuery = await waitUntilExpiry(listener.returned, started.expiresAt, again);
      // The browser is done with the listener, so nothing else may reach it
      // while the controller finishes the sign-in.
      listener.close();
    }

    server = await client.mcpServer.finishSignIn({ params: { id }, payload: { callbackQuery } });
  } finally {
    listener?.close();
  }

  if (args.json) {
    io.out(JSON.stringify(server, null, 2));
  } else {
    io.out(`Signed in. ${server.name} is ${server.status}.`);
    if (server.status === "checking") {
      io.out(
        `It lists its tools again now: run \`hercule mcp-server read ${id.slice(-8)}\` to see the result.`,
      );
    }
  }
  return EXIT.ok;
};
