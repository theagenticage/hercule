# OAuth split sign-in proof (issue #1210)

Throwaway. Needs Bun, nothing else.

## What it proves

The controller is the OAuth client for a remote MCP server, but the user's browser is on another machine. The sign-in is split:

- `catch` (laptop) listens on `http://127.0.0.1:<port>/callback`, receives the redirect, prints the whole query string.
- `start` (controller machine) discovers the server, registers a client, keeps the PKCE verifier and `state`, prints the sign-in URL.
- `finish` (controller machine) takes the query string, checks `state` and `iss`, swaps the code for tokens on the controller, lists the MCP tools, refreshes once.

It answers, per server: does discovery work, does dynamic registration work, does the server accept a loopback redirect with a port that was not registered (RFC 8252), does it send `iss`, does the code exchange work from a machine other than the browser's, do tools list, does refresh work.

## Nothing secret is printed

`start` and `finish` never print or put in the report: access tokens, refresh tokens, client secrets, the code, the PKCE verifier. Errors show only the server's `error` code and at most 200 characters of `error_description`. Secrets live only in two 0600 files: the attempt file (deleted by `finish`) and the client file (kept between runs; delete it when done). The one exception: `catch` prints the query string it received, because you must copy it. That holds a single-use code which is useless without the verifier, which never leaves the controller machine.

## Sitting

All `bun proof.ts` commands run in this folder. Pick a free port or let `catch` choose.

### Notion

1. Laptop: `bun proof.ts catch`. It prints the port, say `A`. Leave it running.
2. Controller machine: `bun proof.ts start --server https://mcp.notion.com/mcp --redirect-port A`. It registers a client (without a port in the redirect URI) and prints a long URL.
3. Laptop: open that URL in the browser, sign in, approve. The page says "Sign-in received".
4. Laptop: copy the line between the `=====` markers that `catch` printed.
5. Controller machine: `bun proof.ts finish`, paste the line, press Enter. Or: `echo '<line>' | bun proof.ts finish`.
6. Keep the printed JSON report.

Run 2, same server, other port (proves one registration covers variable ports):

1. Laptop: `bun proof.ts catch` again. New port `B`.
2. Controller machine: `bun proof.ts start --server https://mcp.notion.com/mcp --redirect-port B`. It prints "reusing the client". Open the URL, copy the query, `finish` as above.

Both runs succeeding proves variable ports on one registration. The report says `clientReused: true` for run 2.

If run 1 is refused with a redirect_uri error: delete `client-mcp.notion.com.json`, then run once with `--registration dcr-exact` to see whether exact matching works. Run 2 on port B will then be refused, which confirms the server wants the exact URI.

### Linear

Same steps with `--server https://mcp.linear.app/mcp` (client file `client-mcp.linear.app.json`).

### Clean up

Delete `client-*.json` and `attempt.json` in this folder.

## Options

- `catch [--port N] [--host 127.0.0.1|localhost]`
- `start --server URL --redirect-port N [--redirect-host 127.0.0.1|localhost] [--registration dcr-portless|dcr-exact] [--state-file PATH] [--client-file PATH]`
- `finish [--state-file PATH] [--query '<q>']` (also takes a whole pasted URL)

## Testing the script itself

`fake-as.ts` is a local fake MCP and authorization server. The test drives all three commands against it, including wrong `state`, wrong or missing `iss`, and a switch for exact redirect matching:

```
bun test ./docs/research/mcp-oauth-split-proof/proof.test.ts
```

(From the repository root.)
