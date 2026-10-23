# Hercule wire reference for a native Android client

This reference is for the ticket that builds a native Kotlin Android client for Hercule. It gives everything the phone needs to speak to a controller: the HTTP API, the live WebSocket, what to notify on, and how to draw the crew faces. The aim is that the implementer never has to reverse-engineer anything.

| | |
|---|---|
| Source | commit `738cdb2b1` on `main` |
| Controller version seen | `0.1.0+738cdb2b1` |
| Effect | `4.0.0-rc.112` (the RPC framing in section B is Effect's) |
| Paths | relative to the repository root unless absolute |
| Date | 2026-10-13 |

Markers:

- **[Observed]** - captured from a real controller built from this commit. It ran with a throwaway `HERCULE_HOME` on a scratch port, and was driven by raw `curl` and a raw WebSocket client.
- **[Source]** - read from the code, not seen on the wire.
- An unmarked statement in A1, A2, C and D comes from the source, with a `file:line` citation.

Sections:

- **A. HTTP API.**
  - A0: captured responses.
  - A1: conventions, encodings, pagination, auth, controller, assistants, conversations.
  - A2: sessions, transcripts, inputs, approvals, questions, permissions, notifications, and "waiting on you".
- **B. Live WebSocket `/ws`.** The ticket, the exact Effect RPC JSON framing, a full captured exchange, topics, cursors, keepalive and reconnect.
- **C. Notifications.** What the desktop alerts on today, how it dedupes, and a proposed rule set for the phone.
- **D. Crew faces.** The look algorithm with test vectors, poses, geometry, fonts and licences, `tokens.css` and the themes.
- **E. Open items.** Questions the ticket must settle.

Five facts that save the most time:

1. **One request shape everywhere.** Send `Authorization: Bearer <token>` and JSON bodies. Every success is 200.
2. **One error shape everywhere.** Every error is `{"error":{"code","message","details"?}}` with no `_tag`. The live socket's `Fail` cause carries the same envelope.
3. **The socket only says what changed.** It pushes "these ids changed", and the phone re-reads them over HTTP. The only exceptions are the event log and session transcripts, which push records with a cursor, and token taps, which are never stored.
4. **Every WebSocket Request carries `"headers":[]`.** Without it, the socket is closed with code 1011. After every `Chunk`, send an `Ack`, or the stream stalls.
5. **There is no "waiting on you" endpoint.** It is derived from `openRequests` on the Thread sessions and on each assistant's current session (A2, "Waiting on you").


## A. HTTP API

### A0. Responses captured from a running controller [Observed]

How these were captured:

- The controller was built from this branch, version `0.1.0+738cdb2b1`, and ran from source (`bun packages/hercule/src/main.ts serve`) with a throwaway `HERCULE_HOME`.
- Setup was completed with username `ada`, which creates the default assistant and its web conversation.
- Every line below is a real request and the real response body, with long text cut.
- I did **not** call `conversation.send`, `session.input` or anything that spawns a session. The local runner had real Claude and Codex providers, so those calls would have run real agents. The session, transcript, approval and question shapes in A1 and A2 therefore come from the source.

**Success bodies:**

```text
POST /api/v1/auth/login  {"username":"ada","password":"..."}
  200 {"token":"jkyCt5QiYqAVSZosDUHnZG1OqrAIUSJm1CXtgs3hVM4","expiresAt":"2026-11-11T21:58:28.467Z"}
  (response headers: Content-Type: application/json, Vary: origin)

POST /api/v1/auth/ws-ticket   (no body, or {})
  200 {"ticket":"FH9MqADpAgag-iTgyYfe4od61cv6DcSaxIYvFyj5JzQ"}

POST /api/v1/auth/logout
  200 {}

POST /api/v1/api-keys  {"name":"Pixel 9"}
  200 {"id":"01a13220-ec51-757a-8f1b-e22e383103cd","name":"Pixel 9","token":"Ys4_aQgwO5czelQKBT7flJGWEOZ2wLuzmf1AkrJkEk8","createdAt":"2026-10-12T21:59:40.881Z"}

GET /api/v1/controller
  200 {"id":"01a1321f-93ca-77f0-ba8a-b49a69e03880","publicKey":"MCowBQYDK2VwAyEA6U0Lr7R46jaRidBebshNMBeA0hePpqrD9s+llDJ3jhg=","version":"0.1.0+738cdb2b1","defaultRunnerId":"01a1321f-9470-77f6-ba91-0bc1a99f06ca","localRunnerId":"01a1321f-9470-77f6-ba91-0bc1a99f06ca","textGeneration":{"model":null,"lastFailure":null}}

GET /api/v1/assistants
  200 {"items":[{"id":"01a1321f-b5cf-7613-99ad-0cbfd6ede00e","name":"Hercule","systemPrompt":"You are a personal assistant running inside the user's own controller. ...","instanceId":"01a1321f-93d9-7254-af1c-ac2c5c0926be","permissionProfileId":"01a1321f-93cc-71d9-82f4-41b6639a61eb","accessMode":"full-access","model":null,"disallowedTools":["edit"],"unenforced":[],"createdAt":"2026-10-12T21:58:21.391Z","updatedAt":"2026-10-12T21:58:21.391Z","heartbeat":{"enabled":true,"schedule":"0 7-23 * * *","prompt":"...","target":"web"},"rotation":{"contextFraction":0.7,"maxContextTokens":200000,"dailyAt":"04:00"},"reply":"turn-end","mainConversationId":"01a1321f-b5cf-7614-ae4d-a681479eba3c"}]}
  (no nextCursor key on the last page; no timezone keys in heartbeat/rotation)

GET /api/v1/assistants/01a1321f-b5cf-7613-99ad-0cbfd6ede00e
  200 the same object as one item above

GET /api/v1/conversations
  200 {"items":[{"id":"01a1321f-b5cf-7614-ae4d-a681479eba3c","assistantId":"01a1321f-b5cf-7613-99ad-0cbfd6ede00e","channel":"web","containerKey":null,"createdAt":"2026-10-12T21:58:21.391Z"}]}

GET /api/v1/conversations/01a1321f-b5cf-7614-ae4d-a681479eba3c/messages?limit=2     200 {"items":[]}
GET /api/v1/sessions?thread=true&limit=500                                          200 {"items":[]}
GET /api/v1/sessions?conversationId=01a1321f-...&sort=createdAt:desc&limit=1        200 {"items":[]}
GET /api/v1/notifications?status=open&limit=100                                     200 {"items":[]}
GET /api/v1/signals?view=to-do                                                      200 {"items":[]}
```

**Error bodies:**

```text
GET /api/v1/controller   (no Authorization header)
  401 {"error":{"code":"unauthenticated","message":"this operation needs a credential"}}

POST /api/v1/auth/login  (wrong password)
  401 {"error":{"code":"unauthenticated","message":"the username or password is incorrect"}}

POST /api/v1/auth/login  {"username":"ada"}
  400 {"error":{"code":"validation","message":"the request body is not valid","details":{"issues":[{"path":["password"],"message":"Missing key"}]}}}

POST /api/v1/api-keys  '{"name":'   (broken JSON)
  400 {"error":{"code":"validation","message":"the request body is not valid","details":{"issues":[{"path":[],"message":"Expected a valid JSON body"}]}}}

POST /api/v1/conversations/<id>/messages  (Content-Type: text/plain)
  400 {"error":{"code":"validation","message":"the request is not valid","details":{"issues":[{"path":[],"message":"the request body must be application/json"}]}}}
  (no Content-Type at all, and "application/json; charset=utf-8", are both accepted)

POST /api/v1/sessions/<id>/input  {"text":"hi","bogus":1}
  400 {"error":{"code":"validation","message":"the request body is not valid","details":{"issues":[{"path":["bogus"],"message":"This field is not known here. Correct its name, or remove it."}]}}}

GET /api/v1/sessions/not-an-id
  400 {"error":{"code":"validation","message":"the path is not valid","details":{"issues":[{"path":["id"],"message":"Expected a canonical lowercase UUIDv7"}]}}}

GET /api/v1/sessions?limit=abc
  400 {"error":{"code":"validation","message":"the query string is not valid","details":{"issues":[{"path":["limit"],"message":"Expected a string representing a finite number"}]}}}

GET /api/v1/sessions?agentId=<id>&thread=true
  400 {"error":{"code":"validation","message":"the request is not valid","details":{"issues":[{"path":["thread"],"message":"a Thread is a session with no agent, so a query cannot ask for both: send agentId to list one agent's sessions, or thread to list the sessions that have no agent"}]}}}

POST /api/v1/auth/logout  (with an API key)
  400 {"error":{"code":"validation","message":"this credential is not a login token","details":{"issues":[{"path":[],"message":"logout revokes a login token; use apiKey.revoke for a key"}]}}}

POST /api/v1/notifications  (as the user)
  403 {"error":{"code":"forbidden","message":"a notification is a message to you, so you cannot create one; a session or a workflow step creates it","details":{"grant":"notification.write"}}}

GET  /api/v1/sessions/<unknown id>                                  404 {"error":{"code":"not_found","message":"no such session"}}
GET  /api/v1/sessions/<unknown id>/transcript                       404 {"error":{"code":"not_found","message":"no such session"}}
POST /api/v1/sessions/<unknown id>/respond-to-approval-request      404 {"error":{"code":"not_found","message":"no such session"}}
POST /api/v1/permissions/requests/<unknown id>/decide               404 {"error":{"code":"not_found","message":"there is no Permission Request with this id"}}
POST /api/v1/notifications/<unknown id>/act                         404 {"error":{"code":"not_found","message":"no such notification"}}
GET  /api/v1/nope                                                   404 {"error":{"code":"not_found","message":"no such route"}}
```

What the captures settle:

- **The error body has no `_tag`.** Every error had exactly `{"error":{"code","message","details"?}}`.
- **Status codes:**
  - success is always 200;
  - 400 for validation, 401 unauthenticated, 403 forbidden, 404 not found.
- **The checks run in this order:**
  - auth before validation: `POST /api/v1/sessions/not-an-id/input` with body `{"bogus":1}` and no token got 401, not 400;
  - path decode before the operation runs.
- **Ids** in responses are lowercase UUIDv7.
- **Timestamps** are ISO-8601 UTC with exactly 3 millisecond digits and a `Z`.
- **Content-Type:**
  - a wrong `Content-Type` gets a 400 `validation` in the envelope. It is not a 415, whatever Effect's default would be;
  - a missing `Content-Type` is read as JSON.
- **Decode failures** returned one issue each in these captures. A union mismatch returns one issue per member (seen on the live socket, section B.4).
- **An API key** works everywhere a login token does, including `auth.wsTicket`, except `auth.logout`.
- **Oversized bodies** [Source]: a body over 2 MiB (`MAX_REQUEST_BODY_BYTES`, `apps/controller/src/http/server.ts:135`) gets a bare `413` with no JSON envelope. Image uploads are the one exception and have their own, larger limit (`MAX_UPLOAD_BODY_BYTES`).


### A1 - HTTP core: auth, controller, assistants, conversations

This is the wire reference for the first ten operations a native client needs. Each route, field and message here was read from the source at commit `738cdb2b1` (Effect `4.0.0-rc.112`). The examples in this part are built from the schemas; the responses actually captured from a running controller are in A0 above, and they agree with this part. Every file path is relative to the repository root.

Contract sources:

- `packages/contract/src/operations.ts`: the route table. `API_PREFIX = "/api/v1"` is at line 21.
- `packages/contract/src/groups/*.ts`: the schemas.
- `apps/controller/src/http/routes.ts`: the handlers. Each handler is one line that calls a service.

---

#### 1. General conventions

##### 1.1 Base URL and headers

| Item | Value |
|---|---|
| Base | `<controller origin>/api/v1`. The default bind is `127.0.0.1:4937` (`packages/home/src/config.ts:71-72`), so a phone needs the controller bound to a reachable address, for example `http://100.101.102.103:4937/api/v1` over Tailscale. The controller serves plain HTTP only. Spec 13 describes optional Tailscale-managed HTTPS on port 4938 (`docs/spec/13-security.md:19`), but it is not built yet; see the open items |
| Auth | `Authorization: Bearer <token>` (Effect `HttpApiSecurity.bearer`, `packages/contract/src/security.ts`) |
| Request body | JSON. Send `Content-Type: application/json` (a `; charset=utf-8` suffix is fine). If the header is absent, the body is read as JSON. Any other content type gets 400 `validation` in the envelope, issue `{"path":[],"message":"the request body must be application/json"}` [Observed]. A body over 2 MiB gets a bare `413` with no envelope (`apps/controller/src/http/server.ts:135`) |
| Response body | Always JSON (`application/json`), success or error |
| Success status | Always **200**, including create operations. Only `HttpApiSchema.status(...)` changes it, and none of the ten operations here use it (`effect/unstable/httpapi/HttpApiSchema.ts:984`) |
| Empty success | An operation whose success schema is `Struct({})` returns `200` with body `{}` |
| Path matching | Case-insensitive, and the path is normalized (`apps/controller/src/http/gate.ts:10-14`). Always send the canonical lowercase path anyway |

##### 1.2 Error envelope

Every failure is exactly one JSON object. It has no `_tag`, because the error classes are `Schema.Error`, not `TaggedError` (`packages/contract/src/errors.ts`).

```json
{
  "error": {
    "code": "validation",
    "message": "the request body is not valid",
    "details": {
      "issues": [
        { "path": ["text"], "message": "Expected a value with a length of at least 1, got \"\"" }
      ]
    }
  }
}
```

`error.code` is a closed enum that only grows (`packages/contract/src/errors.ts:26-55`). The client must handle every value and treat an unknown code as `internal`:

| code | HTTP | `details` |
|---|---|---|
| `unauthenticated` | 401 | absent |
| `forbidden` | 403 | `{ "grant": "<grant name>" }` |
| `validation` | 400 | `{ "issues": [ { "path": string[], "message": string } ] }` |
| `not_found` | 404 | absent |
| `conflict` | 409 | absent |
| `invalid_state` | 409 | absent |
| `controller_sealed` | 503 | `{ "newAddress": "<url>" }` |
| `promotion_in_progress` | 409 | absent |
| `cap_exceeded` | 422 | `{ "size": int, "cap": int }` or `{ "count": int, "cap": int }` (`errors.ts:66-69`) |
| `shrink_rejected` | 422 | `{ "previousSize": int, "size": int }` (`errors.ts:77`) |
| `internal` | 500 | absent. The message is always `"something went wrong"` |

Notes:

- `details` is an absent key when the code has none. It is never `null`.
- Three codes share 409, so switch on `error.code`, never on the status.
- In an issue, `path` is an array of strings. Array indexes appear as strings too, for example `["sort","1"]`. An empty array means the whole input.

Errors the transport produces before any operation runs (`apps/controller/src/http/envelope.ts:60-84`):

| Cause | code | message |
|---|---|---|
| Body fails the schema | `validation` | `the request body is not valid` |
| Query fails the schema | `validation` | `the query string is not valid` |
| Path param fails the schema (for example a malformed id) | `validation` | `the path is not valid` |
| Body is not valid JSON | `validation` | `the request body is not valid`, with one issue `{ "path": [], "message": "Expected a valid JSON body" }` [Observed] |
| No route matches | `not_found` | `no such route` |
| Anything unexpected | `internal` | `something went wrong` |

##### 1.3 Order of checks

A request goes through these checks in this order. The first one that fails decides the response.

1. **Route match.** No match gives 404 `not_found` "no such route".
2. **Setup gate** (`apps/controller/src/http/gate.ts:37-71`). Until first-run setup is complete, every operation except `setup.read` and `setup.complete` returns 401 `unauthenticated` with message `Hercule is not set up yet. Open the setup URL to finish first run.`. This includes `auth.login`.
3. **Promotion gate** (`gate.ts:110-132`).
   - On a sealed controller, every request except `setup.read` returns 503 `controller_sealed` with `details.newAddress`. The client should switch to that address.
   - While a promotion is in progress, any non-GET (for example login, logout, ws-ticket, apiKey.create, conversation.send) returns 409 `promotion_in_progress`. GETs still work.
4. **Auth middleware.** A missing bearer token, or one that does not resolve, returns 401 `unauthenticated` with message `this operation needs a credential` (`apps/controller/src/actor/index.ts:33`, `apps/controller/src/http/middleware.ts:128-132`). A known caller without the operation's grant gets 403 `forbidden`.
5. **Decode** of the path params, query and body. A failure gives 400 `validation`. Because auth runs first, a bad request without a token gets 401, not 400.
6. **The operation itself.** Its errors include 404 `not_found` for an unknown id and the service-level `validation` and `forbidden` errors.

##### 1.4 Who can call what

- The **user** is the human owner, authenticated by a login token or an API key. The user holds every grant.
- A **session token**, the credential an agent's session holds, carries only its permission profile's grants.
- Some operations are **user-only**: `controller.read`, `apiKey.create`, `conversation.send` and `auth.wsTicket`. A session caller gets 403 or 401 even if it holds the grant (see each operation).
- A native client always authenticates as the user, so for it the grant column is informational.

---

#### 2. Encodings (Effect Schema 4 over JSON)

HttpApi sends bodies through `Schema.toCodecJson` and path, query and headers through `Schema.toCodecStringTree` (`effect/unstable/httpapi/HttpApiEndpoint.ts:1081-1088, 1366-1384`). The table below shows how each type looks on the wire.

| Schema type | JSON body encoding | Used by these ops? |
|---|---|---|
| `Schema.String`, `NonEmptyString`, `Literal("x")` | JSON string | yes |
| `Schema.Number` with an `isInt`/`isFinite` check, and `Schema.Int` | JSON number (`50`, `0.7`) | yes (`position`, `limit`, `maxContextTokens`, `contextFraction`) |
| `Schema.Number` **without** a finite check | a JSON number, but `NaN`, `Infinity` and `-Infinity` encode as the **strings** `"NaN"`, `"Infinity"` and `"-Infinity"` (`effect/SchemaAST.ts:3343`) | `hello.v` only, on the socket |
| `Schema.Boolean` | `true` / `false` | yes |
| `Schema.Date` | ISO 8601 string via `Date.toISOString()`, for example `"2026-10-13T09:41:07.512Z"` (`effect/Schema.ts:12218`) | **no** |
| `Schema.DateTimeUtc` | ISO 8601 string via `DateTime.formatIso` (`effect/Schema.ts:13768`, `effect/SchemaTransformation.ts:1888-1905`) | **no** |
| `Schema.DateTimeUtcFromString` | ISO 8601 string | **no** |
| `Schema.Option(X)` | tagged object: `{"_tag":"Some","value":<X>}` or `{"_tag":"None"}` (`effect/Schema.ts:9719-9728`) | **no** |
| `Schema.OptionFromNullOr(X)` | `<X>` or `null` (`effect/Schema.ts:9791`) | **no** |
| `Schema.NullOr(X)` | the key is **always present**, and its value is `<X>` or `null` | yes |
| `Schema.optionalKey(X)` | the key is **absent** or holds `<X>`. It is never `null`, and an explicit `null` fails decode | yes |
| `Schema.optional(X)` | absent, or `<X>`, or `undefined` (which JSON cannot carry) | **no** |
| `Schema.Record(String, V)` | JSON object | yes (`ModelSelection.options`) |
| Branded ids | **not used.** The contract's ids are plain strings checked against a pattern (below) | - |

**What the contract actually uses.** A grep of `packages/contract/src` and `packages/protocol/src` finds no use of `Schema.Date`, `DateTimeUtc*`, `Option(`, `OptionFrom*`, `optional(` or `Tagged*`. The ten operations here use only three shapes for "maybe" and for time:

1. **`Timestamp`** (`packages/protocol/src/primitives.ts:24-29`) is a plain string that must match `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`. It is always UTC, always exactly 3 fractional digits, and always ends in `Z`. Example: `"2026-10-13T09:41:07.512Z"`. In Kotlin, `Instant.parse` reads it. When sending one, format with exactly 3 millisecond digits.
2. **`NullOr`**: the key is always present and may be `null`.
3. **`optionalKey`**: the key may be absent, and is never `null`.

Kotlin mapping:

- For a `NullOr` field, use `val x: T?` with no default, so a missing key is a decode error.
- For an `optionalKey` field, use `val x: T? = null` and serialize with `explicitNulls = false`, so a `null` is never sent.
- Use `ignoreUnknownKeys = true`, because objects grow additively.

##### 2.1 Ids

`Id` (`packages/contract/src/ids.ts:97-104`) is a **lowercase canonical UUIDv7**:

```
^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
```

- Example: `0199d3a2-7c4e-7b1a-9f3e-2d5c8a1b4e60`.
- An id has no prefix and no brand on the wire.
- The controller mints ids with `Bun.randomUUIDv7()` (`apps/controller/src/db/id.ts:12`), so ids sort by creation time.
- Uppercase, a non-v7 UUID, or the braced form fails decode. In a path this gives 400 "the path is not valid".
- Treat an id as an opaque string. Never parse its time.

##### 2.2 Tokens and keys

Every credential the controller mints is a login token, an API key token, or a ws ticket. Each one is **32 random bytes, base64url, with no padding: 43 characters from `[A-Za-z0-9_-]`, with no prefix** (`apps/controller/src/credentials/token.ts:20-24`).

- Example: `q3Zf8xV1bN0cR7tYkL2mP9sD4hJ6wE5aG1uI8oT3nXc`.
- The controller stores only a SHA-256 hash. A token cannot be shown again after it is minted.
- Nothing in a token says which kind it is. Treat it as opaque.

---

#### 3. Query-string encoding (GET)

The query is decoded with `toCodecStringTree` wrapped in `toCodecArrayFromSingle` (`effect/unstable/httpapi/HttpApiBuilder.ts:769`). The URL is parsed by `searchParamsFromURL` (`effect/unstable/http/HttpServerRequest.ts:146`).

| Kind | How to send | Example |
|---|---|---|
| String / id | the plain value, percent-encoded | `assistantId=0199d3a2-7c4e-7b1a-9f3e-2d5c8a1b4e60` |
| Integer | decimal digits | `limit=50` |
| Boolean | exactly `true` or `false` (`effect/Schema.ts:16294`) | `foo=true` |
| Null | the literal string `null` (no op here takes one) | - |
| Array | **repeat the key**, one value per occurrence | `sort=position:desc&sort=createdAt` |
| Single-element array | one occurrence is enough. A single value is accepted where an array is expected | `sort=position:desc` |
| Absent optional | leave the key out. Never send `key=` (an empty string fails most checks) | - |

Rules:

- **No bracket syntax.** `sort[]=...` is a different key and is ignored.
- **No comma splitting.** `sort=a,b` is one value and fails the pattern.
- **Unknown params are silently ignored** (`packages/contract/src/pagination.ts` comments). A typo such as `limt=10` does not fail; the default is used instead.
- The order of repeated keys is preserved, and it matters for `sort`.

##### 3.1 Pagination (shared by every list)

Source: `packages/contract/src/pagination.ts` and `apps/controller/src/db/page.ts`.

**Query params:**

| Param | Type | Rule | Default |
|---|---|---|---|
| `limit` | Int | 1..500 (`MAX_PAGE_LIMIT`) | 50 (`DEFAULT_PAGE_LIMIT`) |
| `cursor` | non-empty string | opaque. Send back exactly what `nextCursor` held | absent means the first page |
| `sort` | repeated `<field>` or `<field>:asc` or `<field>:desc` | each field at most once. At most as many keys as the list has sort fields. No direction means `asc` | the list's default order |

**Response:**

```json
{ "items": [ /* ... */ ], "nextCursor": "WyJjb252ZXJzYXRpb24ucXVlcnlNZXNzYWdlcyIsW3siZmllbGQiOiJwb3NpdGlvbiIsImRpcmVjdGlvbiI6ImRlc2MifV0sMTQ5XQ" }
```

- `nextCursor` is an `optionalKey`. It is **absent on the last page** and present only when more rows exist (`db/page.ts` `buildPage`, 492-504).
- An empty `items` with no `nextCursor` means the list is empty.
- There are no totals and no page numbers.

**Cursor rules:**

- The cursor is opaque base64url JSON, bound to the operation **and to the exact sort fields and directions** it was issued under (`db/page.ts:155-165, 577-601`).
- **Always resend the same `sort` (and the same filters) together with `cursor`.** `limit` may change between pages.
- A cursor that does not match gives 400 `validation`, `details.issues = [{ "path": ["cursor"], "message": ... }]`, with one of these messages:
  - `The cursor is not one this listing issued.` (wrong operation, or a malformed cursor)
  - `The cursor was issued for a different listing.` (different sort fields)
  - `The cursor was issued under a different sort order.` (different direction)
- The client should drop the cursor and start again from the first page.
- If the same field appears twice in `sort`, the response is 400, with the issue message `<field> appears more than once in sort; name each field once.`.
- Paging is keyset paging. While the sort values do not change, a walk through the pages never repeats or skips a row. The tie-break on `id` follows the direction of the last sort key.

---

#### 4. Login flow

1. `POST /api/v1/auth/login` with `{username, password}` returns `{token, expiresAt}`.
2. Send `Authorization: Bearer <token>` on every call.
   - **Expiry rolls.** The token lives 30 days from its last use. Each authenticated use moves `expires_at` to now + 30 days, written at most once every 5 minutes (`apps/controller/src/credentials/repository.ts:14-19, 45, 157-191`).
   - The client is **never told the new expiry**. `expiresAt` from login is only the first value.
   - **Treat any 401 `unauthenticated` as "log in again"**, except the setup-gate message.
3. For a long-lived device credential, the user may mint an **API key** (`apiKey.create`) instead.
   - An API key never expires; it ends only when revoked.
   - It is used exactly like a login token (`Authorization: Bearer <key token>`).
   - Its last use is stamped at most once every 5 minutes.
   - `auth.logout` refuses it. Revoke it with `apiKey.revoke` instead.
4. **Live socket.** `POST /api/v1/auth/ws-ticket` returns `{ticket}`.
   - The ticket is single-use, lives 5 minutes, and is kept in memory only, so a controller restart drops it (`apps/controller/src/live/tickets.ts`).
   - Open a WebSocket to **`<origin>/ws`**. This path is not under `/api/v1`, and the handshake has **no query string and no auth header** (`apps/controller/src/live/socket.ts:61`).
   - Send the Effect RPC `hello` request with payload `{"v": 1, "ticket": "<ticket>"}` (`packages/contract/src/groups/live.ts:285-290`, `LIVE_PROTOCOL_VERSION = 1` at line 51).
   - `hello` answers `{"v": 1, "serverVersion": "<same string as controller.read version>"}`.
   - A bad ticket gives `unauthenticated` "the ticket is not valid" (`socket.ts:73`).
   - Fetch a new ticket for every connection and every reconnect. The RPC framing on the socket is documented in the live-socket part, not here.

---

#### 5. Operations

##### auth.login

| | |
|---|---|
| Method | `POST` |
| Path | `/api/v1/auth/login` |
| Grant | none (`unauthenticated`: no auth middleware) |
| Source | `packages/contract/src/operations.ts:68`; schemas `packages/contract/src/groups/auth.ts:30-50`; service `apps/controller/src/auth/service.ts` |

The request has no params and no query. Its body is `LoginPayload` (`auth.ts:30-33`):

| Field | Type | Rule |
|---|---|---|
| `username` | string | 1..64 chars (`packages/contract/src/strings.ts:71-76`). Messages: `Enter your username.` / `A username must be at most 64 characters.` |
| `password` | string | 1..1024 chars (`strings.ts:63-68`). Messages: `Enter your password.` / `A password must be at most 1024 characters.` |

```json
{ "username": "rogier", "password": "correct horse battery staple" }
```

Response 200, `LoginResult` (`auth.ts:35-38`):

```json
{ "token": "q3Zf8xV1bN0cR7tYkL2mP9sD4hJ6wE5aG1uI8oT3nXc", "expiresAt": "2026-11-12T09:41:07.512Z" }
```

| Field | Type | Notes |
|---|---|---|
| `token` | non-empty string | 43-char base64url. Store it securely (Android Keystore-backed storage) |
| `expiresAt` | `Timestamp` | now + 30 days at login. It rolls forward silently afterwards (section 4) |

Errors: `unauthenticated`, `validation`, `internal`, `controller_sealed`, `promotion_in_progress`.

- A wrong username or a wrong password gives 401 `unauthenticated` with message `the username or password is incorrect`. The response takes the same time either way, so the client cannot tell which one was wrong.
- Before setup, the response is 401 with the setup-gate message (section 1.3).

```json
{ "error": { "code": "unauthenticated", "message": "the username or password is incorrect" } }
```

##### auth.logout

| | |
|---|---|
| Method | `POST` |
| Path | `/api/v1/auth/logout` |
| Grant | `authenticated` (any valid credential passes the middleware) |
| Source | `operations.ts:69`; `groups/auth.ts:51-54`; `apps/controller/src/auth/service.ts` |

The request has no params, no query and no body. Any body sent is ignored. The token being revoked is the bearer token itself.

Response 200:

```json
{}
```

After this, the same token gets 401 (confirmed in `e2e/api.test.ts:379-422`).

Errors: `unauthenticated`, `validation`, `internal`, plus the middleware's `forbidden`, `controller_sealed` and `promotion_in_progress`.

- If the bearer is an API key or a session token, the response is 400 `validation`:

```json
{
  "error": {
    "code": "validation",
    "message": "this credential is not a login token",
    "details": { "issues": [ { "path": [], "message": "logout revokes a login token; use apiKey.revoke for a key" } ] }
  }
}
```

- Logging out a token that is already revoked cannot happen in practice, because the middleware rejects that token with 401 first. The service itself treats it as a no-op.

##### auth.wsTicket

| | |
|---|---|
| Method | `POST` |
| Path | `/api/v1/auth/ws-ticket` |
| Grant | `authenticated`, **user only** |
| Source | `operations.ts:70`; `groups/auth.ts:41-43, 55-58`; `apps/controller/src/live/tickets.ts` |

The request has no params, no query and no body.

Response 200, `WsTicket`:

```json
{ "ticket": "Hk2mZr9QwX4vT1bN8pL0sD7fG3jC6yE5aU2iO9tR1qW" }
```

- The ticket is single use and lives 5 minutes. It is kept in memory, so a controller restart loses it.
- Issuing a ticket also purges expired ones.
- Use it in the socket's `hello` (section 4).

Errors: `unauthenticated`, `internal`, plus the middleware's errors. A session caller gets 401 `unauthenticated` with message `only the user can open a live connection; a session or a run reads what it needs through the API`.

##### apiKey.create

| | |
|---|---|
| Method | `POST` |
| Path | `/api/v1/api-keys` |
| Grant | `credential.write`, **user only** |
| Source | `operations.ts:73`; schemas `packages/contract/src/groups/api-key.ts:17-52`; service `apps/controller/src/credentials/service.ts` |

The request has no params and no query. Its body:

| Field | Type | Rule |
|---|---|---|
| `name` | string | 1..128 chars (`KeyName`, `api-key.ts:17`) |

```json
{ "name": "Pixel 9 - Hercule app" }
```

Response **200** (not 201), `MintedApiKey` (`api-key.ts:31-36`):

```json
{
  "id": "0199d3a2-7c4e-7b1a-9f3e-2d5c8a1b4e60",
  "name": "Pixel 9 - Hercule app",
  "token": "Zx8c1V0bN3mQ7wE4rT6yU2iO5pA9sD1fG8hJ3kL0zXc",
  "createdAt": "2026-10-13T09:41:07.512Z"
}
```

- `token` is returned **only here, once**. The controller stores only its hash.
- The key never expires.
- The mint writes the audit kind `auth.apiKey.minted`.

For reference, this is `ApiKey` (`api-key.ts:20-26`) as `apiKey.query` returns it. That operation is not in this part.

```json
{ "id": "0199d3a2-7c4e-7b1a-9f3e-2d5c8a1b4e60", "name": "Pixel 9 - Hercule app", "createdAt": "2026-10-13T09:41:07.512Z", "lastUsedAt": "2026-10-13T10:02:44.190Z" }
```

`lastUsedAt` and `revokedAt` are `optionalKey` `Timestamp`s: **absent keys, never null** (`credentials/service.ts:57-66`).

Errors: `unauthenticated`, `forbidden`, `validation`, `internal`, plus the middleware's errors. A session caller gets 403 `forbidden` with `details.grant`, message `only the user may make this call; no grant confers it`.

##### controller.read

| | |
|---|---|
| Method | `GET` |
| Path | `/api/v1/controller` |
| Grant | `infra.read`, **user only** |
| Source | `operations.ts:658`; schemas `packages/contract/src/groups/controller.ts:22-106`; service `apps/controller/src/controller/service.ts:89, 104-107` |

The request has no params, no query and no body.

Response 200, `ControllerInfo` (`controller.ts:59-73`):

```json
{
  "id": "0199c0e1-22aa-7d10-8b4f-6a3e1c9d0f12",
  "publicKey": "MCowBQYDK2VwAyEAqT3m9pZ1vX8cB2nL7kR4sD0fG6hJ5wE1aU9iO3tY2qM=",
  "version": "0.1.0+738cdb2b1",
  "defaultRunnerId": "0199c0e1-3b07-7f2c-a1d4-5e8b2c7f9a03",
  "localRunnerId": "0199c0e1-3b07-7f2c-a1d4-5e8b2c7f9a03",
  "textGeneration": {
    "model": { "instanceId": "0199c0e2-0a11-7c3d-9e5f-1b2a3c4d5e6f", "model": "claude-haiku-4-5" },
    "lastFailure": null
  }
}
```

| Field | Type | Null? |
|---|---|---|
| `id` | Id | no |
| `publicKey` | string, Ed25519 public key in base64 | no |
| `version` | non-empty string | no |
| `defaultRunnerId` | Id | `NullOr`: always present, may be `null` |
| `localRunnerId` | Id | `NullOr` |
| `textGeneration.model` | `{ instanceId: Id, model: string (1..512) }` (`groups/settings.ts:87-90`) | `NullOr` |
| `textGeneration.lastFailure` | `{ reason, message: string, at: Timestamp }` | `NullOr` |
| `textGeneration.lastFailure.reason` | enum `"unavailable"` \| `"timeout"` \| `"invalid-output"` (`controller.ts:22-26`) | no |

`lastFailure` when present:

```json
{ "reason": "timeout", "message": "the model did not answer within 30 seconds", "at": "2026-10-13T08:12:00.004Z" }
```

**Version format.** `version` comes from `VERSION` in `@hercule/home/version`, which `scripts/gen-version.ts` generates at build time.

- It is `<package.json version>+<git short sha>`, for example `"0.1.0+738cdb2b1"`.
- When no git sha is available, it is the plain version, for example `"0.1.0"`.
- It is semver with build metadata. Compare it as an opaque string unless the client needs ordering.
- The same string comes back as `serverVersion` from the socket's `hello`.

Errors: `unauthenticated`, `forbidden`, `internal`, plus the middleware's errors. A session caller gets 403 `only the user may make this call; no grant confers it`.

##### assistant.query

| | |
|---|---|
| Method | `GET` |
| Path | `/api/v1/assistants` |
| Grant | `agent.read` |
| Source | `operations.ts:499`; schemas `packages/contract/src/groups/assistant.ts:50-141` and `groups/agent.ts:56-73`; service `apps/controller/src/assistants/service.ts:111` |

The request has no params and no body. Its query is `pageParams(["createdAt"])`:

| Param | Values |
|---|---|
| `limit` | 1..500, default 50 |
| `cursor` | from `nextCursor` |
| `sort` | `createdAt`, `createdAt:asc` or `createdAt:desc`. The default is `createdAt` ascending |

```
GET /api/v1/assistants?limit=50&sort=createdAt:asc
```

Response 200, `{ items: Assistant[], nextCursor?: string }`:

```json
{
  "items": [
    {
      "id": "0199d3a1-0f00-7e21-8c3b-4a5d6e7f8091",
      "name": "Ada",
      "systemPrompt": "You are Ada, Rogier's assistant. Delegate work to agents; keep him informed.",
      "instanceId": "0199c0e2-0a11-7c3d-9e5f-1b2a3c4d5e6f",
      "permissionProfileId": "0199c0e1-9a00-7b44-9d10-3f2e1d0c9b8a",
      "accessMode": "full-access",
      "model": { "model": "claude-opus-4-1", "options": { "effort": "high", "thinking": true } },
      "disallowedTools": ["edit"],
      "unenforced": [],
      "createdAt": "2026-10-01T12:00:00.000Z",
      "updatedAt": "2026-10-12T18:30:15.250Z",
      "heartbeat": {
        "enabled": true,
        "schedule": "0 7-23 * * *",
        "timezone": "Europe/Amsterdam",
        "prompt": "This is a scheduled heartbeat. Check on anything you are tracking and only speak up if it matters.",
        "target": "web"
      },
      "rotation": {
        "contextFraction": 0.7,
        "maxContextTokens": 200000,
        "dailyAt": "04:00",
        "timezone": "Europe/Amsterdam"
      },
      "reply": "turn-end",
      "mainConversationId": "0199d3a1-0f10-7a02-b3c4-d5e6f7a8b9c0"
    }
  ]
}
```

`Assistant` fields. The first eleven are the `Agent` fields (`agent.ts:56-73`); the rest come from `assistant.ts:89-101`.

| Field | Type | Null / absent |
|---|---|---|
| `id` | Id | - |
| `name` | string 1..128 | - |
| `systemPrompt` | string 1..65536 | - |
| `instanceId` | Id (the provider instance the agent runs on) | - |
| `permissionProfileId` | Id | - |
| `accessMode` | enum `"approval-required"` \| `"auto-accept-edits"` \| `"auto"` \| `"full-access"` (`packages/protocol/src/sessions.ts:30-35`) | - |
| `model` | `ModelSelection` `{ model: string 1..512, options: { [key: string]: string \| boolean } }` (`sessions.ts:98-101`) | `NullOr`. `null` means the instance's default model |
| `disallowedTools` | array of strings. The known tool families are `"edit"`, `"write"`, `"shell"`, `"web-search"` and `"web-fetch"` (`sessions.ts:111`); keep unknown values | - |
| `unenforced` | array of the literal `"disallowedTools"`: the settings the agent's provider cannot enforce. It is empty when all are enforced | - |
| `createdAt`, `updatedAt` | Timestamp | - |
| `heartbeat.enabled` | boolean | - |
| `heartbeat.schedule` | 5-field cron string | - |
| `heartbeat.timezone` | IANA zone string, 1..64 | `optionalKey`: **absent** means the controller's zone |
| `heartbeat.prompt` | string 1..65536 | - |
| `heartbeat.target` | literal `"web"` (the only value today; keep unknown values) | - |
| `rotation.contextFraction` | number in (0, 1] | - |
| `rotation.maxContextTokens` | Int > 0 | - |
| `rotation.dailyAt` | `"HH:MM"`, 24-hour | - |
| `rotation.timezone` | IANA zone | `optionalKey`: **absent** |
| `reply` | enum `"turn-end"` \| `"segments"` (`assistant.ts:81`). `turn-end` means one reply message per turn; `segments` means a message per text segment | - |
| `mainConversationId` | Id of the assistant's web-channel conversation | - |

Defaults for a new assistant (`apps/controller/src/assistants/defaults.ts`):

- heartbeat `{enabled: true, schedule: "0 7-23 * * *", target: "web"}` with no `timezone` key
- rotation `{contextFraction: 0.7, maxContextTokens: 200000, dailyAt: "04:00"}`
- reply `"turn-end"`
- accessMode `"full-access"`
- disallowedTools `["edit"]`

Errors: `unauthenticated`, `forbidden`, `validation` (bad `limit`, `sort` or `cursor`), `internal`.

##### assistant.read

| | |
|---|---|
| Method | `GET` |
| Path | `/api/v1/assistants/{id}` |
| Grant | `agent.read` |
| Source | `operations.ts:500`; `groups/assistant.ts:142-146` |

The path param `id` is an Id. There is no query and no body.

```
GET /api/v1/assistants/0199d3a1-0f00-7e21-8c3b-4a5d6e7f8091
```

Response 200: one `Assistant` object, exactly as in an item of `assistant.query`.

Errors: `unauthenticated`, `forbidden`, `validation` (a malformed id gives "the path is not valid"), `not_found` (no such assistant), `internal`.

##### conversation.query

| | |
|---|---|
| Method | `GET` |
| Path | `/api/v1/conversations` |
| Grant | `agent.read` |
| Source | `operations.ts:546`; schemas `packages/contract/src/groups/conversation.ts:18-41, 105-129` |

The request has no params and no body. Its query is `ConversationFilter` + `pageParams(["createdAt"])`:

| Param | Values |
|---|---|
| `assistantId` | Id, optional. If it is left out, conversations of all assistants are listed. An unknown id gives an empty page, not 404 |
| `limit`, `cursor` | see section 3.1 |
| `sort` | `createdAt[:asc\|desc]`. The default is `createdAt` ascending |

```
GET /api/v1/conversations?assistantId=0199d3a1-0f00-7e21-8c3b-4a5d6e7f8091
```

Response 200:

```json
{
  "items": [
    {
      "id": "0199d3a1-0f10-7a02-b3c4-d5e6f7a8b9c0",
      "assistantId": "0199d3a1-0f00-7e21-8c3b-4a5d6e7f8091",
      "channel": "web",
      "containerKey": null,
      "createdAt": "2026-10-01T12:00:00.000Z"
    }
  ]
}
```

| Field | Type | Null |
|---|---|---|
| `id`, `assistantId` | Id | - |
| `channel` | literal `"web"` (`conversation.ts:18`). It is the only value today; more channels (Discord, Slack) will add values, so keep unknown ones | - |
| `containerKey` | string: the platform container (channel, thread or DM) | `NullOr`: always `null` for `web` |
| `createdAt` | Timestamp | - |

The web client picks the assistant's conversation with `channel === "web"` (`packages/client-core/src/assistants/conversation.ts:15-16`). `Assistant.mainConversationId` names the same conversation directly. `conversation.read` (`GET /api/v1/conversations/{id}`, `operations.ts:547-551`) returns one object of this shape.

Errors: `unauthenticated`, `forbidden`, `validation`, `not_found`, `internal`.

##### conversation.queryMessages

| | |
|---|---|
| Method | `GET` |
| Path | `/api/v1/conversations/{id}/messages` |
| Grant | `agent.read` |
| Source | `operations.ts:552-556`; schemas `groups/conversation.ts:47-91, 105-129`; repository `apps/controller/src/conversations/message-repository.ts:134-160`; handler `apps/controller/src/http/routes.ts:359-369` |

Request:

- The path param `id` is the conversation Id.
- The query is `pageParams(["position"])`:

| Param | Values |
|---|---|
| `limit` | 1..500, default 50 |
| `cursor` | from `nextCursor` |
| `sort` | `position`, `position:asc` or `position:desc`. **The default is `position` descending (newest first)** (`apps/controller/src/conversations/service.ts:98`) |

First page (newest 50, the way the web app asks for it in `apps/web/src/app/queries.ts:642-659`):

```
GET /api/v1/conversations/0199d3a1-0f10-7a02-b3c4-d5e6f7a8b9c0/messages?sort=position:desc&limit=50
```

Response 200:

```json
{
  "items": [
    {
      "id": "0199d3c9-5e21-7f40-9a0b-1c2d3e4f5a6b",
      "conversationId": "0199d3a1-0f10-7a02-b3c4-d5e6f7a8b9c0",
      "containerKey": null,
      "position": 150,
      "senderRole": "assistant",
      "senderLabel": "Ada",
      "text": "Done - the PR is open and CI is green.",
      "sessionId": "0199d3b0-77aa-7c01-8e2f-3a4b5c6d7e8f",
      "turnId": "turn_0199d3c8a1",
      "itemId": "msg_01HZX9K2",
      "actor": "session:0199d3b0-77aa-7c01-8e2f-3a4b5c6d7e8f",
      "createdAt": "2026-10-13T09:41:20.031Z"
    },
    {
      "id": "0199d3c8-a100-7b12-8c3d-4e5f6a7b8c9d",
      "conversationId": "0199d3a1-0f10-7a02-b3c4-d5e6f7a8b9c0",
      "containerKey": null,
      "position": 149,
      "senderRole": "owner",
      "senderLabel": "rogier",
      "text": "Open the PR for the flake fix",
      "sessionId": null,
      "turnId": null,
      "itemId": null,
      "actor": "user",
      "createdAt": "2026-10-13T09:41:07.512Z"
    }
  ],
  "nextCursor": "WyJjb252ZXJzYXRpb24ucXVlcnlNZXNzYWdlcyIsW3siZmllbGQiOiJwb3NpdGlvbiIsImRpcmVjdGlvbiI6ImRlc2MifV0sMTQ5XQ"
}
```

A notice looks like this:

```json
{
  "id": "0199d3d0-0001-7aa0-8b00-112233445566",
  "conversationId": "0199d3a1-0f10-7a02-b3c4-d5e6f7a8b9c0",
  "containerKey": null,
  "position": 151,
  "senderRole": "notice",
  "senderLabel": "Ada",
  "text": "Ada can't be reached: no runner is connected",
  "sessionId": null,
  "turnId": null,
  "itemId": null,
  "actor": "system",
  "createdAt": "2026-10-13T09:45:00.100Z"
}
```

`ConversationMessage` fields (`conversation.ts:52-91`):

| Field | Type | Null |
|---|---|---|
| `id`, `conversationId` | Id | - |
| `containerKey` | string | `NullOr`. `null` on web |
| `position` | Int. Starts at 1 and goes up by exactly 1 per message in the conversation (`message-repository.ts:102-117`) | - |
| `senderRole` | enum `"owner"` \| `"assistant"` \| `"notice"` (`conversation.ts:47`) | - |
| `senderLabel` | string. For an owner message, the username. For a reply or a notice, the assistant's name (`apps/controller/src/assistants/notices.ts:127`) | - |
| `text` | string | - |
| `sessionId` | Id of the session that wrote a reply or notice | `NullOr`. `null` on owner messages and on notices with no session |
| `turnId` | string, the provider's turn id | `NullOr`. Set only on replies |
| `itemId` | string, the provider's item id | `NullOr`. Set only on replies |
| `actor` | string: `"user"`, `"session:<id>"` or `"system"` (notices, `apps/controller/src/assistants/notices.ts`) | - |
| `createdAt` | Timestamp | - |

**Paging recipe (newest first, scrolling back):**

1. Fetch with `sort=position:desc&limit=50` and no cursor. `items` is newest first.
2. To load older messages, repeat **the same `sort`** with `cursor=<nextCursor>`.
3. Stop when `nextCursor` is absent.
4. Show messages in ascending `position` order.
5. Use `position` as the identity for merging. A message with the same `position` is the same message, so the newer copy replaces the old one (`client-core/src/assistants/conversation.ts:52-98`).
6. **Gap check.** When a fresh newest page arrives (after a live push), its oldest message can have `position > heldNewest.position + 1`. Then more messages arrived than one page holds. Discard the held pages and keep only the fresh page, or page down until the gap is filled.

Other notes:

- The cursor encodes the last `position` and is bound to the sort direction. Changing between `asc` and `desc` with a cursor gives 400 `cursor` (section 3.1).
- To catch up forward, use `sort=position:asc` from the start. No "after position N" filter exists.

Errors:

- `unauthenticated`, `forbidden`, `internal`.
- `validation`: a bad `limit` or `sort`, or a cursor that does not match, with path `["cursor"]`.
- `not_found`: the conversation does not exist, message `no such conversation`.

##### conversation.send

| | |
|---|---|
| Method | `POST` |
| Path | `/api/v1/conversations/{id}/messages` |
| Grant | `agent.write`, **user only** |
| Source | `operations.ts:557-561`; schemas `groups/conversation.ts:99, 105-129`; service `apps/controller/src/conversations/service.ts:202-234`; responder `apps/controller/src/assistants/responder.ts` |

Request:

- The path param `id` is the conversation Id. There is no query.
- The body is `ConversationSendInput`:

| Field | Type | Rule |
|---|---|---|
| `text` | string | `Prompt`: 1..65536 chars |

```json
{ "text": "Open the PR for the flake fix" }
```

Response 200: **the stored owner message**, returned synchronously. The assistant's reply is **not** in this response.

```json
{
  "id": "0199d3c8-a100-7b12-8c3d-4e5f6a7b8c9d",
  "conversationId": "0199d3a1-0f10-7a02-b3c4-d5e6f7a8b9c0",
  "containerKey": null,
  "position": 149,
  "senderRole": "owner",
  "senderLabel": "rogier",
  "text": "Open the PR for the flake fix",
  "sessionId": null,
  "turnId": null,
  "itemId": null,
  "actor": "user",
  "createdAt": "2026-10-13T09:41:07.512Z"
}
```

What happens on the controller, all in one transaction:

1. It reads the conversation. If it does not exist, the response is 404 `no such conversation`.
2. It appends the owner message at the next `position`.
3. It hands the text to the conversation's **current session** (the newest session carrying this conversation's id), or starts a new one. Work that reaches a runner is scheduled after the commit.
4. If the assistant cannot take the message because the controller is in an `InvalidState` (for example no runner is connected, or the crash-loop guard holds the session), **the send still succeeds**. The owner message is kept, and a `notice` message `<name> can't be reached: <why>` is appended right after it.
5. Any other failure while placing the message gives 500 `internal` with message `the assistant could not take the message`, and the owner message is rolled back.

**How the reply arrives.** The reply arrives asynchronously, as new `ConversationMessage`s with `senderRole: "assistant"`:

- `reply: "turn-end"` produces one message when the turn ends.
- `reply: "segments"` produces a message per text segment.

The client learns about it through the live socket: subscribe to the mutable topic **`conversation`**. A message appended to a conversation pushes:

```json
{ "_tag": "invalidate", "ids": ["0199d3a1-0f10-7a02-b3c4-d5e6f7a8b9c0"], "kind": "updated" }
```

- `ids` holds the **conversation** id (`apps/controller/src/conversations/conversation-messages.ts:82-87`). On that push, re-read the newest page of `conversation.queryMessages` and merge by `position`.
- A conversation that is created or deleted pushes `kind: "created"` / `"deleted"`.
- The first message on every subscription is `{"_tag":"invalidate","ids":[],"kind":"updated"}`, meaning "everything may have changed". Refetch.
- An interrupted turn produces a notice `<name> was interrupted: <reason>`, for example `its session crashed` or `its runner restarted`.

Optional extras the web app also uses:

- **Typing and working state.** Subscribe to `session` as well. Its pushes carry `conversationIds: { "<sessionId>": "<conversationId>" | null }`. Re-read the current session (`session.query` with `conversationId=<id>&sort=createdAt:desc&limit=1`, `apps/web/src/app/queries.ts:670-679`) when a pushed session belongs to this conversation. See the sessions part.
- **Token streaming.** Subscribe to `session:<sessionId>:tap` (ephemeral deltas) and `session:<sessionId>:stream` (durable transcript). The web conversation screen does **not** use these; it subscribes only to `assistant`, `conversation` and `session` (`apps/web/src/screens/assistant/conversation-screen.tsx:70-72`).

Errors:

- `unauthenticated`, `internal`, plus the middleware's `controller_sealed` and `promotion_in_progress` (409 while a promotion is in progress).
- `forbidden`: a session caller gets 403 with `details.grant = "agent.write"`, message `conversation.send records the message as the owner's; only the user can send it`.
- `validation`: an empty or too-long `text` gives "the request body is not valid".
- `not_found`.

---

#### 6. Concepts (GLOSSARY.md words)

- **Assistant**: an agent with persistent memory, oriented toward delegating work. It is reachable through channel bindings and directly in the app. Different personas are different assistants.
- **Conversation**: one continuous exchange with an assistant inside one platform container. On the web channel, each assistant has exactly one conversation (`mainConversationId`, `channel: "web"`, `containerKey: null`).
  - Each conversation has its own session lineage: the sessions that carry its id. The newest of them is the current session.
  - Conversations are never merged.
- **Conversation Message**: one line of a conversation, stored in `position` order, with the sender's role (`owner`, `assistant` or `notice`) and label.
  - The owner's words reach the assistant only as a conversation message.
  - A message is input to the assistant, never an event.
- **Notice**: a conversation message the system writes, in exactly two forms:
  - `<name> was interrupted: <reason>`
  - `<name> can't be reached: <why>`

  It is not a Notification.
- **Heartbeat**: the assistant's recurring scheduled wake. Its output lands in the conversation like any reply. It is silent if it has nothing to say.
- **Rotation**: retiring the conversation's live session into memory and continuing in a fresh one. The conversation and its messages stay. Only the current session changes.
- **Idle unload**: the conversation's session process stops after 15 idle minutes. The app shows the assistant as "asleep". The next `conversation.send` resumes the session; the client does nothing special.
- **Live topics**: `assistant`, `conversation` and `session` are mutable topics. A push carries the changed ids, and the client refetches those records over HTTP (`packages/contract/src/groups/live.ts:57-74, 208-239`).

---

#### 7. Ambiguities and things not determined

1. **Validation issue messages for schema failures.** The `issues[].message` text for a decode failure comes from Effect's schema formatter, for example the wording of a length failure. It was not captured from a live run. The example in section 1.2 is illustrative. Show `issues[].message` to the user as is, and never parse it. The project's own messages, such as `Enter your username.`, are exact.
2. **All issues or only the first.** `listDecodeIssues` flattens the whole issue tree (`errors.ts:371-376`). Whether HttpApi's decode stops at the first failure (Effect's default `errors: "first"`) was not verified, so expect one issue or several.
3. **Token expiry.** No operation returns the rolled-forward expiry of a login token. Treat 401 as "log in again". Prefer an API key for a device that stays signed in.
4. **`apiKey.create` returns 200**, not 201. This looks unintended, but it is the behaviour, and `controller.createPromotionToken` does use 201. Accept any 2xx.
5. **`limit` in exponent form** (`limit=1e2`). Whether the string-tree number decoder accepts it depends on Effect's finite-number pattern. It was not verified. Send plain digits.
6. **`unenforced`** is declared as an array of the literal `"disallowedTools"`. That is the only value today, but it is an enum that may grow, so keep unknown values.
7. **The `ws` `hello` framing** (Effect RPC JSON messages over the socket, request ids, stream chunks, ping) is out of scope for this part. `hello` declares `v` as a `Schema.Number` without a finite check, so in theory a non-finite value would encode as a string; a client always sends `1`.
8. **`Accept` header.** The server does not check it. CORS is irrelevant to a native client.
9. **`conversation.query` with no `assistantId`** lists every assistant's conversations. Whether that filter should be required was not looked into. The client should always pass it.


### A2 - HTTP wire reference: sessions, transcripts, inputs, approvals, permissions, notifications

Source of truth: `packages/contract` (public API, Effect Schema) and `packages/protocol` (shared shapes such as `ProviderEvent`). All paths below are relative to the repository root. Line numbers are from commit `738cdb2b1` on `main`.

#### 0. Conventions

The conventions in A1 sections 1-3 apply here unchanged: base path, auth, the error envelope and its status table, ids, `Timestamp`, `NullOr` against `optionalKey`, query-string encoding and pagination. One rule matters more in this part:

- **Unknown keys in a request body.** A payload built with `closedStruct` (every `session.*` payload) **refuses** unknown keys with `validation`. A plain `Schema.Struct` payload (`permission.decide`, `notification.act`) **ignores** them silently (`packages/contract/src/strings.ts` and the groups). So never send extra keys.
- **Unknown keys in a response.** Records grow over time; decode with `ignoreUnknownKeys = true`.

---

#### 1. Shared records

##### 1.1 `Session` (`packages/contract/src/groups/session.ts:153-273`)

| Field | Type | Absent / null |
|---|---|---|
| `id` | Id | always |
| `title` | String, at most 80 chars | always |
| `status` | `SessionStatus` | always |
| `resumable` | Boolean (computed on read) | always |
| `resumeHeld` | Boolean (crash-loop guard: true means automatic resume is held back) | always |
| `permissionProfileId` | Id | always |
| `agentId` | Id | **nullable**; `null` = this session is a Thread |
| `conversationId` | Id | nullable; set for an assistant's session |
| `runId` | Id | nullable; set for a workflow run's session |
| `stepId` | String | nullable |
| `instanceId` | Id | always (provider instance) |
| `runnerId` | Id | always |
| `workspaceId` | Id | nullable |
| `projectId` | Id | nullable |
| `requestedAccessMode` | `AccessMode` | always |
| `accessMode` | `AccessMode` (effective; may differ from requested, the fallback is surfaced) | always |
| `nativeSessionId` | String | nullable (provider's own id) |
| `modelSelection` | `{ model: Fact, options: { [Fact]: string \| boolean } }` | always |
| `parentSessionId` | Id | nullable |
| `openRequests` | `SessionRequest[]`, oldest first | always (may be `[]`) |
| `openPermissionRequests` | `PermissionRequest[]`, oldest first | always (may be `[]`) |
| `usage` | `Usage` | **optional** (absent) |
| `usageReport` | `UsageReport` | optional |
| `toolCalls` | Int >= 0 | always |
| `createdAt` | Timestamp | always |
| `startedAt` | Timestamp | nullable |
| `exitedAt` | Timestamp | nullable |
| `lastActivityAt` | Timestamp | always |
| `unenforced` | Array of literal `"disallowedTools"` (`packages/contract/src/groups/agent.ts:52`) | always (may be `[]`) |

Enums:

| Enum | Values | Source |
|---|---|---|
| `SessionStatus` | `queued`, `starting`, `idle`, `busy`, `exited` | `session.ts:129` |
| `AccessMode` | `approval-required`, `auto-accept-edits`, `auto`, `full-access` | `packages/protocol/src/sessions.ts:30` |

`SessionRequest` (`session.ts:67-74`) = one `OpenRequest` (section 1.3) plus:

| Field | Type | Absent / null |
|---|---|---|
| `subagentId` | `SubagentId` (a Fact with no `:`) | optional; absent = the session's own agent asked |
| `subagentName` | String: the subagent's `description`, else its `agentType` | optional; absent for the main agent |

Example (a Thread, busy, with one approval and one question open):

```json
{
  "id": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e",
  "title": "Fix flaky upgrade test",
  "status": "busy",
  "resumable": false,
  "resumeHeld": false,
  "permissionProfileId": "01928f00-0000-7000-8000-000000000001",
  "agentId": null,
  "conversationId": null,
  "runId": null,
  "stepId": null,
  "instanceId": "01928f00-0000-7000-8000-0000000000c1",
  "runnerId": "01928f00-0000-7000-8000-0000000000r1",
  "workspaceId": "01928f3a-7c00-7000-8000-00000000ws01",
  "projectId": "01928f00-0000-7000-8000-0000000000p1",
  "requestedAccessMode": "approval-required",
  "accessMode": "approval-required",
  "nativeSessionId": "5f0c1e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
  "modelSelection": { "model": "claude-opus-4-5", "options": { "effort": "high", "fast": false } },
  "parentSessionId": null,
  "openRequests": [
    {
      "requestId": "toolu_01AbCdEf",
      "itemId": "toolu_01AbCdEf",
      "kind": "command_approval",
      "detail": { "command": "pnpm test e2e/upgrade.test.ts" },
      "decisions": ["allow", "allow_always", "deny", "cancel"]
    },
    {
      "requestId": "q_7",
      "itemId": "toolu_01XyZ",
      "kind": "question",
      "detail": {
        "questions": [
          {
            "question": "Which database should the fixture use?",
            "header": "Database",
            "options": [
              { "label": "Edge build", "description": "Fill it with the previous edge binary" },
              { "label": "Fresh", "description": "Start from an empty database" }
            ],
            "multiSelect": false
          }
        ]
      },
      "subagentId": "agent_a1b2",
      "subagentName": "Investigate fixture"
    }
  ],
  "openPermissionRequests": [],
  "usage": { "inputTokens": 48211, "outputTokens": 3120, "cacheReadTokens": 40100, "cacheWriteTokens": 2050, "costUsd": 0.4123 },
  "usageReport": { "status": "complete", "counts": { "inputTokens": 48211, "outputTokens": 3120 } },
  "toolCalls": 17,
  "createdAt": "2026-10-12T08:01:12.345Z",
  "startedAt": "2026-10-12T08:01:13.002Z",
  "exitedAt": null,
  "lastActivityAt": "2026-10-12T08:14:55.910Z",
  "unenforced": []
}
```

Ids above that are not hex are placeholders for readability; real ids are always UUIDv7 hex.

##### 1.2 Session status state machine

Meaning of each status (`session.ts:129-142` docstrings):

| Status | Meaning |
|---|---|
| `queued` | Placement accepted, but the runner is full or unreachable. Waits. |
| `starting` | Start frame sent to the runner; no `session.started` yet. |
| `idle` | Process running, no turn in progress. Input opens a new turn. |
| `busy` | A turn is running. Input queues (default) or steers (`steer: true`). |
| `exited` | Process is gone. If `resumable: true`, the next input resumes it **in place, same id**. If `resumable: false`, it is settled for good. |

```
          spawn
            |
            v
   +----> queued ----> starting ----> idle <----> busy
   |                       |           |           |
   |                       +-----------+-----------+--> exited
   |                                                       |
   +------------- input to an exited, resumable session ---+
                  (resume in place; status goes back through starting)
```

- `LIVE_SESSION_STATUSES` = all except `exited` (`session.ts:142`).
- Client helpers (`packages/client-core/src/threads/status.ts`): "working" = `busy | starting | queued`; "settled" = `status == "exited" && !resumable`.
- Exit reason is not on the record; it is in the transcript's `session.exited` event (`ExitReason` below).

##### 1.3 `OpenRequest` (approval or question) (`packages/protocol/src/sessions.ts:380-494`)

Common to all five kinds: `requestId: Fact`, `itemId: Fact`, `kind`, `detail`.

| `kind` | `detail` | `decisions` |
|---|---|---|
| `command_approval` | `{ "command": string }` (line 387) | non-empty `ApprovalDecision[]` |
| `file_change_approval` | `{ "paths": [Fact, ...] }` | non-empty `ApprovalDecision[]` |
| `file_read_approval` | `{ "paths": [Fact, ...] }` | non-empty `ApprovalDecision[]` |
| `tool_approval` | `{ "toolName": string }` | non-empty `ApprovalDecision[]` |
| `question` (line 427) | `{ "questions": [Question, ...] }` (non-empty) | **no `decisions` key** |

`ApprovalDecision` (`sessions.ts:348`): `allow`, `allow_always`, `deny`, `cancel`. UI labels (`packages/client-core/src/approval-answers.ts`): "Allow", "Allow always", "Deny", "Cancel". Show only the values in `decisions`; a provider may offer fewer than four.

`Question` object:

| Field | Type | Absent / null |
|---|---|---|
| `question` | String | always |
| `header` | String (short chip; also the **key** in the answer map) | always |
| `options` | `[{ "label": string, "description": string }]` | always (may be `[]`: free text only) |
| `multiSelect` | Boolean | always |
| `secret` | literal `true` | optional; present only when the answer must be masked |

##### 1.4 `PermissionRequest` (`packages/contract/src/groups/permission.ts:74-80`)

```json
{
  "id": "01928f40-1111-7aaa-8bbb-ccccdddd0001",
  "grant": "connection.write",
  "reason": "I need to create a GitHub connection to open the PR.",
  "operation": { "op": "connection.create", "input": { "type": "github", "name": "work" } },
  "createdAt": "2026-10-12T08:20:00.000Z"
}
```

| Field | Type | Absent / null |
|---|---|---|
| `id` | Id | always |
| `grant` | Grant string `<family>.<verb>` (`packages/contract/src/grants.ts`) | always |
| `reason` | String (1..2000 at creation) | always |
| `operation` | `BoundOperation` `{ op: string, connectionId?: Id, input: any JSON }` (`notification.ts:236`) | optional |
| `createdAt` | Timestamp | always |

##### 1.5 `Usage` / `UsageReport` (`packages/protocol/src/sessions.ts:532, 547`)

```json
{ "inputTokens": 1200, "outputTokens": 340, "cacheReadTokens": 800, "cacheWriteTokens": 0, "costUsd": 0.0123 }
```

`cacheReadTokens`, `cacheWriteTokens`, `costUsd` are optional. `UsageReport` = `{ "status": "complete" | "incomplete", "counts": Usage }`.

---

#### 2. Operations

##### session.query

| Method | Path | Grant | Source |
|---|---|---|---|
| GET | `/api/v1/sessions` | `session.read` | `operations.ts:563`; schema `session.ts:634-651` |

Query params (`SessionFilter`, `session.ts:634-647`, plus `pageParams(["createdAt"])`):

| Param | Type | Notes |
|---|---|---|
| `status` | `SessionStatus`, repeatable | `status=idle&status=busy` |
| `runnerId` | Id | |
| `agentId` | Id | |
| `permissionProfileId` | Id | |
| `conversationId` | Id | an assistant conversation's sessions |
| `runId` | Id | a workflow run's sessions |
| `thread` | Boolean | `true` = only Threads (`agentId == null`); `false` = only non-Threads |
| `limit`, `cursor` | | see pagination |
| `sort` | `createdAt[:asc\|desc]` | **default `createdAt:desc` (newest first)** (`apps/controller/src/sessions/service.ts:400-444`) |

All filters AND together. `agentId` together with `thread` is refused: `validation` at path `["thread"]` (`apps/controller/src/sessions/service.ts` ~1397-1414).

Errors: `unauthenticated`, `forbidden`, `validation`, `internal`.

How the desktop lists (`apps/desktop/src/renderer/app/queries.ts`):

| Use | Request |
|---|---|
| All Threads (Office sidebar) (`threadsQuery`, 168-174) | `GET /api/v1/sessions?thread=true&limit=500` then follow `nextCursor` until absent |
| Live agent/run sessions (`liveAgentSessionsQuery`, 185-192) | `GET /api/v1/sessions?thread=false&status=queued&status=starting&status=idle&status=busy&limit=500`, all pages |
| An assistant's current session (`currentConversationSessionQuery`, 797-808) | `GET /api/v1/sessions?conversationId=<id>&sort=createdAt:desc&limit=1` |
| A run's sessions | `GET /api/v1/sessions?runId=<id>` |

The Office screen (`apps/desktop/src/renderer/office/office-screen.tsx:64`, route `_shell/office.tsx`, search params `session` or `assistant`) combines: the Threads list above, the assistants (assistant query plus each one's current conversation session), projects, workspaces and runners.

Response:

```json
{
  "items": [ { "id": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e", "title": "Fix flaky upgrade test", "status": "idle", "...": "full Session record, section 1.1" } ],
  "nextCursor": "eyJrIjpbIjIwMjYtMTAtMTJUMDg6MDE6MTIuMzQ1WiIsIjAxOTI4ZjNhIl19"
}
```

##### session.read

| Method | Path | Grant | Source |
|---|---|---|---|
| GET | `/api/v1/sessions/{id}` | `session.read` | `operations.ts:564`; `session.ts:651-719` |

Path: `id` (Id). No query, no body. Response: one `Session` (section 1.1). Errors: `unauthenticated`, `forbidden`, `validation`, `not_found`, `internal`.

##### transcript.read

| Method | Path | Grant | Source |
|---|---|---|---|
| GET | `/api/v1/sessions/{id}/transcript` | `session.read` | `operations.ts:~634-638`; `packages/contract/src/groups/transcript.ts:38-102` |

Query:

| Param | Type | Notes |
|---|---|---|
| `subagentId` | `SubagentId` | absent = the session's own agent's transcript. A subagent's events are never in the main transcript; read each subagent separately. |
| `limit`, `cursor` | | A cursor from one agent's transcript is refused on another's. |
| `sort` | `position[:asc\|desc]` | **default `asc`** (oldest first) |

Response: `page(TranscriptRow)`. A row (`transcript.ts:38-42`):

| Field | Type | Notes |
|---|---|---|
| `position` | Int | per-session monotonic counter; rows are ordered by it |
| `at` | **plain String** (ISO, runner clock) | not Timestamp-validated, not monotonic across machines |
| `event` | `ProviderEvent` | verbatim from the runner, except runs of `content.delta` are coalesced into one row |

Paging recipes used by the desktop (`queries.ts`):

- Full transcript (`transcriptQuery`, ~1217): `GET .../transcript?limit=500` (+ `&subagentId=...`) following `nextCursor`.
- Find the running turn (`runningTurnQuery`): `GET .../transcript?sort=position:desc&limit=500`, walk back until a `turn.started`.

Errors: `unauthenticated`, `forbidden`, `validation`, `not_found`, `internal`.

```json
{
  "items": [
    { "position": 1, "at": "2026-10-12T08:01:13.002Z", "event": { "_tag": "session.started", "eventId": "e1", "sessionId": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e", "at": "2026-10-12T08:01:13.002Z" } },
    { "position": 2, "at": "2026-10-12T08:01:13.100Z", "event": { "_tag": "turn.started", "eventId": "e2", "sessionId": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e", "at": "2026-10-12T08:01:13.100Z", "turnId": "t1", "model": "claude-opus-4-5" } }
  ],
  "nextCursor": "eyJwIjoyfQ"
}
```

###### 2.1 `ProviderEvent` catalogue (`packages/protocol/src/sessions.ts:559-786`)

Every event carries (`sessions.ts:559-569`):

| Field | Type | Absent / null |
|---|---|---|
| `_tag` | discriminator (table below) | always |
| `eventId` | String | always |
| `sessionId` | Id | always |
| `at` | String (ISO, runner clock) | always |
| `providerRefs` | `{ [Fact]: string }` | optional |
| `raw` | `{ "source": Fact, "payload": any JSON }` | optional; can be large, a client should not need it |

"`subagentId?`" below = optional attribution; absent means the session's own agent.

| `_tag` | Extra fields |
|---|---|
| `session.started` | none |
| `session.exited` | `reason: ExitReason`, `message?: string` |
| `subagent.started` | `subagentId`, `parentSubagentId?`, `itemId?`, `description?`, `agentType?` |
| `turn.started` | `subagentId?`, `turnId`, `model?` |
| `turn.completed` | `subagentId?`, `turnId`, `state: TurnState`, `usage?: Usage`, `costUsd?: number`, `error?: string`, `structuredResult?` |
| `item.started` | `subagentId?`, `turnId`, `itemId`, `kind: ItemKind`, `detail?: any JSON` |
| `item.completed` | `subagentId?`, `turnId`, `itemId`, `kind: ItemKind`, `detail?: any JSON`, `status: ItemStatus` |
| `content.delta` | `subagentId?`, `turnId`, `itemId`, `streamKind: StreamKind`, `delta: string` |
| `session.usage.updated` | either `{ usage: Usage }` or `{ usageReport: { status: "incomplete", counts: Usage } }` |
| `runtime.warning` | `turnId?`, `message: string` |
| `runtime.error` | `turnId?`, `class: Fact`, `message?: string` |
| `request.opened` | `request: OpenRequest` (section 1.3) |
| `request.resolved` | `requestId: Fact` and either `decision: ApprovalDecision` or `answers: QuestionAnswers` |

Enums:

| Enum | Values | Source |
|---|---|---|
| `ExitReason` | `stopped`, `process_exit`, `idle_unload`, `runner_restart`, `crash`, `inactivity_timeout`, `absolute_timeout`, `workspace_failed` | `sessions.ts:294` |
| `TurnState` | `completed`, `failed`, `interrupted` | `sessions.ts:309` |
| `ItemKind` | `user_message`, `assistant_message`, `reasoning`, `command_execution`, `file_change`, `file_read`, `file_search`, `tool_call`, `web_search`, `subagent`, `plan`, `context_compaction`, `error`, `unknown` | `sessions.ts:314` |
| `ItemStatus` | `completed`, `failed`, `declined` | `sessions.ts:339` |
| `StreamKind` | `assistant_text`, `reasoning_text`, `command_output` | `sessions.ts:515` |
| `StructuredResult` | `{ "outcome": "ok", "value": any }` or `{ "outcome": "schema-failure", "reason": string }` | `sessions.ts` (re-exported `transcript.ts:52`) |

Event examples (envelope fields `eventId`, `sessionId`, `at` shown once, elided after):

```json
{ "_tag": "session.exited", "eventId": "e90", "sessionId": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e", "at": "2026-10-12T09:00:00.000Z", "reason": "idle_unload" }
```
```json
{ "_tag": "subagent.started", "subagentId": "agent_a1b2", "itemId": "toolu_01Task", "description": "Investigate fixture", "agentType": "general-purpose" }
```
```json
{ "_tag": "turn.completed", "turnId": "t1", "state": "completed", "usage": { "inputTokens": 48211, "outputTokens": 3120 }, "costUsd": 0.41 }
```
```json
{ "_tag": "turn.completed", "turnId": "t2", "state": "failed", "error": "Overloaded" }
```
```json
{ "_tag": "content.delta", "turnId": "t1", "itemId": "msg_01", "streamKind": "assistant_text", "delta": "The upgrade test fails because " }
```
```json
{ "_tag": "session.usage.updated", "usage": { "inputTokens": 50000, "outputTokens": 3500, "costUsd": 0.45 } }
```
```json
{ "_tag": "runtime.warning", "turnId": "t1", "message": "Access mode auto is not supported; running as approval-required." }
```
```json
{ "_tag": "runtime.error", "turnId": "t1", "class": "rate_limit", "message": "429 from provider" }
```
```json
{ "_tag": "request.opened", "request": { "requestId": "toolu_01AbCdEf", "itemId": "toolu_01AbCdEf", "kind": "command_approval", "detail": { "command": "pnpm test" }, "decisions": ["allow", "allow_always", "deny", "cancel"] } }
```
```json
{ "_tag": "request.resolved", "requestId": "toolu_01AbCdEf", "decision": "allow" }
```
```json
{ "_tag": "request.resolved", "requestId": "q_7", "answers": { "Database": "Edge build" } }
```

###### 2.2 Item kinds and their `detail` (with examples)

`detail` is typed as free JSON in the protocol. The shapes below are what the runner adapters actually emit today (Claude: `apps/runner/src/providers/claude-code-normalize.ts`; Codex: `apps/runner/src/providers/codex/normalize.ts:175-245`; user messages: `apps/runner/src/providers/events.ts` `buildUserMessage`). Spec: `docs/spec/06-providers.md` §6.3-6.6. Parse defensively: every key is optional to a client.

Text of `assistant_message` and `reasoning` never sits in `detail`; it arrives through `content.delta` rows with the same `itemId` (`assistant_text` / `reasoning_text`). Command output arrives as `command_output` deltas.

| `kind` | `item.started.detail` | `item.completed.detail` |
|---|---|---|
| `user_message` | `{ text, steered?: true, attachments?: [{id, name, mimeType, sizeBytes}], senderSessionId? }`; a subagent's brief is `{ text }` | same |
| `assistant_message` | none | none |
| `reasoning` | none | none |
| `command_execution` | Claude `{ name: "Bash", input: {...} }`; Codex `{ command }` | Claude `{ content? }` |
| `file_change` | Claude `{ name, input }`; Codex `{ path }` or `{ path, paths }` | Claude `{ content? }` |
| `file_read` | Claude `{ name, input, path? }`; Codex (image view) `{ path }` | Claude `{ content? }` |
| `file_search` | Claude `{ name, input, pattern? }` | Claude `{ content? }` |
| `tool_call` | Claude `{ name, input, kind: "mcp"\|"native", subagentIds? }`; Codex `{ name: "server/tool", kind: "mcp" }` or `{ name, kind: "native" }` | Claude `{ content? }` |
| `web_search` | Claude `{ name, input }`; Codex `{ description: <query> }` | Claude `{ content? }` |
| `subagent` | Claude `{ name, input }`; Codex `{ name, subagentIds?, description? }` | Claude `{ content? }` |
| `plan` | none (text via deltas / provider) | none |
| `context_compaction` | Claude `{ trigger, preTokens, postTokens }`; Codex none | same |
| `error` | Claude `{ class }` | same |
| `unknown` | none | none |

Tool result `content` (Claude, on `item.completed`): a string cut to 4096 chars (`MAX_MESSAGE_LENGTH`, `sessions.ts:44`), or an array of content blocks where an image block is replaced by a `ToolResultImage` (`packages/protocol/src/attachments.ts:103-106`):

```json
{ "type": "image", "attachment": { "id": "01928f50-aaaa-7bbb-8ccc-ddddeeee0001", "mimeType": "image/png", "sizeBytes": 48213 } }
```
```json
{ "type": "image", "unavailable": "image larger than 10 MiB" }
```

`mimeType` is one of `image/png`, `image/jpeg`, `image/gif`, `image/webp` (`attachments.ts:28`). Bytes via `attachment.readContent` with that id. A failed tool (`is_error`) gives `status: "failed"`; a denied approval gives `status: "declined"`.

Examples:

```json
{ "_tag": "item.started", "turnId": "t1", "itemId": "u1", "kind": "user_message", "detail": { "text": "Why does the upgrade test fail?", "attachments": [ { "id": "01928f50-aaaa-7bbb-8ccc-ddddeeee0002", "name": "screenshot.png", "mimeType": "image/png", "sizeBytes": 120334 } ] } }
```
```json
{ "_tag": "item.completed", "turnId": "t1", "itemId": "u2", "kind": "user_message", "status": "completed", "detail": { "text": "also check the fixture", "steered": true } }
```
```json
{ "_tag": "item.started", "turnId": "t1", "itemId": "msg_01", "kind": "assistant_message" }
```
```json
{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Bash", "kind": "command_execution", "detail": { "name": "Bash", "input": { "command": "pnpm test e2e/upgrade.test.ts", "description": "Run the upgrade test" } } }
```
```json
{ "_tag": "item.completed", "turnId": "t1", "itemId": "toolu_01Bash", "kind": "command_execution", "status": "failed", "detail": { "content": "FAIL e2e/upgrade.test.ts > migrates providers\nExpected 3, received 2" } }
```
```json
{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Edit", "kind": "file_change", "detail": { "name": "Edit", "input": { "file_path": "/repo/e2e/upgrade.test.ts", "old_string": "3", "new_string": "2" } } }
```
```json
{ "_tag": "item.completed", "turnId": "t1", "itemId": "toolu_01Edit", "kind": "file_change", "status": "declined" }
```
```json
{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Read", "kind": "file_read", "detail": { "name": "Read", "input": { "file_path": "/repo/e2e/upgrade.test.ts" }, "path": "/repo/e2e/upgrade.test.ts" } }
```
```json
{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Grep", "kind": "file_search", "detail": { "name": "Grep", "input": { "pattern": "MIGRATIONS" }, "pattern": "MIGRATIONS" } }
```
```json
{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Mcp", "kind": "tool_call", "detail": { "name": "mcp__github__create_pull_request", "input": { "title": "Fix upgrade test" }, "kind": "mcp" } }
```
```json
{ "_tag": "item.started", "turnId": "t1", "itemId": "ws_1", "kind": "web_search", "detail": { "description": "effect schema optionalKey" } }
```
```json
{ "_tag": "item.started", "turnId": "t1", "itemId": "toolu_01Task", "kind": "subagent", "detail": { "name": "Task", "input": { "description": "Investigate fixture", "prompt": "Look at e2e/upgrade.test.ts", "subagent_type": "general-purpose" } } }
```
```json
{ "_tag": "item.started", "turnId": "t1", "itemId": "plan_1", "kind": "plan" }
```
```json
{ "_tag": "item.completed", "turnId": "t1", "itemId": "cc_1", "kind": "context_compaction", "status": "completed", "detail": { "trigger": "auto", "preTokens": 180000, "postTokens": 22000 } }
```
```json
{ "_tag": "item.completed", "turnId": "t1", "itemId": "err_1", "kind": "error", "status": "failed", "detail": { "class": "api_error" } }
```
```json
{ "_tag": "item.started", "turnId": "t1", "itemId": "x_1", "kind": "unknown" }
```

###### 2.3 `Subagent` record (`session.querySubagents`, `GET /api/v1/sessions/{id}/subagents`, `operations.ts:565-569`; schema `session.ts:287-334`)

Paged, default `asc`. Use it to list the subagent ids to pass as `transcript.read?subagentId=`.

```json
{
  "id": "agent_a1b2",
  "sessionId": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e",
  "itemId": "toolu_01Task",
  "description": "Investigate fixture",
  "agentType": "general-purpose",
  "model": "claude-sonnet-4-5",
  "status": "completed",
  "toolCalls": 6,
  "activity": "Reading e2e/upgrade.test.ts",
  "result": "The fixture misses the provider rows.",
  "usage": { "inputTokens": 9000, "outputTokens": 800 },
  "startedAt": "2026-10-12T08:05:00.000Z",
  "endedAt": "2026-10-12T08:07:31.000Z"
}
```

`status`: `running`, `completed`, `failed`, `stopped`. Optional: `parentSubagentId`, `itemId`, `description`, `agentType`, `model`, `activity`, `result`, `usage`, `usageReport`, `endedAt`. `startedAt`/`endedAt` are plain strings (runner clock).

##### session.input

| Method | Path | Grant | Source |
|---|---|---|---|
| POST | `/api/v1/sessions/{id}/input` | `session.steer` | `operations.ts:576-581` (usable in `notification.answer`); payload `session.ts:508-511`, outcome `session.ts:537-540` |

Body (`SessionInputPayload`, closed):

| Field | Type | Absent / null |
|---|---|---|
| `text` | String 0..65536 chars (`MAX_PROMPT_LENGTH`, `session.ts:83`) | required |
| `attachments` | `Id[]`, at most 10 (`MAX_ATTACHMENTS_PER_INPUT`, `attachment.ts:29`); ids from a prior attachment upload | optional |
| `model` | non-empty String | optional; switches the model from this input on |
| `options` | `{ [Fact]: string \| boolean }` | optional |
| `steer` | Boolean | optional; `true` on a `busy` session folds the input into the running turn; ignored in any other status. Default: queue. |

Empty `text` with no `attachments` is refused: `validation`, path `["text"]`, message `"A prompt needs text or at least one image."` (`refuseEmptyPrompt`, `session.ts:106-117`).

```json
{ "text": "Also check the fixture rows.", "steer": true }
```

Response (`SessionInputOutcome`):

```json
{ "inputId": "01928f60-0000-7aaa-8bbb-000000000001", "result": "steered" }
```

`result`: `opened` (started a new turn), `steered` (folded into the running turn), `queued` (waits for the next turn; see `input.query`). An input to an `exited` + `resumable` session resumes it in place.

Timeout: the controller may wait up to `MAX_INPUT_ANSWER_WAIT` = 10 s (`SESSION_INPUT_DEADLINE`) + 2 min (`ATTACHMENT_DOWNLOAD_TIMEOUT`) = **130 s** (`session.ts:551`, `packages/protocol/src/attachments.ts:70,79`). Set the HTTP read timeout above 130 s.

Errors: `unauthenticated`, `forbidden`, `validation`, `not_found`, `invalid_state` (e.g. settled session, not resumable), `internal`.

##### session.respondToApprovalRequest

| Method | Path | Grant | Source |
|---|---|---|---|
| POST | `/api/v1/sessions/{id}/respond-to-approval-request` | `session.steer` | `operations.ts:587-592` (usable in `notification.answer`); payload `session.ts:561-568` |

Body (closed):

```json
{ "requestId": "toolu_01AbCdEf", "decision": "allow_always" }
```

| Field | Type |
|---|---|
| `requestId` | Fact; an `openRequests[].requestId` whose `kind` ends in `_approval` |
| `decision` | `ApprovalDecision`; must be one of that request's `decisions` |

Response: the updated `Session` (section 1.1); the request is gone from `openRequests`. Errors: `unauthenticated`, `forbidden`, `validation`, `not_found`, `invalid_state` (request no longer open, already answered elsewhere, or session exited), `internal`.

##### session.respondToQuestion

| Method | Path | Grant | Source |
|---|---|---|---|
| POST | `/api/v1/sessions/{id}/respond-to-question` | `session.steer` | `operations.ts:593-597`; payload `session.ts:594-599`; `QuestionAnswers` `packages/protocol/src/sessions.ts:472-485` |

Body (closed):

```json
{
  "requestId": "q_7",
  "answers": {
    "Database": "Edge build",
    "Checks": ["Typecheck", "Lint"],
    "Notes": "Use the October edge build, not September's."
  }
}
```

`answers` rules:

- Keys are the questions' `header` strings.
- Each value is a non-blank string, or a non-empty array of non-blank strings (use the array for `multiSelect`).
- A value can be an option `label` or custom text the user typed.
- At least one key. Total characters at most 16384 (`MAX_ANSWERS_LENGTH`).

A question has no decline. To turn it down, interrupt the asking agent's turn (`POST /api/v1/sessions/{id}/interrupt` with `{ "subagentId": "..." }` or `{}`, `operations.ts:582-586`, `session.ts:347-365`).

Response: the updated `Session`. Errors: as `respondToApprovalRequest`.

##### permission.decide

| Method | Path | Grant | Source |
|---|---|---|---|
| POST | `/api/v1/permissions/requests/{id}/decide` | `permission.write` | `operations.ts:100-105` (usable in `notification.answer`); `packages/contract/src/groups/permission.ts:40, 132-137` |

Path `id` = `PermissionRequest.id` (from `session.openPermissionRequests` or the `core.permission-request` notification's subject `{kind: "permissionRequest", id}`).

Body (plain Struct; extra keys ignored):

```json
{ "outcome": "session" }
```

`outcome` (`PermissionDecisionOutcome`, line 40): `session` ("This session only"), `profile` ("Add to profile"), `deny` ("Deny"). Labels: `packages/client-core/src/permission-answers.ts`.

Response: `{}` (empty object).

Errors: `unauthenticated`, `forbidden`, `validation`, `not_found`, `invalid_state`, `internal`. `invalid_state` when:

- the request was already decided or withdrawn
- the session has ended
- for `session` or `profile`: the session has since moved to another permission profile

##### notification.query

| Method | Path | Grant | Source |
|---|---|---|---|
| GET | `/api/v1/notifications` | `notification.read` | `operations.ts:149-153`; `packages/contract/src/groups/notification.ts:480-500` |

Query:

| Param | Type | Notes |
|---|---|---|
| `kind` | `NotificationKind` (dotted lowercase, at most 128 chars) | e.g. `core.approval` |
| `status` | `open` \| `resolved` | |
| `since` | Timestamp | created at or after |
| `limit`, `cursor` | | |
| `sort` | `createdAt[:asc\|desc]` | **default newest first** |

Example: `GET /api/v1/notifications?status=open&limit=100`.

Response: `page(Notification)`.

`Notification` (`notification.ts:368-393`):

| Field | Type | Absent / null |
|---|---|---|
| `id` | Id | always |
| `kind` | `NotificationKind` | always |
| `title` | String | always |
| `body` | String (Markdown) | optional |
| `producer` | `NotificationProducer` | always |
| `muteKey` | `workflow:<id>` \| `plugin:<id>` \| `assistant:<id>` | optional |
| `subject` | `NotificationSubject[]` | always (may be `[]`) |
| `eventId` | Int >= 1 | optional |
| `actions` | `NotificationAction[]` | always; `[]` for an informational notification |
| `status` | `open` \| `resolved` | always |
| `resolution` | `Resolution` | optional; absent while open, and absent on an informational notification (created already `resolved`) |
| `createdAt` | Timestamp | always |
| `failedBuildCount` | Int | optional (signal build failures) |

There is no read/unread state.

Core kinds (`CORE_NOTIFICATION_KINDS`, `notification.ts:133-143`): `core.approval`, `core.permission-request`, `core.run-failed`, `core.plugin-error`, `core.connection-error`, `core.runner-unreachable`, `core.subscription-condition-error`, `core.trigger-error`, `core.signal-build-failed`. Plugins add their own dotted kinds.

`NotificationProducer` (tagged by `type`, `notification.ts:157`):

```json
{ "type": "core" }
{ "type": "run", "runId": "<Id>", "stepId": "notify-owner" }
{ "type": "plugin", "pluginId": "github" }
{ "type": "session", "sessionId": "<Id>" }
```

`NotificationSubject` (tagged by `kind`, `notification.ts:194-208`):

| `kind` | Other fields |
|---|---|
| `task`, `run`, `session`, `workflow`, `connection`, `runner`, `subscription`, `permissionRequest` | `id: Id` |
| `plugin` | `id: PluginId` (string) |
| `event` | `id: Int >= 1` |
| `signalKind` | `id: String` |
| `trigger` | `workflowId: Id`, `triggerId` |
| `request` | `sessionId: Id`, `requestId: Fact` |

`NotificationAction` (= `BoundAction`, `notification.ts:266`, plus `describeLine`):

| Field | Type | Absent / null |
|---|---|---|
| `id` | `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 chars | always |
| `label` | String | always |
| `description` | String (producer's note) | optional |
| `operation` | `BoundOperation` `{ op, connectionId?, input }` | **nullable**; `null` = closes the notification and runs nothing |
| `primary` | Boolean | optional |
| `field` | `{ name, placeholder }` | optional; Signals only, not on notifications |
| `describeLine` | `[{ "kind": "text" \| "marked", "text": string }]` (`packages/plugin-host/src/contributions.ts:596`) | optional; present only on the actions of an **open** decision. Render `marked` parts emphasised. An action with no operation reads `[{"kind":"text","text":"Does nothing"}]`. |

`Resolution` (`notification.ts:352`):

| Field | Type | Absent / null |
|---|---|---|
| `kind` | `decided` \| `handled` \| `withdrawn` | always |
| `actionId` | String | optional |
| `actor` | `user` \| `system` \| `session:<id>` \| `run:<id>` \| `plugin:<id>` | always |
| `origin` | `web` \| `api` \| `core` \| `connection:<id>` \| `session:<id>` \| `plugin:<id>` | always |
| `conversationId` | Id | optional |
| `reason` | String | optional |
| `at` | Timestamp | always |

Example: an open approval decision, as built by `apps/controller/src/sessions/approval-notification.ts:145-180`.

```json
{
  "id": "01928f70-0000-7aaa-8bbb-000000000001",
  "kind": "core.approval",
  "title": "Run `pnpm test e2e/upgrade.test.ts`?",
  "body": "The session `Fix flaky upgrade test` is waiting for your answer.\n\n```\npnpm test e2e/upgrade.test.ts\n```",
  "producer": { "type": "core" },
  "subject": [
    { "kind": "session", "id": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e" },
    { "kind": "request", "sessionId": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e", "requestId": "toolu_01AbCdEf" }
  ],
  "actions": [
    {
      "id": "allow",
      "label": "Allow",
      "description": "Run this command once.",
      "operation": {
        "op": "session.respondToApprovalRequest",
        "input": { "sessionId": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e", "requestId": "toolu_01AbCdEf", "decision": "allow" }
      },
      "describeLine": [ { "kind": "text", "text": "Answer " }, { "kind": "marked", "text": "Allow" }, { "kind": "text", "text": " in session " }, { "kind": "marked", "text": "Fix flaky upgrade test" } ]
    },
    {
      "id": "allow-always",
      "label": "Allow always",
      "description": "Run it, and allow commands like it from now on.",
      "operation": {
        "op": "session.respondToApprovalRequest",
        "input": { "sessionId": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e", "requestId": "toolu_01AbCdEf", "decision": "allow_always" }
      },
      "describeLine": [ { "kind": "text", "text": "..." } ]
    }
  ],
  "status": "open",
  "createdAt": "2026-10-12T08:14:55.910Z"
}
```

Facts from the builder:

- `title`: command `Run \`<shortened command>\`?`; one path `Change <path>?` / `Read <path>?`; several `Change N files?` / `Read N files?`; tool `Run <toolName>?`.
- `body`: `The session \`<title>\` is waiting for your answer.` (or `A session is waiting for your answer.` when the title is empty), prefixed by `Asked by \`<subagent name>\`` for a subagent's request, then a blank line and the command as a code block or the path list.
- Action `id` per decision (`APPROVAL_ANSWER_IDS`, line 37): `allow` -> `allow`, `allow_always` -> `allow-always`, `deny` -> `deny`, `cancel` -> `cancel`. One action per entry of the request's `decisions`; none is `primary`.
- Bound `input` is `{ sessionId, requestId, decision }` (note: `sessionId`, not the HTTP path name `id`).
- Questions never produce a notification (the builder returns nothing for `kind: "question"`).
- `producer`, the `description` texts and the `describeLine` text in the example are illustrative: the producer is filled by the notifications service, `description` by `describeApprovalAnswer`, and the Describe Line by the core when read. Render them as given; never parse them.

Example: an informational one (already resolved, no resolution, no actions).

```json
{
  "id": "01928f70-0000-7aaa-8bbb-000000000002",
  "kind": "core.run-failed",
  "title": "Run of Bugfix failed",
  "producer": { "type": "core" },
  "muteKey": "workflow:01928f00-0000-7000-8000-0000000000w1",
  "subject": [ { "kind": "run", "id": "01928f00-0000-7000-8000-0000000000x1" } ],
  "actions": [],
  "status": "resolved",
  "createdAt": "2026-10-12T07:30:00.000Z"
}
```

Errors: `unauthenticated`, `forbidden`, `validation`, `internal`.

##### notification.act

| Method | Path | Grant | Source |
|---|---|---|---|
| POST | `/api/v1/notifications/{id}/act` | `notification.write` | `operations.ts:169-173`; `notification.ts:470-472` |

Body (plain Struct; extra keys ignored):

```json
{ "actionId": "allow" }
```

`actionId`: String, at most 64 chars, one of the notification's `actions[].id`.

The server runs the bound operation **as the user** (the caller's own grants must cover it), then resolves the notification with `resolution.kind = "decided"`. An action with `operation: null` just resolves it.

Response: the updated `Notification`.

```json
{ "id": "01928f70-0000-7aaa-8bbb-000000000001", "kind": "core.approval", "status": "resolved", "resolution": { "kind": "decided", "actionId": "allow", "actor": "user", "origin": "api", "at": "2026-10-12T08:15:10.002Z" }, "...": "other fields as above" }
```

Errors: `unauthenticated`, `forbidden`, `validation`, `not_found`, `invalid_state` (already resolved/withdrawn), `conflict`, `cap_exceeded`, `internal`. Because the bound operation's own error is returned unchanged, any error code that operation can return may appear.

##### Waiting on you (derived, no endpoint)

There is **no** server endpoint. The desktop computes it from session records (`packages/client-core/src/waiting.ts`, `apps/desktop/src/renderer/app/waiting.ts`):

1. Fetch Threads: `GET /api/v1/sessions?thread=true&limit=500` (all pages).
2. Fetch each assistant's current session: `GET /api/v1/sessions?conversationId=<id>&sort=createdAt:desc&limit=1`.
3. `listWaiting` = sessions from 1 and 2 where `openRequests` is non-empty, sorted by `lastActivityAt` desc, then `id`.
4. "From runs" (`listWaitingRunSessions`) = sessions from `GET /api/v1/sessions?thread=false&status=queued&status=starting&status=idle&status=busy` (all pages) with `runId != null` and non-empty `openRequests`.
5. A row shows the **oldest** request, `openRequests[0]`. (The approval notification body shows the newest.)
6. Permission requests: `session.openPermissionRequests` (also a `core.permission-request` notification).

One-line question per request (`packages/client-core/src/threads/request-question.ts`, `formatRequestQuestion`):

| `kind` | Line |
|---|---|
| `command_approval` | `Run <first line of command>?` |
| `file_change_approval` | `Change <file name>?`, or `Change N files?` |
| `file_read_approval` | `Read <file name>?`, or the N-files form |
| `tool_approval` | `Run <toolName>?` |
| `question` | the first question's `question` text |

Answer paths:

| What | Where it shows | How to answer |
|---|---|---|
| Approval | session `openRequests` + `core.approval` notification (subject `{kind:"request", sessionId, requestId}`) | `session.respondToApprovalRequest`, or `notification.act` |
| Question | session `openRequests` only, **never** a notification | `session.respondToQuestion` |
| Permission request | session `openPermissionRequests` + `core.permission-request` notification | `permission.decide`, or `notification.act` |

When the request is answered in either place, the other disappears (the notification is resolved/withdrawn; `openRequests` drops it). Re-read the session or notification after acting.

##### input.query (brief)

| Method | Path | Grant | Source |
|---|---|---|---|
| GET | `/api/v1/sessions/{id}/inputs` | `session.read` | `operations.ts:613-617`; `packages/contract/src/groups/input.ts:71-95` |

Query: `limit`, `cursor`, `sort=createdAt[:asc|desc]` (**default asc**). Response `page(Input)`:

```json
{
  "items": [
    {
      "id": "01928f60-0000-7aaa-8bbb-000000000002",
      "sessionId": "01928f3a-7c1e-7b2a-9d4e-3f5a6b7c8d9e",
      "source": "user",
      "actor": "user",
      "text": "Then open a PR.",
      "attachments": [],
      "status": "queued",
      "delivery": null,
      "createdAt": "2026-10-12T08:16:00.000Z",
      "sentAt": null,
      "deliveredAt": null,
      "reason": null
    }
  ]
}
```

| Enum | Values |
|---|---|
| `source` | `user`, `subscription`, `heartbeat`, `reminder` |
| `status` | `queued`, `sent`, `delivered`, `cancelled` |
| `delivery` | nullable: `opened`, `steered` |

`attachments[]`: `{ id, name, mimeType, sizeBytes: Int }`. `actor`: plain String (`user` or `session:<id>`). Nullable: `delivery`, `sentAt`, `deliveredAt`, `reason`.

Related: `PATCH /api/v1/sessions/{id}/inputs/{inputId}` (`{ text, attachments? }`, closed, returns Input), `DELETE .../inputs/{inputId}` (returns Input, cancels), `POST .../inputs/{inputId}/steer` (returns `SessionInputOutcome`). All `session.steer`.

---

#### 3. Vocabulary (from `GLOSSARY.md`)

- **Session**: one run of a provider-backed agent: process, context and transcript. Resumable in place (same id) by the next input while its transcript is on its runner; forking mints a new session. Copies config from an Agent at spawn, or has no Agent and is a Thread.
- **Thread**: a session the user starts and drives by hand, with no Agent behind it (`agentId == null`; `session.query?thread=true`).
- **Subagent**: an agent a session's harness delegated to, inside the same process. Has its own turns and transcript (`transcript.read?subagentId=`). Not a Session: never resumed or forked alone.
- **Request** (approval or question): a provider-held question one agent of a session is parked on. Several can be open at once, answered in any order. An **approval** (`*_approval` kinds) takes one of four `ApprovalDecision`s, never free text, and also raises a `core.approval` notification. A **question** takes structured answers (options or custom text) and has no decline; to refuse, stop the asking agent's turn.
- **Permission Request**: an agent's ask for a grant its permission profile lacks, optionally naming the operation it wanted. Shown as a notification; the user approves for this session, adds it to the profile, or denies (`permission.decide`). Not the same as an approval.
- **Notification**: a persisted message from Hercule about Hercule itself ("run failed", "agent needs a decision"). A decision notification stays `open` until answered anywhere, and is withdrawn when its question stops existing. Nothing else about it changes.
- **Bound Action / Describe Line**: one ready-to-run choice on a decision notification (or Signal), with its operation input frozen; the core writes a Describe Line saying what clicking it does.
- **Signal**: something on Intake because a move is asked of the user (review request, mention, prepared work). Its own record, never a Notification (`GET /api/v1/signals`, grant `signal.read`, `operations.ts:175`; covered by another part).

---

#### 4. Ambiguities and gaps

1. **`detail` is untyped.** The protocol types `item.*.detail` as free JSON. Spec 06 §6.3 lists e.g. `user_message {steered?}` and `tool_call {kind}`, but adapters emit more and differ: Claude sends `{name, input, ...}`, Codex sends `{command}` / `{path}` / `{name, kind}`. A client must parse every key as optional and fall back to `unknown`-style rendering.
2. **Spec vs protocol on `item.updated`.** Spec 06 mentions an `item.updated` event; the protocol union (`sessions.ts:771-786`) has no such tag. Clients should ignore unknown `_tag`s rather than fail.
3. **Clock fields that are not `Timestamp`.** `TranscriptRow.at`, every event's `at`, and `Subagent.startedAt/endedAt` are plain strings from the runner clock: not regex-validated, not monotonic across machines. Order by `position`, never by `at`.
4. **Extra keys silently ignored** on `permission.decide` and `notification.act` (plain `Schema.Struct`), but refused on the session payloads (`closedStruct`). A typo in an optional key on the first two goes unnoticed.
5. **`Input.actor` is a plain String**, not a validated actor union.
6. **`raw` payloads** on events can be large and provider-specific; nothing in the client should depend on them. There is no query flag to omit them.
7. **`core.approval` notification content** is built in the controller, not pinned by the contract schema. Action ids (`allow`, `allow-always`, `deny`, `cancel`) are stable in code (`approval-notification.ts:37`) but only `actions[].id` should be relied on; the `producer` value and `describeLine` text in the example were not traced to their source.
8. **Grant naming for transcript.** The controller service calls `requireGrant("transcript.read")`, which is an operation id; the operation table says the grant is `session.read`. Treat `session.read` as the required grant.
9. **Exit reason** is only in the transcript (`session.exited`); the `Session` record has no `exitReason` field. Showing "why it exited" needs a transcript read with `sort=position:desc&limit=…`.
10. **No server-side "waiting on you"**: the derivation in section 2 needs several list calls. A client polling it pays one call per assistant plus the Thread and live-session listings.
11. **Coalesced deltas**: a live stream may deliver many `content.delta` events that the stored transcript later returns as one row; a client mixing live and stored data must key on `itemId` and append, not on `position`.
12. **Bound operation input uses `sessionId`**, while the HTTP route names the same value `id` (`/sessions/{id}/...`). A client never builds this input itself (it calls `notification.act`), but must not try to replay `operation.input` against the HTTP route verbatim.


---

## B. Live WebSocket (`/ws`)

Markers used in this section:

- **[Observed]** - captured on the wire from a real controller built from this branch (`0.1.0+738cdb2b1`), with a raw WebSocket client and no Effect library in between.
- **[Source]** - read from the code, not seen on the wire.

### B.1 Big picture

- One WebSocket per client, at `ws://<host>:<port>/ws` (`wss://` only once the HTTPS that spec 13 §19 describes is built; today the controller serves plain HTTP). The path is `/ws`. It is not under `/api/v1`, and the handshake has no query string. [Source] `apps/controller/src/live/socket.ts:62`
- The handshake needs no `Authorization` header. The server does not check `Origin`, so a native client may send none. [Observed] The capture client sent neither header. [Source] There is no origin check in `socket.ts` or `http/server.ts`.
- The protocol on the socket is Effect RPC, JSON serialization (`RpcSerialization.layerJson`). [Source] `socket.ts:372-380`
  - One WebSocket **text** frame holds one JSON object.
  - A frame may also hold a JSON array of objects, which the server reads as several messages. [Observed]
  - No newline framing and no length prefix.
- The server and the client each talk in requests identified by an `id` the client chooses.
- The socket carries three RPCs only: `hello`, `subscribe` (streaming) and `ping`. Everything else goes over HTTP. [Source] `packages/contract/src/groups/live.ts:285-302`
- The live socket only signals change. A mutable topic says "records X changed", and the phone re-reads them over HTTP. An append-only topic carries the records themselves.

### B.2 Authentication: ticket, then `hello`

1. `POST /api/v1/auth/ws-ticket` with `Authorization: Bearer <token>` and an empty body (or `{}`). The response is `{"ticket":"4vUG53zGUDsm-YVkkCCspq70NmyCt8zXApYAjsYN1fY"}`. [Observed]
2. Open the socket, with no auth header.
3. Send the `hello` request as the first request, with the ticket in its payload.

Ticket rules:

- A ticket works **once**. A second `hello` with the same ticket, even on another socket, fails with `unauthenticated` "the ticket is not valid". [Observed]
- A ticket is valid for 5 minutes. [Source] `apps/controller/src/live/tickets.ts:25`
- Tickets live in controller memory only, so a controller restart voids every unused ticket. [Source] `tickets.ts:9`
- Fetch a fresh ticket for every connection attempt.
- Any `user` credential gets a ticket: a login token, or an **API key**. [Observed] An API key from `apiKey.create` got a ticket and a 200 from `controller.read`.
- A session credential gets 401: "only the user can open a live connection; a session or a run reads what it needs through the API". [Source] `tickets.ts:42-73`
- The socket is bound to the credential that fetched the ticket. When that credential is revoked (logout of a login token, revoke of an API key), every open subscription and the next call fail with `unauthenticated` "the credential this connection was opened with is no longer valid". [Observed]
  - The server checks this on every call, and in a sweep every 30 s for connections with open subscriptions. [Source] `socket.ts:69`
  - The server does **not** close the socket. It stayed open until the client closed it. [Observed]
- `auth.logout` with an API key fails with 400: `{"error":{"code":"validation","message":"this credential is not a login token","details":{"issues":[{"path":[],"message":"logout revokes a login token; use apiKey.revoke for a key"}]}}}`. [Observed]

### B.3 Message framing (Effect RPC JSON)

Field names and shapes come from `effect/src/unstable/rpc/RpcMessage.ts` (Effect `4.0.0-rc.112`). Every one below was seen on the wire unless marked.

**Client to server:**

| `_tag` | Shape | Meaning |
|---|---|---|
| `Request` | `{"_tag":"Request","id":"4","tag":"subscribe","payload":{...},"headers":[]}` | Starts an RPC. `id` is chosen by the client and must be unique among the client's open requests. The Effect client uses decimal strings counting up from `"0"`. A numeric id (`13`) is echoed back as a number. **`headers` is required**: a Request without it made the server close the socket with code **1011** [Observed]. Always send `"headers":[]`. |
| `Ack` | `{"_tag":"Ack","requestId":"4"}` | Send one after **every** `Chunk` of a streaming request. The server sends no further Chunk for that request until the Ack arrives (see B.5). |
| `Interrupt` | `{"_tag":"Interrupt","requestId":"4"}` | Cancels a request. This is how you **unsubscribe**. The server replies with an `Exit` whose cause is `Interrupt`. |
| `Ping` | `{"_tag":"Ping"}` | Protocol keepalive. The server replies `{"_tag":"Pong"}` at once. |
| `Eof` | `{"_tag":"Eof"}` | "The client sends no more." Do not send it. After an `Eof`, a later `ping` request got no reply. [Observed] |

Optional Request fields the Effect client may add, and the server ignores for its own logic: `traceId`, `spanId`, `sampled`, `isNotification`. [Source] `RpcMessage.ts`

**Server to client:**

| `_tag` | Shape | Meaning |
|---|---|---|
| `Exit` (success) | `{"_tag":"Exit","requestId":"2","exit":{"_tag":"Success","value":{...}}}` | The final reply to a non-streaming request (`hello`, `ping`). |
| `Exit` (failure) | `{"_tag":"Exit","requestId":"7","exit":{"_tag":"Failure","cause":[ ... ]}}` | The request ended with an error. For `subscribe`, this ends the subscription. `cause` is an array of the entries below. |
| `Chunk` | `{"_tag":"Chunk","requestId":"4","values":[<LiveMessage>, ...]}` | One or more stream items of a `subscribe`. `values` is never empty. |
| `Pong` | `{"_tag":"Pong"}` | The reply to `Ping`. |
| `Defect` | `{"_tag":"Defect","defect":{"name":"SyntaxError","message":"JSON Parse error: Unexpected identifier \"not\""}}` | The server could not parse a frame. The socket stays open. [Observed] |

The entries of a failure `cause`:

| Entry | Example | When |
|---|---|---|
| `Fail` | `{"_tag":"Fail","error":{"error":{"code":"unauthenticated","message":"this connection has not said hello"}}}` | A typed error from the contract. `error` is **exactly the HTTP error envelope**: `{"error":{"code","message","details"?}}`, with no `_tag`. Parse it with the same code as HTTP errors. |
| `Die` | `{"_tag":"Die","defect":"Expected string\n  at [\"topic\"]"}` | The payload has the wrong JSON types, or the method is unknown (`"Unknown request tag: nope"`). `defect` is a plain string. Treat it as a bug in the client. |
| `Interrupt` | `{"_tag":"Interrupt","fiberId":281}` | The request was cancelled, for example by your own `Interrupt`. |

A server never sends a `Chunk` for `hello` or `ping`. A `subscribe` never ends with `Exit` Success in practice: it ends only by an error or by an Interrupt. [Source] `apps/controller/src/live/topics.ts`

### B.4 The three RPCs

**`hello`** [Observed]

- Payload: `{"v":1,"ticket":"<ticket>"}`.
- Success: `{"v":1,"serverVersion":"0.1.0+738cdb2b1"}`. `serverVersion` is the same string as `controller.read`'s `version`.
- Errors:

| Case | Code | Message |
|---|---|---|
| Any request before `hello` | `unauthenticated` | "this connection has not said hello" |
| `v` other than 1 | `validation` | `details.issues[0]` = `{"path":["v"],"message":"this controller speaks live protocol version 1"}` |
| A ticket used, expired, or unknown | `unauthenticated` | "the ticket is not valid" |
| A second `hello` on the same socket | `invalid_state` | "this connection has already said hello" |

**`ping`** [Observed]

- Payload `{}`, success `{}`.
- It also re-checks the credential, which is how a revoked credential shows up even on a socket with no subscriptions.

**`subscribe`** (streaming) [Observed]

- Payload: `{"topic":"<topic>"}` or `{"topic":"<topic>","cursor":"<decimal>"}`.
- Each `Chunk` value is a `LiveMessage`: either an `invalidate` or a `delta` (B.6).
- Errors:

| Case | Code | Detail |
|---|---|---|
| An unknown topic name | `validation` | Two issues, both with `path: []`: `Expected "task" \| "run" \| ... \| "event"` and `Expected a string matching the RegExp ^session:([^:]+)(?::subagent:([^:]+))?:(stream\|tap)$` |
| A cursor on a mutable topic | `validation` | `{"path":["cursor"],"message":"task is not a log, so there is nothing to replay"}` |
| A cursor on a tap topic | `validation` | `"<topic> never replays, so there is nothing to resume from"` [Source] `socket.ts:309-318` |
| A cursor that is not digits, such as `"-1"` | `validation` | `{"path":["cursor"],"message":"the cursor must be a whole number: the position of an entry in the log"}` |
| A cursor past the end of the log | `validation` | `{"path":["cursor"],"message":"the cursor is past the end of this log, which is at 16"}`. For a session stream, the noun is "transcript". |
| An unknown session or subagent on a session topic | `not_found` | "no such session" (or the subagent variant) |
| A stream or tap topic, for a caller who may not call the `transcript.read` operation (grant `session.read`) | `forbidden` | [Source] `socket.ts:320,330`. The user holds every grant, so a phone never sees this. |
| `event`, for a caller who may not call `event.query` (grant `event.read`) | `forbidden` | [Source] `socket.ts:354` |
| The queue for this subscription is full (B.5) | `cap_exceeded` | "this subscription fell too far behind because it was not being read; subscribe again, and for a log topic pass the last cursor you received", `details` `{"count":1000,"cap":1000}` [Source] `topics.ts:117,187` |
| The credential was revoked | `unauthenticated` | "the credential this connection was opened with is no longer valid" |
| The server could not read its log | `internal` | "the event log could not be read" / "the session could not be read" [Source] |

### B.5 Flow control: Ack, batching, cap

- **Ack gate.** After each `Chunk`, the server waits for `{"_tag":"Ack","requestId":X}` before sending the next `Chunk` of request X. Other requests are not blocked. [Observed] `ws-capture2`: with the Ack withheld for about 1.8 s, nothing more arrived on that request.
- **Batching while waiting.** Messages queued while the server waits for the Ack go out together in one `Chunk`, as separate `values`. They are not merged into one `invalidate`. [Observed]

```json
{"_tag":"Chunk","requestId":"3","values":[
  {"_tag":"invalidate","ids":["01a13220-bd5f-714f-8d67-1725292864fa"],"kind":"created"},
  {"_tag":"invalidate","ids":["01a13220-bdda-7332-8011-210649fb3544"],"kind":"created"}]}
```

- **Rule for the Kotlin client:** handle every element of `values` in order, then send one Ack. Send the Ack promptly, even when the app is not drawing anything.
- **Cap.** When one subscription has 1000 messages queued (unsent or un-Acked), the server ends it with `cap_exceeded`. Subscribe again; for a log topic, pass the last cursor. [Source] `topics.ts:94` (`SUBSCRIPTION_CAP`)
- **Frame size.** The server's maximum WebSocket frame is 2 MiB (`MAX_FRAME_BYTES`). It applies to frames the client sends. [Source] `packages/protocol/src/index.ts:121`, `apps/controller/src/http/server.ts:157`

### B.6 Topics and what they push

**Mutable topics** - push `invalidate`. [Source] `live.ts:57-74`

`task`, `run`, `session`, `workflow`, `connection`, `notification`, `runner`, `workspace`, `plugin`, `provider`, `assistant`, `conversation`, `subagent`, `signal`

```json
{"_tag":"invalidate","ids":["01a1321f-b5cf-7613-99ad-0cbfd6ede00e"],"kind":"updated"}
```

- `kind` is one of `created`, `updated`, `deleted`.
- **The first message of every mutable subscription** is `{"_tag":"invalidate","ids":[],"kind":"updated"}`. It means "anything may have changed: re-read all of this topic". [Observed] It is sent once the subscription is registered, so a change made between your HTTP read and your subscribe is never lost. It also covers whatever was missed during an outage, because you subscribe again on each new connection. [Source] `live.ts:213-231`
- Empty `ids` always means "everything of this topic". [Source]
- A `session` push always has `conversationIds`. This map gives, for each id in `ids`, the conversation that session answers, or `null` for a session in no conversation (a thread, a workflow run's session). In the first message it is `{}`. [Observed] Use it to re-read an assistant chat's current session only when one of its sessions changed.

  ```json
  {"_tag":"invalidate","ids":[],"kind":"updated","conversationIds":{}}
  ```

- A push on every other topic has no `conversationIds`. [Observed] for `notification`, `assistant` and `task`.
- **`subagent`**: the `ids` are **session** ids whose subagents changed, not subagent ids. [Source] `live.ts:70-72`
- **Coalescing.** [Source] `topics.ts:75,85`
  - Changes are collected for 50 ms and sent together. The `assistant` invalidate came about 51 ms after the PATCH returned. [Observed]
  - The window is 1000 ms for the `subagent` topic, and for a session change that only touches Token Usage. A busy session therefore produces at most about one `session` push per second from token counting alone.

What a phone re-reads on each push, mirroring client-core's `buildQueryKeys` (`packages/client-core/src/live/keys.ts:290-425`):

| Topic | `ids` empty | `ids` present |
|---|---|---|
| `session` | every session list, every session, every input list, every conversation's current session | session lists; `session.read` for each id; that session's inputs; the current session of each conversation in `conversationIds` (any id missing from the map: all of them) |
| `conversation` | every conversation list, conversation, and message page | conversation lists; `conversation.read` and `conversation.queryMessages` for each id |
| `assistant` | the assistant list and every assistant | the list, plus `assistant.read` per id |
| `notification` | all notification reads | all notification reads (ids are not used) |
| `signal` | every signal list and signal | the lists, plus `signal.read` per id |
| `subagent` | every subagent list | the subagent list of each session id |
| `task`, `run`, `runner`, `workspace`, `workflow`, `connection` | the list and every record | the list, plus the record per id |

**Append-only: `event`** - pushes `delta` with the Event records. [Observed]

**Append-only: `session:<sessionId>:stream`** and **`session:<sessionId>:subagent:<subagentId>:stream`** - push `delta` with `TranscriptRow`s, the stored, coalesced transcript of one agent. [Source] `topics.ts:352-362`. The row shape is `{"position":<int>,"at":"<ISO>","event":<ProviderEvent>}` (`packages/contract/src/groups/transcript.ts:38-42`); the `event` kinds are in section A (transcript.read).

**`session:<sessionId>:tap`** and **`session:<sessionId>:subagent:<subagentId>:tap`** - push `delta` with `TapItem`s: live token deltas. They are never stored and never replayed, and they carry **no cursor**. [Source] `topics.ts:494-508,560-567`

```json
{"_tag":"delta","items":[{"turnId":"t_1","itemId":"i_7","streamKind":"assistant_text","delta":"Hello"}]}
```

- `streamKind` is one of `assistant_text`, `reasoning_text`, `command_output`. [Source] `packages/protocol/src/sessions.ts:515`
- `subagentId` is present only on a subagent's tap.
- There is no first message on subscribe. Each token delta is its own `delta` with one item, sent with no coalescing window. While you hold back an Ack, several deltas are batched into one `Chunk`.

The items in a `delta` have no discriminator field. Tell them apart by the topic you subscribed to:

- `event`: Event, with `id` a number.
- `:stream`: TranscriptRow, with `position`.
- `:tap`: TapItem, with `streamKind`.

The stream and tap topics are checked against the `transcript.read` operation (grant `session.read`), and `event` against `event.query` (grant `event.read`). The user holds every grant. Neither session id nor subagent id may contain `:`. [Source] `live.ts:111`

### B.7 Cursors and replay (append-only topics)

- The cursor is a decimal string, such as `"9"`. For `event` it is the event `id`; for a stream it is the row `position`. Treat it as opaque: store the last one you received, send it back, and never do arithmetic on it. [Observed] / [Source] `topics.ts:345-360`
- **Without a cursor**, the subscription starts at the head. The first message is an empty delta that carries the head cursor: `{"_tag":"delta","cursor":"9","items":[]}`. [Observed]
- **With a cursor**, the first message is the replay: every entry after the cursor, up to 500, in one `delta`, with the cursor of its last item. The replay is sent even when there is nothing to replay. [Observed] `cursor:"0"` on `event` returned one delta with `"cursor":"9"` and 9 items.
- After the replay, every new entry comes as its own `delta` with exactly one item and that item's cursor. [Source] `topics.ts:293-330`. Also [Observed] for `event`.
- When more than 500 entries are behind, the first delta holds 500. The rest follow as one-item deltas. [Source]
- `cursor:"0"` means "from the very start".
- A cursor past the head fails with `validation`. It means the cursor belongs to another log, for example after the controller's database was replaced. Do what client-core does: drop the cursor, re-read over HTTP, and subscribe again without one. [Source] `packages/client-core/src/live/live.ts:375-392`
- **Session stream start point.** Read the transcript over HTTP (`transcript.read`), then subscribe to `:stream` with `cursor` = the `position` of the last row you hold, or `"0"` when you hold none. That is what `buildStreamCursor` does. [Source] `packages/client-core/src/threads/thread-live.ts:30-31`. Drop any row whose `position` you already hold.
- After a `reset` (cursor refused), re-read the transcript and clear any half-drawn token text: taps sent while you were away are gone for good. [Source] `apps/desktop/src/renderer/screens/session/use-session-live.ts` docstring

### B.8 Keepalive and timeouts

- **Protocol Ping.** The Effect client sends `{"_tag":"Ping"}` every **5 s**. If no `Pong` (or any frame) arrives before the next tick, it counts the connection as dead and reconnects. [Source] `effect/src/unstable/rpc/RpcClient.ts:1198-1219`. The server answers `Pong` at once. [Observed]
- **App `ping`.** client-core also sends the `ping` RPC every **30 s**. That keeps intermediaries from idling the socket out, and it re-checks the credential. [Source] `packages/client-core/src/live/live.ts:61-73`
- **For OkHttp:** a native client may skip the protocol Ping and use OkHttp's `pingInterval` (WebSocket ping frames) for liveness instead. But it must still send the app `ping` RPC, so that a revoked credential is noticed. The recommended setup:
  - an RPC `Ping` or an OkHttp ping every 5-15 s, treating a missed `Pong` as dead;
  - a `ping` request every 30 s.
- **Server idle timeout.** Hercule does not set one. Bun's default is 120 s of no traffic, and Bun answers WebSocket ping frames itself. [Source] `server.ts:157` sets only `maxPayloadLength`. The Bun default was not verified here.
- **No hello deadline.** The server does not close a socket that never says `hello`; it just refuses every other request. [Source] `socket.ts`

### B.9 Reconnect rules (what client-core does; copy it)

[Source] `packages/client-core/src/live/live.ts`

1. On any close or timeout, wait, then reconnect.
   - The first wait is 1 s; each later one doubles, up to 30 s.
   - Jitter takes up to 20% off a wait, never adds to it.
   - The wait goes back to 1 s once a connection has stayed up for at least 30 s.
2. On each attempt, fetch a new ticket over HTTP.
   - On 401, stop and show "signed out". Do not retry.
   - On any other failure, back off and retry.
3. Open the socket and send `hello`.
4. Re-send `subscribe` for **every** topic that is still wanted.
   - A mutable topic gets no cursor. Its first `invalidate` with empty `ids` re-reads everything.
   - An append-only topic gets the last cursor received.
   - A tap gets no cursor. Clear any half-built token text first, because the deltas sent during the gap are lost.
5. Handle a subscription that ends while the socket stays up by its error code:
   - `unauthenticated`: the credential is gone. Close the connection and go to step 1; the ticket fetch decides whether you are signed out.
   - `not_found` on a session topic: the session no longer exists. Stop that subscription only, and do not retry.
   - `validation` with a cursor: drop the cursor, reset, and subscribe again at once.
   - Anything else (`cap_exceeded`, `internal`): subscribe again after a growing wait, from 1 s up to 30 s.
6. Request ids only need to be unique within one socket. Restart at `"0"` on each connection.

### B.10 Full example transcript [Observed]

This is real traffic from the throwaway controller, trimmed to the lines that matter. The ticket fetch happens over HTTP before the socket opens. `C->S` is the phone, `S->C` the controller; the number is milliseconds since the socket opened.

```text
HTTP POST /api/v1/auth/ws-ticket  (Authorization: Bearer <token>)
     -> 200 {"ticket":"RvAgxpzwgQPcMp3ldfLUkdbNXufl6q5CpDQs38GCTxM"}

WS   GET /ws  (upgrade; no auth header, no query string)

+5   C->S {"_tag":"Request","id":"2","tag":"hello","payload":{"v":1,"ticket":"RvAgxpzwgQPcMp3ldfLUkdbNXufl6q5CpDQs38GCTxM"},"headers":[]}
+5   S->C {"_tag":"Exit","requestId":"2","exit":{"_tag":"Success","value":{"v":1,"serverVersion":"0.1.0+738cdb2b1"}}}

+6   C->S {"_tag":"Request","id":"4","tag":"subscribe","payload":{"topic":"session"},"headers":[]}
+7   S->C {"_tag":"Chunk","requestId":"4","values":[{"_tag":"invalidate","ids":[],"kind":"updated","conversationIds":{}}]}
+7   C->S {"_tag":"Ack","requestId":"4"}

+7   C->S {"_tag":"Request","id":"5","tag":"subscribe","payload":{"topic":"notification"},"headers":[]}
+7   S->C {"_tag":"Chunk","requestId":"5","values":[{"_tag":"invalidate","ids":[],"kind":"updated"}]}
+7   C->S {"_tag":"Ack","requestId":"5"}

     (a change happens: here an assistant was renamed over HTTP, on a socket subscribed to "assistant")
+258 HTTP PATCH /api/v1/assistants/01a1321f-b5cf-7613-99ad-0cbfd6ede00e -> 200
+309 S->C {"_tag":"Chunk","requestId":"2","values":[{"_tag":"invalidate","ids":["01a1321f-b5cf-7613-99ad-0cbfd6ede00e"],"kind":"updated"}]}
     C->S {"_tag":"Ack","requestId":"2"}
     (the phone now does GET /api/v1/assistants/01a1321f-... and GET /api/v1/assistants)

+4119 C->S {"_tag":"Request","id":"6","tag":"ping","payload":{},"headers":[]}
+4120 S->C {"_tag":"Exit","requestId":"6","exit":{"_tag":"Success","value":{}}}

+4120 C->S {"_tag":"Ping"}
+4120 S->C {"_tag":"Pong"}

     (unsubscribe from "session")
+4323 C->S {"_tag":"Interrupt","requestId":"4"}
+4324 S->C {"_tag":"Exit","requestId":"4","exit":{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":281}]}}

     (event log, replay from the start)
+4122 C->S {"_tag":"Request","id":"10","tag":"subscribe","payload":{"topic":"event","cursor":"0"},"headers":[]}
+4123 S->C {"_tag":"Chunk","requestId":"10","values":[{"_tag":"delta","cursor":"9","items":[
            {"id":1,"source":"platform","connectionId":null,"system":"platform","kind":"provider.created",
             "occurredAt":"2026-10-12T21:58:12.697Z","receivedAt":"2026-10-12T21:58:12.697Z",
             "dedupKey":"e50db133-2989-440b-a7ae-849bf57d5828","refs":[],"url":null,
             "payload":{"instanceId":"01a1321f-93d9-7254-af1c-ac2c5c0926be","providerId":"claude-code"},
             "raw":null,"actor":"system","title":null,"author":null},
            ... 8 more events, ids 2..9 ...]}]}
+4123 C->S {"_tag":"Ack","requestId":"10"}

     (the credential is revoked elsewhere: POST /api/v1/auth/logout)
     C->S {"_tag":"Request","id":"5","tag":"ping","payload":{},"headers":[]}
     S->C {"_tag":"Exit","requestId":"2","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"error":{"code":"unauthenticated","message":"the credential this connection was opened with is no longer valid"}}}]}}
     S->C {"_tag":"Exit","requestId":"3","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"error":{"code":"unauthenticated","message":"the credential this connection was opened with is no longer valid"}}}]}}
     S->C {"_tag":"Exit","requestId":"5","exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"error":{"code":"unauthenticated","message":"the credential this connection was opened with is no longer valid"}}}]}}
     (the socket stays open; the client closes it, code 1000)
```

**Not observed:** a session `:stream` or `:tap` delta with real content, and a `session` invalidate with real `conversationIds`. Producing them would have meant starting a real Claude or Codex session on the local runner with the user's credentials, so I did not. Those shapes come from the source, as cited above.

### B.11 Kotlin implementation checklist

- [ ] Use OkHttp `WebSocket` and text frames only. Parse each frame as an object or an array of objects.
- [ ] Always send `"headers":[]` in a Request. Without it the socket closes with 1011.
- [ ] Use string request ids `"0"`, `"1"`, ... per connection, and route by `requestId`.
- [ ] Send an `Ack` after every `Chunk`, once its `values` are handled.
- [ ] Handle `Exit` with `cause[0]._tag`:
  - `Fail`: read `error.error.code`, which uses the same codes as HTTP.
  - `Die`: a client bug; log it.
  - `Interrupt`: you cancelled the request.
- [ ] Unsubscribe with `Interrupt`.
- [ ] Never send `Eof`.
- [ ] Send a `Ping` every 5 s and expect a `Pong` (or use OkHttp `pingInterval`), and send the `ping` RPC every 30 s.
- [ ] Reconnect with backoff of 1 s to 30 s and jitter, as in B.9. Get a new ticket each time, re-send `hello`, re-subscribe everything, and pass the stored cursors.
- [ ] On every `invalidate`, re-read the records over HTTP. With `ids: []`, re-read everything the screen shows for that topic.


---

## C. Notifications - what the phone should alert on

Line numbers are against commit 738cdb2b1 on `main`.
All paths are relative to the repo root. Line numbers are from that commit.

Short version:

- The desktop raises OS notifications for exactly **two** things:
  1. A thread or assistant gets a **new open Request** (approval or question) in `Session.openRequests`.
  2. A **new urgent ("Now") Signal** appears in To do.
- Both are skipped while the window is focused, and both are suppressed on the first list after sign-in.
- The desktop does **not** notify on: permission requests, decision Notifications (`notification.*`), assistant messages, run sessions ("From runs"), or non-urgent Signals.
- All notification-worthy state arrives as `invalidate` pushes on mutable live topics. The phone always re-reads over HTTP; no push carries the details.

---

### 1. How the desktop does it today

#### 1.1 Architecture

The work is split across two processes:

- **Renderer** (React, `apps/desktop/src/renderer`): computes two lists from the query cache and sends each over IPC when its JSON changes.
- **Main** (Electron, on Effect): owns the dedupe state, the focus check, the dock badge, the OS `Notification` objects, and clicks.

| Step | File:line |
|---|---|
| Renderer computes the waiting list with `useWaiting()` | `apps/desktop/src/renderer/routes/_connected/_shell.tsx:65` |
| ... maps it with `buildWaitingRequest` and sends it on `waiting.set` | `_shell.tsx:90-94` |
| Renderer computes urgent signals with `listUrgentSignals(signalsToDo, plugins)` and sends them on `urgentSignals.set` | `_shell.tsx:99-105` |
| Send-on-change helper: sends after the first render, then whenever `JSON.stringify(value)` changes; a failed send is logged and not retried | `apps/desktop/src/renderer/app/send-on-change.ts:12-26` |
| IPC payload types `Destination`, `WaitingRequest`, `UrgentSignal` | `apps/desktop/src/ipc/contract.ts:310-314`, `:332-338`, `:346-350` |
| Channels `waiting.set`, `urgentSignals.set`, and main-to-renderer `destination.open` | `apps/desktop/src/ipc/contract.ts:440`, `:452`, `~:595` |
| Main handlers | `apps/desktop/src/main/ipc/index.ts:66-69` |
| Preload bridge | `apps/desktop/src/preload/index.ts:85-88`, `:121` |
| Main service: Requests and badge | `apps/desktop/src/main/waiting-notifications.ts` |
| Main service: Now signals | `apps/desktop/src/main/urgent-signal-notifications.ts` |
| The sign-in state feeds both services | `apps/desktop/src/main/stored-token.ts:65-72` (`reflectSignedIn`) |

IPC payloads, from `apps/desktop/src/ipc/contract.ts`:

```ts
type Destination =
  | { kind: "thread"; sessionId: string }
  | { kind: "assistant"; assistantId: string }
  | { kind: "signal"; signalId: string };

interface WaitingRequest {   // one per thread/assistant with open Requests
  destination: Destination;  // thread or assistant
  requestId: string;         // the NEWEST open Request
  openRequestIds: string[];  // every open Request id, oldest first
  title: string;
  body: string;
}

interface UrgentSignal { signalId: string; title: string; body: string }
```

Dedupe key: `buildDestinationKey(destination)` returns `thread:<sessionId>`, `assistant:<assistantId>` or `signal:<signalId>` (`apps/desktop/src/ipc/destination.ts:14-23`).

#### 1.2 Live topics subscribed

From `apps/desktop/src/renderer/app/live.ts`:

- **Always, while signed in** (`SHELL_TOPICS`, `live.ts:43-53`): `session`, `runner`, `workspace`, `provider`, `task`, `connection`, `assistant`, `signal`, `plugin`.
  - Each push invalidates the query keys from `buildQueryKeys` (`packages/client-core/src/live/keys.ts:~289-400`).
  - The topics stay subscribed while the window is hidden (spec 17 l.1179). Closing the window hides it, and notifications keep working (spec 17 l.458).
- **Only while a thread is open**: `subagent` (`live.ts:122-133`).
- **Only on the workflows pages, while the window is visible**: `workflow`, `run` (`live.ts:150-163`).
- **Only while an assistant screen is open**: `conversation` (`apps/desktop/src/renderer/screens/assistant/use-conversation-live.ts:56`, used at `assistant-screen.tsx:85`).
- **Never**: `notification`. The desktop never reads `notification.*`.

The two notification inputs therefore depend only on `session`, `assistant`, `signal` and `plugin`.

#### 1.3 HTTP reads behind the two lists

From `apps/desktop/src/renderer/app/queries.ts`. All use `SHELL_READ_OPTIONS` (`queries.ts:132-154`): `staleTime: Infinity`, `gcTime: Infinity`, no refetch on focus or reconnect, so only live pushes cause a re-read.

| Query | Operation | Params | Refetched by topic | File:line |
|---|---|---|---|---|
| `threadsQuery` | `session.query` (`GET /api/v1/sessions`) | `{thread: true}`, reads every page through `nextCursor` | `session` | `queries.ts:168-174` |
| `assistantsQuery` | `assistant.query` (`GET /api/v1/assistants`) | none, every page | `assistant` | `queries.ts:442-447` |
| `currentConversationSessionQuery(conversationId)` | `session.query` | `{conversationId, sort:[{field:"createdAt",direction:"desc"}], limit:1}` | `session` (through the push's `conversationIds`) | `queries.ts:797-808` |
| `signalsToDoQuery` | `signal.query` (`GET /api/v1/signals`) | first `{view:"later", limit:1}` (for the snooze wake-up timer), then `{view:"to-do"}` (not paged) | `signal` | `queries.ts:464-473` |
| `pluginsQuery` | `plugin.query` (`GET /api/v1/plugins`) | none | `plugin` | `queries.ts:596-601` |

Assistant rows: for each assistant, `useAssistantRows` reads `currentConversationSessionQuery(assistant.mainConversationId)` and then calls `buildAssistantRows` (`apps/desktop/src/renderer/app/assistant-rows.ts:28-57`).

#### 1.4 The computed sets

**Waiting** (`packages/client-core/src/waiting.ts`):

- `listWaiting(threads, assistantRows)` (`waiting.ts:122-142`) returns:
  - every thread session with `openRequests.length > 0`;
  - every assistant whose current conversation session has `openRequests.length > 0`.
- The list is sorted by `lastActivityAt` descending, then by session id.
- `useWaiting()` wires it up (`apps/desktop/src/renderer/app/waiting.ts:22-26`).
- Run sessions are excluded. "From runs" is a separate list (`useWaitingRunSessions`, `waiting.ts:38-44`; `listWaitingRunSessions`, client-core `waiting.ts:169-191`) and feeds neither the badge nor notifications (spec 17 l.488, post-v1 at l.3094).
- `buildRequestFields` (`waiting.ts:98-111`):
  - `oldest = openRequests[0]`;
  - `newest = openRequests.at(-1)`;
  - `openRequestIds` = every id, oldest first;
  - returns null when nothing is open.
- Only `Session.openRequests` counts. `Session.openPermissionRequests` is not part of this list.

**Urgent signals** (`packages/client-core/src/intake.ts:650-664`, `listUrgentSignals`):

- Starts from the To do list.
- Keeps signals with `priority === "urgent"`, sorted by `createdAt` ascending.
- Only a plugin's kind may be urgent (`packages/contract/src/groups/signal.ts:608`).

#### 1.5 Dedupe, first load, re-alert, clearing

**Requests** (`apps/desktop/src/main/waiting-notifications.ts`; the rules are written out in its docstring at l.68-93):

- **State**:
  - `shown`: a map from destination key to `{notification, requestId}` (l.112-115);
  - `signedIn` (l.121);
  - `lastOpenRequestIds`: null until the first list (l.124).
- **Signed out**: every list is ignored (l.172).
- **Badge**: set to `requests.length` on every list. This counts destinations, not Requests.
- **First list after sign-in**: the service records the open ids and returns, so nothing is shown at launch or sign-in.
  - A page reload re-sends the same list, and that list is not a "first list", so reloads do not re-notify.
- **What counts as new**: a destination whose newest `requestId` is not in that destination's previous `openRequestIds`.
  - A second Request on the same thread counts as new: the old notification is closed and replaced by one with "+1 more waiting".
  - A Request that closes while older ones stay open is not new.
- **Clearing**: a shown notification is closed when its `requestId` is no longer open for its key. The Request may have been answered anywhere (ADR 0027, spec 17 l.505-507).
- **Focus**: when the window is focused, the old notification is still closed, but no new one is shown.
- **Sign-out** (`setSignedIn`, l.161-171):
  - the last list resets to null;
  - the badge goes to 0;
  - every notification is closed.
- **Sign-in**: calls `askToNotify()` (`Notification.isSupported()` in `apps/desktop/src/main/index.ts`; spec 17 l.487).
- **Click** (l.134-141):
  - If the notification is still the current one for its key, its entry is deleted.
  - Then `window.showAndSend("destination.open", destination)` runs.
- **Failed show**: logs a warning (l.144-146).
- Tests: `apps/desktop/src/main/waiting-notifications.test.ts:91-357`, including the "several Requests open" block at l.286.

**Now signals** (`apps/desktop/src/main/urgent-signal-notifications.ts`):

- **State**: `shown` keyed by `signalId` (l.88); `lastSignalIds` is null at first (l.94).
- **First list after sign-in**: records the ids only.
- **What counts as new**: a `signalId` not in the previous list. One notification per signal.
- **Re-alert**: a signal that leaves the list and comes back, for example from snooze, notifies again. Test at `urgent-signal-notifications.test.ts:141`; spec 17 l.499-504.
- **Clearing**: a signal no longer in the list closes its notification. The signal may have been resolved, snoozed, or demoted from Now.
- **Focus**: skipped while focused.
- **Sign-out**: closes all and resets. This service does not ask for permission and never touches the badge (docstring l.14-22).
- **Click** (l.103-109): `destination.open {kind:"signal", signalId}`.
- Tests: `urgent-signal-notifications.test.ts:65-212`.

#### 1.6 Title, body, click target

**Request notification** (`apps/desktop/src/renderer/routes/_connected/-destinations.ts:19-39`, `buildWaitingRequest`):

- **Title**: the session's `title` for a thread, or the assistant's `name` for an assistant.
- **Body** (`formatNotificationBody`, `packages/client-core/src/waiting.ts:87-92`):
  1. If the newest Request has a `subagentId`, the body starts with `"<subagentName ?? "A subagent"> asks: "`.
  2. Then comes `formatRequestQuestion(newest)`.
  3. If more than one Request is open, `"\n+N more waiting"` follows, where N = open count - 1.
- `formatRequestQuestion` (`packages/client-core/src/threads/request-question.ts:42-60`):

| `detail.kind` | Text |
|---|---|
| `command_approval` | `Run <first non-empty line of command>?`, or `Run this command?` |
| `file_change_approval` | `Change <basename>?` for 1 path, `Change N files?` for more, `Change files?` for none |
| `file_read_approval` | `Read <basename>?`, `Read N files?`, `Read files?` |
| `tool_approval` | `Run <toolName>?` |
| `question` | `questions[0].question` |

**Now signal notification** (`intake.ts:650-664`):

- **Title**: the plugin's `displayName`, or its plugin id (`namePlugin`, `intake.ts:86-87`). When the signal kind is not a plugin's, the title is `"Hercule"` (`CORE_SOURCE_NAME`, `intake.ts:52`).
- **Body**: `signal.title`.

**Click** (`-destinations.ts:56-97`, `useOpenDestination`; wired at `_shell.tsx:138-145`, which also closes open dialogs):

- **thread**: `/office?session=<id>` when the Office is open and the thread is seated there; otherwise `/threads/<sessionId>`.
- **assistant**: `/office?assistant=<id>` when the Office is open; otherwise `/assistants/<assistantId>`.
- **signal**: `/intake?signal=<signalId>`.

Examples:

```
[Thread]     Title: Fix flaky upload test
             Body:  Run pnpm test --filter upload?
                    +1 more waiting

[Subagent]   Title: Refactor billing
             Body:  reviewer asks: Change invoice.ts?

[Question]   Title: Release notes
             Body:  Which version should I tag?

[Assistant]  Title: Ada
             Body:  Run gh pr list?

[Now signal] Title: PagerDuty
             Body:  Checkout error rate above 5%
```

#### 1.7 Settings that gate it

- There is **no notification toggle in the desktop app**.
- The only gates are:
  - macOS notification permission;
  - being signed in;
  - the window not being focused.
- A setting `notifications.muted` exists in the contract (`packages/contract/src/groups/settings.ts:166`). It belongs to the server-side Notification router (spec 10 l.246), not to the desktop OS notifications.
- The web app shows no OS notifications. It only counts unseen Notifications since `lastChecked.notifications` through the `notification` topic (`apps/web/src/shell/sidebar.tsx:95-118`).

---

### 2. Notification-worthy states and how to learn about them

Live framing (`packages/contract/src/groups/live.ts`):

- Mutable topics push `{"_tag":"invalidate","ids":[...],"kind":"created"|"updated"|"deleted","conversationIds"?:{...}}`.
- The **first push on every subscription has empty `ids`**, meaning "everything may have changed; re-read".
- Pushes are coalesced over 50 ms (`COALESCE_WINDOW_MS`, `apps/controller/src/live/topics.ts`).
- Only `event` and `session:<id>:stream|tap` are `delta` topics, and none of the states below needs them.

| State | Where it lives | Topic | Frame | Read for details | Desktop notifies? |
|---|---|---|---|---|---|
| Approval Request in a thread | `Session.openRequests[]`, `detail.kind` = `*_approval` | `session` | invalidate. `ids` holds session ids; announced when the open Requests change (`apps/controller/src/sessions/service.ts:681-690`, `~:2766`) | `session.query {thread:true}`, or `session.read {id}` for one | **Yes** |
| Question in a thread | `Session.openRequests[]`, `detail.kind` = `question` | `session` | invalidate | same | **Yes** |
| Approval or question in an assistant's conversation | the current conversation session's `openRequests` | `session`, with `conversationIds` in the push | invalidate | `session.query {conversationId, sort:[{field:"createdAt",direction:"desc"}], limit:1}` for each `assistant.mainConversationId` | **Yes** (title = assistant name) |
| Request in a run session ("From runs") | `Session.openRequests`, where the session has `runId` | `session` | invalidate | `session.query {thread:false, ...}`; filter by `runId` | No (post-v1, spec 17 l.3094) |
| Permission request | `Session.openPermissionRequests[]` (`PermissionRequest {id, grant, reason, operation?, createdAt}`, `packages/contract/src/groups/permission.ts:74-80`) | `session` (`apps/controller/src/daemon/permissions/permission-requests.ts:232`, `:333`) | invalidate | the same session reads; also mirrored as a `core.permission-request` Notification | No. The desktop shows it only in the thread's permission-request dock |
| Decision Notification (has `actions`, `status:"open"`) | `notification` table. Kinds include `core.approval`, `core.permission-request`, `core.run-failed`, ... (`packages/contract/src/groups/notification.ts:133-143`) | `notification` (`apps/controller/src/notifications/notifier.ts:293`, `:331`, `:560`; `service.ts:352`) | invalidate | `notification.query {status:"open"}` (`GET /api/v1/notifications`); also `since`, `kind` | No. The desktop never reads it |
| Informational Notification (no actions, e.g. `core.run-failed`, `core.runner-unreachable`) | same | `notification` | invalidate | same | No |
| Urgent ("Now") Signal | `Signal` with `priority:"urgent"`, `view:"to-do"` | `signal` (`apps/controller/src/signals/raises.ts:371`, `:389`; `signals/service.ts` several sites) | invalidate | `signal.query {view:"to-do"}` plus `plugin.query` for the source name | **Yes** |
| Non-urgent Signal | `Signal` | `signal` | invalidate | same | No (spec 17 l.972-973: "a new Now signal notifies, nothing else") |
| Assistant message (assistant replied in the DM) | `ConversationMessage` with `senderRole:"assistant"` (`packages/contract/src/groups/conversation.ts:47`, `:52+`) | `conversation` (`apps/controller/src/conversations/conversation-messages.ts:63-89`). `ids` holds the **conversation id**, `kind:"updated"`, sent for **every** message: owner, assistant and notice | invalidate | `conversation.queryMessages {params:{id}, query:{sort:[{field:"position",direction:"desc"}], limit:N}}` (`queries.ts:815-827`) | No. The desktop subscribes only while the screen is open |

Notes:

- **Approvals are double-represented.** Each opened approval Request also creates a `core.approval` Notification with a `request` subject `{sessionId, requestId}`, and the Notification is withdrawn when the Request closes (`apps/controller/src/sessions/service.ts:887-909`).
  - A **question raises no Notification** (`apps/controller/src/sessions/approval-notification.ts:1-15`; spec 10 l.375-381, #317).
  - So `Session.openRequests` is the complete source. Notifications are a partial mirror, and a phone that alerted on both would alert twice.
- **Permission requests** are likewise mirrored as `core.permission-request` Notifications with subject `permissionRequest {id}` (spec 10 l.386-392).
- **Answering**:
  - `session.respondToApprovalRequest`, `session.respondToQuestion`;
  - `permission.decide`;
  - `notification.act` for decision Notifications;
  - `notification.read` marks a Notification read.

#### 2.1 Example reads

`GET /api/v1/sessions?thread=true` (trimmed to the fields that matter):

```json
{
  "items": [
    {
      "id": "ses_01J...",
      "title": "Fix flaky upload test",
      "status": "idle",
      "conversationId": null,
      "runId": null,
      "lastActivityAt": "2026-10-12T09:14:03.120Z",
      "openRequests": [
        {
          "requestId": "req_a1",
          "itemId": "item_7",
          "kind": "command_approval",
          "detail": { "command": "pnpm test --filter upload" },
          "decisions": ["allow", "allow_always", "deny", "cancel"]
        },
        {
          "requestId": "req_a2",
          "itemId": "item_9",
          "kind": "question",
          "subagentId": "sub_3",
          "subagentName": "reviewer",
          "detail": {
            "questions": [
              { "question": "Which branch should I base this on?", "header": "Branch",
                "options": [{ "label": "main", "description": "" }, { "label": "release", "description": "" }],
                "multiSelect": false }
            ]
          }
        }
      ],
      "openPermissionRequests": []
    }
  ],
  "nextCursor": null
}
```

The resulting desktop notification:

- title `Fix flaky upload test`;
- body `reviewer asks: Which branch should I base this on?\n+1 more waiting`;
- key `thread:ses_01J...`;
- `requestId` = `req_a2`.

`GET /api/v1/signals?view=to-do` (trimmed):

```json
{
  "items": [
    {
      "id": "sig_9",
      "kind": "pagerduty.incident",
      "title": "Checkout error rate above 5%",
      "priority": "urgent",
      "status": "open",
      "createdAt": "2026-10-12T09:20:11.000Z",
      "actions": [ ... ]
    }
  ]
}
```

Paired with `GET /api/v1/plugins`, where the `pagerduty` plugin has `displayName: "PagerDuty"`, this gives title `PagerDuty`, body `Checkout error rate above 5%`, key `signal:sig_9`.

`GET /api/v1/notifications?status=open` (trimmed):

```json
{
  "items": [
    {
      "id": "ntf_4",
      "kind": "core.approval",
      "title": "Run `pnpm test --filter upload`?",
      "producer": "core",
      "subject": [{ "kind": "request", "sessionId": "ses_01J...", "requestId": "req_a1" }],
      "actions": [{ "id": "allow", "label": "Allow" }, { "id": "deny", "label": "Deny" }],
      "status": "open",
      "createdAt": "2026-10-12T09:14:03.200Z"
    }
  ],
  "nextCursor": null
}
```

Live frames:

```json
{"_tag":"invalidate","ids":[],"kind":"updated"}
{"_tag":"invalidate","ids":["ses_01J...","ses_02K..."],"kind":"updated","conversationIds":{"ses_01J...":null,"ses_02K...":"cnv_2"}}
{"_tag":"invalidate","ids":["sig_9"],"kind":"created"}
{"_tag":"invalidate","ids":["cnv_2"],"kind":"updated"}
```

The first frame is the empty-ids push every subscription receives first. In the second, `conversationIds` maps each session to its conversation, or `null` for a thread or run session (`packages/contract/src/groups/live.ts:225-236`); here `ses_02K...` is an assistant's session. The last is a conversation message push, which carries no message details.

`decisions` sits on the approval Request, not in `detail`. Its values are `allow | allow_always | deny | cancel`, and the list leaves out decisions the request cannot take (`packages/protocol/src/sessions.ts:348-383`). Notification `actions` are `BoundAction` plus an optional `describeLine` (`notification.ts:266`, `:322`). Ids and timestamps in these examples are invented.

Field shapes above follow the contract files cited. The exact `conversationIds` encoding and the full paging shape are owned by the wire-format part (parts A and B); check them there before coding.

---

### 3. Recommended phone rule set

Legend:

- **[Parity]** means the desktop does exactly this; cite spec 17.
- **[Suggestion]** means it is new for the phone and is not in the spec. Each needs Rogier's decision, and some need a spec amendment.

#### 3.1 What to alert on

1. **[Parity]** A new open Request on a thread session (`thread:true`). Use the title and body rules in 1.6.
2. **[Parity]** A new open Request on an assistant's current conversation session. Title = assistant name.
3. **[Parity]** A new Now Signal in To do. Title = source name; body = signal title.
4. **[Suggestion]** A new assistant message in an assistant's main conversation.
   - This is the main point of an "assistant MVP" on a phone, but the desktop has no rule for it.
   - Spec 12 l.310 talks of the assistant saying something "in the DM" on the phone, but defines no notification for it.
   - Needs a spec 17 / spec 12 amendment, or a phone-specific spec section.
   - Detection:
     - subscribe to `conversation`;
     - on a push whose `ids` contains a watched `mainConversationId`, read `conversation.queryMessages {sort position desc, limit 20}`;
     - alert for each message with `senderRole === "assistant"` and `position` greater than the last seen position;
     - skip `owner` and `notice` messages.
   - Title = assistant name; body = message `text`, truncated.
   - Key `assistant:<id>`. Open question: should a message share the key with that assistant's Request notification, or use its own key such as `assistant-message:<id>`?
5. **[Suggestion]** A new permission request (`openPermissionRequests`).
   - The desktop does not notify on these, but on a phone the agent is blocked until someone answers.
   - Key by session, so it shares the destination with Requests. Body example: `Needs permission: <reason>`.
6. **Do not alert** (parity by omission):
   - run sessions ("From runs", post-v1);
   - non-urgent Signals;
   - informational Notifications.
7. **Do not alert on decision Notifications as their own source.**
   - The approval ones duplicate rule 1.
   - The rest (`core.run-failed`, `core.plugin-error`, ...) are not decisions the phone needs to wake someone for.
   - [Suggestion] Revisit if Rogier wants run failures on the phone.

#### 3.2 Dedupe and lifecycle

1. **[Parity]** Key one notification per destination: `thread:<sessionId>`, `assistant:<assistantId>`, `signal:<signalId>`. A new Request on the same destination replaces the old notification, and the body gains `+N more waiting`.
   - On Android: one notification id per key, re-posted with `setOnlyAlertOnce(false)`.
2. **[Parity]** A Request is new when the destination's newest `requestId` was not among its open ids in the previous list. A signal is new when its `signalId` was not in the previous Now list. One that comes back from snooze alerts again.
3. **[Parity]** No alerts for the first list after sign-in or app start. Record ids only.
   - [Suggestion] Persist the last-seen ids per destination on disk, so a process restart by Android does not cause a re-alert storm or missed alerts. The desktop keeps them in memory only, and a page reload keeps them because main outlives the renderer.
4. **[Parity]** Clear a notification when its Request closes or its signal leaves Now, wherever it was answered (ADR 0027).
5. **[Parity]** Clear everything on sign-out.
6. **[Parity]** Suppress while the user is looking: on the phone, while the app is in the foreground.
   - [Suggestion] Better: suppress only while the destination itself is on screen, and alert for others.
7. **[Parity]** Ask for notification permission at sign-in (`POST_NOTIFICATIONS` on Android 13+).
8. **[Parity]** A tap opens the destination: the thread, the assistant conversation, or the signal in Intake.
9. **[Suggestion]** Badge: the desktop dock badge = number of waiting destinations (threads plus assistants; signals excluded). Android launcher badges come from notification counts, so the badge happens for free. Signals would be counted too, which differs from desktop.
10. **[Suggestion]** Channels: one per kind, for example "Waiting on you", "Now signals" and "Assistant messages", so the user can mute each in system settings. This replaces the desktop's lack of a toggle.

#### 3.3 Re-read plan on each push

| Push | Re-read | Then |
|---|---|---|
| `session` (any; or empty ids) | `session.query {thread:true}` (all pages). For each assistant whose `mainConversationId` appears in `conversationIds`, or all on empty ids: `session.query {conversationId, sort createdAt desc, limit 1}` | recompute the waiting list |
| `assistant` | `assistant.query` | refresh names and `mainConversationId`s |
| `signal` | `signal.query {view:"to-do"}` (and `{view:"later", limit:1}` if you schedule a snooze wake-up) | recompute the Now list |
| `plugin` | `plugin.query` | refresh source names |
| `conversation` with id = a watched `mainConversationId` [Suggestion] | `conversation.queryMessages {params:{id}, query:{sort:[{field:"position",direction:"desc"}], limit:20}}` | alert on new `senderRole:"assistant"` messages |

Caveat for background use:

- Everything above needs a live WebSocket. The controller has no push sinks to phones in v1:
  - Web Push and presence-aware routing ("desktop idle, send to phone") are post-v1 (spec 01 l.130, l.145; spec 10 l.264-288; spec 14 l.735).
  - Signals never go to sinks (spec 10).
- So the phone must keep the socket open itself, for example from a foreground service.
- **Flag for the ticket:** an Android app that alerts while backgrounded either needs that foreground service, or a new controller-side push sink, which would be a spec change.

---

### 4. Normative spec rules (brief)

- `docs/spec/17-desktop-app.md`:
  - **l.486**: the dock badge counts what is waiting on you.
  - **l.487**: ask to notify at sign-in.
  - **l.488**: the badge counts threads and assistants only; "From runs" is excluded.
  - **l.489-504**: OS notification rules:
    - the title is the thread's title and the body is the question (l.492);
    - at most one notification per thread (l.493);
    - "+N more waiting" and "<subagent> asks:" (l.494);
    - no notification at launch or sign-in (l.495);
    - sign-out clears (l.496);
    - assistant: title is the name, and a click opens the assistant (l.497);
    - key by destination (l.498);
    - a Now signal: title is the source, body is the signal title ("PagerDuty" / "Checkout error rate above 5%"); back from snooze notifies again; leaving Now removes it (l.499-504).
  - **l.505-507**: "Answered anywhere clears everywhere" (ADR 0027).
  - **l.458**: closing the window hides it; notifications keep working.
  - **l.972-973**: in Intake, a new Now signal notifies, nothing else; the badge, Waiting on you and Go show no signals.
  - **l.1179**: the `signal` topic stays subscribed while the window is hidden.
  - **l.3094**: "From runs" in the badge and notifications is post-v1.
- `docs/spec/10-triage-intake-and-notifications.md`:
  - **l.246**: muting.
  - **l.264-288**: router and sinks; presence-aware routing is post-v1; Signals never go to sinks.
  - **l.375-381**: `core.approval`; a question raises no Notification.
  - **l.386-392**: `core.permission-request`.
- `docs/spec/01-overview-and-scope.md` **l.130, l.145**: presence-aware routing and Web Push are post-v1.
- `docs/spec/14-web-app.md` **l.735**: Web Push is post-v1.
- `docs/spec/12-assistants.md` **l.310**: suppressed means not pushed, but still recorded.
- `docs/adr/0012`, `docs/adr/0027`: the Notification model, and answered-anywhere-clears-everywhere.

### 5. Open questions for Rogier

1. Should assistant messages alert on the phone? (Rule 3.1.4.) That is new behaviour and needs a spec amendment.
2. Should permission requests alert on the phone? (Rule 3.1.5.) The desktop is silent on them today.
3. Background delivery: a foreground service holding the WebSocket, or a controller push sink? The second is post-v1 in the spec.
4. Foreground suppression: the whole app (parity), or only the destination on screen?


---

## D. Crew faces, reference images, fonts and tokens (for the Android port)

`F/` = `apps/desktop/src/renderer/faces/`. All line numbers are against commit 738cdb2b1 on `main`.

Summary: a face is a pure function of `(look, pose, size)`. `look` is a pure function of one seed string through a 32-bit FNV-1a hash plus a murmur-style final mix. Everything else is inline SVG geometry in a 45 x 45 user-unit box, painted with CSS variables that resolve to oklch colours per theme. The desktop app is itself held pixel-identical to the design book (`docs/design/crew-bureau-2/crew.js`), so the book is the upstream reference too.

---

### 1. Crew faces

#### 1.1 Files

| File | Role |
|---|---|
| `F/look.ts` (119 lines) | hues, shapes, wardrobe, headwear lists; `hashSeed`; `buildLook`; `buildAssistantLook`; `HERCULE_LOOK` |
| `F/shapes.ts` (69) | `SHAPE_METRICS`, `roundToHundredths`, `buildBodyPath` |
| `F/face.tsx` (118) | `Face` component: draw order, viewBox, `bold` rule, animated variant; `buildHueStyle` |
| `F/face-parts.tsx` (336) | eyes, brows, mouth, pose extras (typewriter, paws, raised arm, z's, plaster, badges) |
| `F/accessories.tsx` (214) | homburg, tache, glasses, monocle, bowtie, watch; headwear cloche, beret, headset |
| `F/face.css` (59) | asleep/away filters, the one animation (paw tap) |
| `F/user-avatar.tsx` (40) | the human user's avatar (letter on a marigold disc, not a face) |
| `F/index.ts` (16) | public exports |
| `F/look.test.ts`, `F/face.test.tsx` | known-answer vectors, pinned path strings, pinned headwear markup |
| `packages/client-core/src/threads/pose.ts` | `POSES`, `decideThreadPose`, pose words |
| Upstream: `docs/design/crew-bureau-2/crew.js` | the book's generator (`hash` crew.js:50-60, `lookFor` crew.js:63-68, `face` crew.js:277+) |

#### 1.2 The seed: which field

For every real colleague the seed is an **id**, never a name or title (only decorative first-run and office faces hash literal strings, see the table) (spec 17 §Design system: "A thread's face is seeded by its session id, not by its title", `docs/spec/17-desktop-app.md:540`). Call sites:

| Colleague | Look function | Seed | Where |
|---|---|---|---|
| Thread (session's own agent) | `buildLook` | `session.id` (UUIDv7 string exactly as the API returns it) | `shell/sidebar-rows.tsx:170`, `office/world/build-world.ts:61`, `screens/thread/agent-request-dock.tsx:51,67` |
| Subagent | `buildLook` | `` `${sessionId}:${subagentId}` `` (`buildAgentFaceSeed`) | `screens/subagents/subagent-face.tsx:16-21` |
| Assistant | `buildAssistantLook` | `assistant.id` | `shell/assistants-section.tsx:84`, `screens/assistant/assistant-screen.tsx:97`, settings |
| Sender chip (agent that sent a message) | assistant or thread look by `sender.face.kind` | `sender.face.seed` | `screens/session/sender-chip.tsx:22-24` |
| Workflow (Intake answers) | `buildLook` | `answer.workflowId` | `screens/intake/signal-answers.tsx:180` |
| Hercule in Intake (inbox zero, source mark) | fixed `HERCULE_LOOK` (sky, round, tache + homburg, no headwear) | none | `F/look.ts:49-54`, `screens/intake/inbox-zero.tsx:132`, `screens/intake/source-mark.tsx:56` |
| Decorative, first run / office | `buildLook` | literal strings: `"Hercule"`, `"Triage"`, `` `New thread in ${projectName}` `` | `screens/first-run/account-step.tsx:133`, `screens/office/room-pieces.tsx:194,223`, `screens/first-run/all-set.tsx:62` |

**Open question for the ticket, not resolved here:** "Hercule" has three different faces in the desktop app today:
1. `HERCULE_LOOK` in Intake: sky, round, tache + homburg.
2. `buildLook("Hercule")` in the first-run account step (account-step.tsx:133): grape, wide, tache + bowtie.
3. The real Hercule assistant through `buildAssistantLook(<its id>)`: hashed from its id, wearing headwear.

The book's `CAST` table (crew.js:19-48) hand-casts some names (Ada, Hercule, Triage...). **The app never uses the cast table: every seed is hashed** (`F/look.test.ts:33-34`). Do not port `CAST`.

#### 1.3 The hash (`F/look.ts:61-71`, identical to crew.js:50-60)

```ts
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 16;
  return h >>> 0;
}
```

FNV-1a 32-bit over **UTF-16 code units**, then a final mix (xorshift 13, multiply by 0x85EBCA6B, xorshift 16). Result is an unsigned 32-bit integer.

Constants: `2166136261 = 0x811C9DC5` (FNV offset basis), `16777619 = 0x01000193` (FNV prime), `2246822507 = 0x85EBCA6B`.

Kotlin port (do it in `UInt`, which makes every step below safe):

```kotlin
fun hashSeed(text: String): UInt {
    var h = 0x811C9DC5u
    for (ch in text) {                 // Kotlin Char = one UTF-16 code unit, same as charCodeAt
        h = h xor ch.code.toUInt()
        h *= 0x01000193u               // UInt * wraps mod 2^32, same as Math.imul
    }
    h = h xor (h shr 13)               // UInt shr is logical, same as >>>
    h *= 0x85EBCA6Bu
    h = h xor (h shr 16)
    return h
}
```

Port hazards:
- **Signed Int is wrong for modulo.** With `Int`, `h % 8` is negative for any hash with the high bit set. Use `UInt` (or `and 7` / `ushr` everywhere and `.toUInt()` before `% 3`). Vectors `"a"` (0x90a2358d), `"Hercule"` (0xb18ce7ff) and `"0199b000-0000-7000-8000-000000000000"` (0xff224455) have the high bit set and catch a signed port.
- **Code units, not code points.** Iterate `text` chars (or `text[i].code`), never `codePoints()`. Vector `"😀"` (two code units, a surrogate pair) catches this.
- `>>>` = `shr` on `UInt` (or `ushr` on `Int`). `Math.imul` = wrapping 32-bit multiply.

#### 1.4 Picking the look (`F/look.ts:1-17, 33-42, 86-119`)

Lists, in hash order:

```
HUES     = [iris, teal, orchid, lime, sky, peach, mint, grape]        // look.ts:2
SHAPES   = [egg, tall, round, wide]                                    // look.ts:7
WARDROBE = [ [], [homburg], [bowtie], [tache], [monocle], [watch],
             [glasses], [tache, bowtie] ]                              // look.ts:33-42, each in drawing order
HEADWEAR = [cloche, beret, headset]                                    // look.ts:15
```

```
h        = hashSeed(seed)
hue      = HUES[h % 8]               // bits 0-2
shape    = SHAPES[(h >>> 4) % 4]     // bits 4-5
wardrobe = WARDROBE[(h >>> 8) % 8]   // bits 8-10
headwear = null                      // threads never wear headwear
```

Assistant (`buildAssistantLook`, look.ts:109-119):

```
look      = buildLook(assistantId)            // same hue, shape, wardrobe
headwear  = HEADWEAR[(hashSeed(assistantId) >>> 12) % 3]   // bits 12+, modulo 3 (not a bit mask)
accessories = look.accessories minus "homburg"            // one head wears one hat
```

The caching/freezing in look.ts:73-97 and 99-118 is a React memo optimisation only; it does not affect output.

#### 1.5 Known-answer vectors

From `F/look.test.ts:15-40` (computed by the book's own `hash`/`lookFor`):

| seed | hash | hue | shape | accessories |
|---|---|---|---|---|
| `""` | 1698511862 | mint | wide | tache |
| `"a"` | 2426549645 | peach | egg | watch |
| `"0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60"` | 2687217523 | lime | wide | tache, bowtie |
| `"0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c61"` | 2737239707 | lime | tall | glasses |
| `"0199a3c4-0d12-7a55-8b10-3e9f7c21d0aa"` | 301455944 | iris | egg | bowtie |
| `"Fix 3-D Secure checkout for EU cards"` | 1898525329 | teal | tall | bowtie |

Extra vectors I computed by running the repo's `F/look.ts` with bun 1.4.3 (a scratch script that was not kept). "Assistant" columns are `buildAssistantLook` of the same string.

| seed | hash (dec) | hash (hex) | hue | shape | thread accessories | assistant accessories | assistant headwear |
|---|---|---|---|---|---|---|---|
| `""` | 1698511862 | 0x653d3bf6 | mint | wide | tache | tache | cloche |
| `"a"` | 2426549645 | 0x90a2358d | peach | egg | watch | watch | cloche |
| `"Hercule"` | 2978801663 | 0xb18ce7ff | grape | wide | tache+bowtie | tache+bowtie | beret |
| `"Triage"` | 2084797344 | 0x7c437ba0 | iris | round | tache | tache | cloche |
| `"Ada"` | 1100229590 | 0x41942bd6 | mint | tall | tache | tache | headset |
| `"0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60"` | 2687217523 | 0xa02baf73 | lime | wide | tache+bowtie | tache+bowtie | cloche |
| `"0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c61"` | 2737239707 | 0xa326f69b | lime | tall | glasses | glasses | cloche |
| `"0199a3c4-0d12-7a55-8b10-3e9f7c21d0aa"` | 301455944 | 0x11f7da48 | iris | egg | bowtie | bowtie | beret |
| `"0199a3c2-7b41-7e2a-9c3d-5f1e2a8b4c60:toolu_01ABC"` (subagent seed) | 1116744836 | 0x42902c84 | sky | egg | monocle | monocle | headset |
| `"Fix 3-D Secure checkout for EU cards"` | 1898525329 | 0x71293291 | teal | tall | bowtie | bowtie | beret |
| `"New thread in webshop"` | 2234771898 | 0x8533e9ba | orchid | wide | homburg | none (homburg dropped) | cloche |
| `"héllo"` | 2085756404 | 0x7c521df4 | sky | wide | watch | watch | cloche |
| `"日本語"` | 3389669919 | 0xca0a421f | grape | tall | bowtie | bowtie | cloche |
| `"😀"` (surrogate pair) | 819814735 | 0x30dd614f | grape | egg | homburg | none | headset |
| `"0199b000-0000-7000-8000-000000000000"` | 4280435797 | 0xff224455 | peach | tall | monocle | monocle | headset |
| `"0199b000-0000-7000-8000-000000000001"` | 1893881932 | 0x70e2584c | sky | egg | none | none | beret |

Element-count vectors per pose (useful to check structure, not pixels): `F/face.test.tsx:239-272`.

#### 1.6 Poses: list, triggers, words

`POSES = [working, waiting, idle, asleep, failed, paused, done, away]` (`packages/client-core/src/threads/pose.ts:10-19`). There is **no "speaking" pose**.

Thread / assistant pose (`decideThreadPose`, pose.ts:95-101). First match wins:
1. `session.openRequests.length > 0` -> `waiting`
2. `session.resumeHeld || isSettled(session)` (cannot resume / crash-loop guard), or the session's runner is known and `runner.connectivity !== "online"` -> `away`. A runner missing from the list counts as connected (pose.ts:74-75).
3. `session.status === "exited"` -> `asleep`
4. `session.status === "idle"` -> `idle`
5. otherwise (queued, starting, busy) -> `working`

`decideThreadPose` never returns `failed`, `paused`, `done` (pose.ts:91-93). Assistant: `idle` when it has no session yet, else `decideThreadPose` (`packages/client-core/src/assistants/rows.ts:29-32`). Subagent (`packages/client-core/src/subagents/describe.ts:105-126`): running -> `waiting` if it waits on the user else `working`; completed -> `done`; failed -> `failed`; stopped -> `idle`.

Accessible text: faces are `aria-hidden` (face.tsx:28-31, 88). The host element writes the label plus the pose words (`POSE_WORDS`, pose.ts:31-40): working "working", waiting "waiting on you", idle "idle", asleep "asleep", failed "failed", paused "paused", done "done", away "can't be reached". Use these for Android `contentDescription`, e.g. "Fix 3-D Secure checkout for EU cards, waiting on you" (spec 17 line 555).

#### 1.7 Geometry: viewBox, sizes, draw order

- `viewBox="3 1 45 45"` (face.tsx:85, 103). The drawing's user units start at x 3, y 1. Scale = `size / 45`. `overflow: visible` (face.css:7): the badge ring reaches y 46.6 and must not be clipped.
- `size` is CSS px (= Android dp), square. Sizes in use: 16, 18, 20, 22, 24, 26, 28, 30, 34, 38, 46, 48, 64, 68, 76, 88. E.g. sidebar rows 24, assistants section 22, transcript message 34 (`screens/session/messages.tsx:33`), sender chip 18, subagent status card 26, inbox zero 88.
- `bold = size < 30` (face.tsx:48): thicker strokes and eyes scaled 1.2. Test: 29 px gives eye rx 2.4, glint r 0.84; 30 px gives 2 and 0.7 (face.test.tsx:84-100).

Draw order (face.tsx:55-80), each later item over the earlier:
1. Body shade: body path, fill `--who-shade`.
2. Body: same path, fill `--who`, `translate(0 -2)`.
3. Highlight: ellipse cx 17.4, cy `topY + 6.4` (unrounded), rx 3.6, ry 2.1, `rotate(-30 17.4 cy)`, fill #fff, opacity .34.
4. Blush: ellipses (15, 31.4) and (33, 31.4), rx 2.6, ry 1.6, fill `--blush` (a colour with alpha).
5. Eyes, at x 19 and x 29 (face-parts.tsx:69-76).
6. Brows.
7. Mouth (moves to y 34.4 under a tache, else 32.6).
8. Accessories, in wardrobe order.
9. Headwear.
10. Pose extras (typewriter + paws, raised arm, z's, plaster + badge, badges).

Body shapes (`F/shapes.ts:19-24`, path builder shapes.ts:43-68):

| shape | topY | bottomY | widestY | halfWidth |
|---|---|---|---|---|
| egg | 9.6 | 42.4 | 30.5 | 14.4 |
| tall | 8.4 | 42.4 | 31 | 12.8 |
| round | 11 | 42.4 | 29.5 | 15.4 |
| wide | 12.6 | 42.4 | 31 | 16.2 |

Path: `M24 top C (24+0.6hw) top, right upperCY, right widest C right lowerCY, (24+0.7hw) bottom, 24 bottom C (24-0.7hw) bottom, left lowerCY, left widest C left upperCY, (24-0.6hw) top, 24 top Z`, where `upperCY = widest - (widest-top)*0.52` and `lowerCY = widest + (bottom-widest)*0.62`. Control values are rounded to hundredths; `left`/`right` are not. The four resulting strings are pinned in `F/face.test.tsx:28-49`. For example, egg is `M24 9.6C32.64 9.6 38.4 19.63 38.4 30.5C38.4 37.88 34.08 42.4 24 42.4C13.92 42.4 9.6 37.88 9.6 30.5C9.6 19.63 15.36 9.6 24 9.6Z`.

Rounding: `roundToHundredths(v) = Math.round(v*100)/100` (shapes.ts:30-32). JS `Math.round` rounds ties toward +infinity. `java.lang.Math.round` matches. **`kotlin.math.round` is half-to-even and does not match.** Values such as `7.800000000000001` are plain IEEE doubles; Kotlin computes the same double, which only matters if the port emits path strings for comparison.

Where to copy path data from (all inline constants, copy verbatim):
- Eyes per pose: face-parts.tsx:32-66. EYE_Y = 26.6. Glint: circle (x+0.7, y-0.9), r 0.7*scale, #fff, opacity .9 (face-parts.tsx:27-29). Stroke widths: eyes 1.5 / bold 1.9; brows 1.25 / 1.6; mouth 1.45 / 1.8; all round caps, ink `--face-ink`.
- Brows: face-parts.tsx:79-91 (only waiting, working, failed have brows).
- Mouths: face-parts.tsx:98-121. A tache hides the working, paused, asleep, away and idle mouths; waiting, done and failed still show, 1.8 lower.
- Badge: face-parts.tsx:129-154. Circle (40, 39) r 5.6, ring stroke 2 in `--badge-ring` (falls back to `--surface`). Outlined variant adds an r 4.4 ring in `--line` at .8.
- Typewriter and paws: face-parts.tsx:157-190. Paw paint is `--who-shade` with a `--face-ink` stroke at opacity .25 and width .6. Paws are ellipses (18|30, 40.4), rx 2.8, ry 1.9.
- Pose extras: face-parts.tsx:206-336. Raised arm and `--you` palm for waiting (218-249). z's for asleep (250-260). Plaster with literal oklch colours and the `--fail` badge for failed (261-290). `--ok` badge with a check for done (291-305). Pause badge (306-318). Away badge with an arc (319-332).
- Accessories: accessories.tsx:14-131. The homburg is relative to `topY` through `computeHatY(dy) = roundToHundredths(topY + dy)`. Tache, glasses, monocle, bowtie and watch are fixed coordinates.
- Headwear: accessories.tsx:142-214. The cloche is relative to topY and rounded. The beret's `topY + 1.8` and `topY - 2.4` are unrounded. The headset band's control y is `topY - 1`, also unrounded. The pinned markup for egg/tall x cloche/beret/headset is in `F/face.test.tsx:130-161`.

SVG path grammar used: `M C S L Z H V` (body, hats), lowercase `q t h l c v z` (eyes, mouths, tache, bowtie, badges), and **one elliptical arc** `a3 3 0 0 1 4.6 0` (away badge, face-parts.tsx:325). Hand-building with `android.graphics.Path` is error-prone. Use a full SVG path parser, e.g. Compose `androidx.compose.ui.graphics.vector.PathParser().parsePathString(d).toPath()`. Before relying on it, check that it handles `S`, `t` and `a`. Feed it the same `d` strings.

Other SVG features needed: `transform="rotate(deg cx cy)"` on ellipses, groups and the plaster; `translate(0 -2)`; group `opacity`; `stroke-opacity`; `stroke-linecap="round"`; `stroke-linejoin="round"` (check mark); `stroke-dasharray=".1 1.8"` with round caps for the dotted away mouth (Android: `PathEffect.dashPathEffect(floatArrayOf(0.1f, 1.8f))`).

**Text inside faces:** the asleep z's are `<text>` "z" at (37.4, 15) size 10 and (42.6, 8.4) size 7, `--font-ui` (Bricolage Grotesque) weight 760, fill `--muted` (face-parts.tsx:252-258). `UserAvatar` is the letter on a 32-unit viewBox: circle r 15 in `--you`, hairline `oklch(0 0 0 / .08)`, text 15 px weight 700 at y 21.2 in `--face-ink`, first code point upper-cased (user-avatar.tsx:22-37). The port needs Bricolage loaded for these.

#### 1.8 Whole-face filters (face.css:9-15)

- `.cr--asleep { filter: saturate(0.5) }`
- `.cr--away { opacity: 0.55; filter: saturate(0.3) }`

These apply to the composed face, not to each shape: render to a layer, then apply. The CSS `saturate()` matrix uses coefficients 0.213 / 0.715 / 0.072, the same as Android `ColorMatrix.setSaturation`. Check against a reference capture whether Chromium applies it in sRGB or linear space before calling the port identical.

#### 1.9 Colours of a face

`buildHueStyle(hue)` sets `--hue: var(--hue-<hue>)` on the root (face.tsx:21). tokens.css derives the colleague colours from it (`apps/desktop/src/renderer/styles/tokens.css:507-513`):

```css
--who:       oklch(var(--char-l) var(--char-c) var(--hue));
--who-shade: oklch(calc(var(--char-l) - var(--char-shade)) calc(var(--char-c) * 1.05) var(--hue));
--who-ink:   oklch(var(--char-ink-l) calc(var(--char-c) * 1.05) var(--hue));
--who-tint:  oklch(var(--char-tint-l) var(--char-tint-c) var(--hue));
```

Hue angles (tokens.css:106-113): lime 132, mint 166, teal 198, sky 240, iris 282, grape 312, orchid 345, peach 52 (reserved: you 78, fail 27). Per-theme `--char-*` numbers are in §4.

Other paints a face uses:
- Per theme: `--face-ink` (eyes, brows, mouth, tache, glasses), `--blush` (with alpha), `--hat` (homburg, bowtie, typewriter, all headwear), `--brass` (monocle chain, watch), `--you` (raised palm), `--fail` / `--ok` (badges), `--raised` + `--line` (outlined badges), `--surface` (badge ring fallback, typewriter keys at .55), `--muted` (z's, away symbol), `--ink` (pause symbol).
- Literal: highlight #fff .34; glint #fff .9; monocle glass `oklch(1 0 0 / .18)`; watch face `oklch(0.97 0.02 90)`; plaster `oklch(0.95 0.03 75)` / stroke `oklch(0.7 0.05 60)` / pad `oklch(0.85 0.05 65)`.

Context dependency: the badge ring and the typewriter keys take the colour of the surface behind the face (`--badge-ring`, else `--surface`). The port must pass that in.

#### 1.10 Animation

Only one: the working pose's paws tap, and only when the caller passes `animated` (face.tsx:53, 81-117; face.css:34-59).

- `cr-tap 0.52s ease-in-out infinite alternate`. The second paw has `animation-delay: 0.26s`.
- Keyframes: `translateY(0)` to `translateY(-1.3 user units)`. In CSS that is `calc(-1.3 / 45 * 100%)` of the face's height, i.e. `-1.3 * size / 45` px.
- `ease-in-out` = cubic-bezier(0.42, 0, 0.58, 1).
- Off when `prefers-reduced-motion` is not `no-preference` (live). The Android equivalent is the system animator scale / "Remove animations".
- Animated only for the face of the message the open thread's agent is writing while its turn runs (`screens/session/messages.tsx:55`, `screens/assistant/assistant-screen.tsx:213`). Spec 17 §Rules rule 2 (`docs/spec/17-desktop-app.md:1865-1869`) says faces are otherwise still everywhere.

The book also animates blink (7.2 s), the waving arm (3.6 s) and the z's (3.4 s) (`docs/design/crew-bureau-2/system.css:128-190`). **The app leaves all three out on purpose** (spec 17 rule 2; face.tsx:32-35; face.test.tsx:189-192). The port should leave them out as well.

---

### 2. Golden tests and reference images

- **No face PNGs are checked in.** The only committed PNGs are book covers (`docs/design/crew-bureau/cover-{light,dark}.png`, `docs/design/c0-crew/cover-*.png`) and c0-era baselines `docs/design/shared/baseline/{app-shell,intake-view}-{light,dark}.png`. None of them is a face reference.
- **Specimen sheet (the face golden).** `apps/desktop/src/renderer/specimens/index.html` + `specimens.tsx` draw every cell of `specimens/cells.ts` with the app's components. `specimens/reference.html` + `reference.ts` draw the same cells with the book's `crew.js`. Face cells (cells.ts:179-300):
  - all 8 poses of a plain iris egg at 22, 24, 30, 34 and 68;
  - all 32 wardrobe x shape cells at 34;
  - tache poses at 22 and 34;
  - the three UUID seeds at 34;
  - avatars at 24 and 28;
  - headwear x shape at 34;
  - headwear at 16, 24 and 48 idle, plus waiting and asleep at 24.
  
  The dev server serves the sheet at `/specimens/` (`?theme=whitehaven|orient-express`, `?animated=1`).
- **`pnpm compare:bureau`** (`apps/desktop/scripts/compare-bureau.ts`, `bureau-capture.ts`):
  - It first checks that `tokens.css` and the fonts are byte-identical to the book's.
  - It captures both sheets at 1440 x 900, device scale 2, `--force-color-profile=srgb` (`scripts/sheet-server.ts:81-82`).
  - It runs in Whitehaven and Orient Express only (`specimens/sheet-themes.ts:12`).
  - It writes `apps/desktop/out/bureau-compare/<theme>/{reference,app,diff}.png` plus region PNGs. `out/` is not checked in; generate it on a Mac.
  - Pass rule: zero differing pixels, where a pixel differs when any channel is off by more than `CHANNEL_TOLERANCE = 8` (`scripts/compare-bitmaps.ts:37`; `bureau-capture.ts:1376-1378`).
  
  **These `reference.png` captures are the best golden images for an Android pixel test.** The same harness can capture all five themes for a check by eye (`ALL_THEMES`, sheet-themes.ts:19).
- **Book pages:** `docs/design/crew-bureau-2/index.html` (the book; specimen block styles `.bk-specimen` at line 801) and `desktop/*.html` and **`mobile/*.html`** (assistant, decision, intake, lock, office, session-active, session-empty, settings). The mobile pages are the closest existing design for an Android client.
- **Unit-level goldens:** pinned body path strings (`F/face.test.tsx:28-49`), pinned headwear markup (130-161), mouth-under-tache values (102-126), element counts (239-272), hash vectors (`F/look.test.ts:15-40`).

---

### 3. Fonts

The book copy (`docs/design/crew-bureau-2/fonts/`) and the app copy (`apps/desktop/src/renderer/styles/fonts/`) are **byte-identical** (I checked with `cmp`; `compare:bureau` enforces it). `docs/design/crew-bureau-2/fonts/LICENSES.md` says they were downloaded once from the fontsource CDN and nothing is fetched at runtime.

| File | Family | Designer / origin | Axes | Used for | Licence |
|---|---|---|---|---|---|
| `bricolage-grotesque-latin-standard-normal.woff2` (131,548 B) | Bricolage Grotesque | Mathieu Triay (Google Fonts, via fontsource) | wght 200-800, opsz 12-96, wdth 75-100 | all UI text, face z's, avatar letter | SIL OFL 1.1 |
| `bricolage-grotesque-latin-ext-standard-normal.woff2` (53,588 B) | Bricolage Grotesque | same | same | Latin Extended subset | SIL OFL 1.1 |
| `limelight-latin-400-normal.woff2` (23,080 B) | Limelight | Nicole Fally, Sorkin Type | one weight | wordmark, logo lettering, large numerals only | SIL OFL 1.1 |
| `recursive-latin-full-normal.woff2` (304,988 B) | Recursive | Arrow Type | MONO, CASL, CRSV, wght 300-1000 | code, diffs, commands, branch names only | SIL OFL 1.1 |

There is no OFL.txt in the folder. LICENSES.md only links https://openfontlicense.org/open-font-license-official-text/. An Android build that ships the fonts should bundle the OFL text.

`@font-face` rules (`tokens.css:28-55`), all `font-display: block`:
- Bricolage latin: `font-weight: 200 800; font-stretch: 75% 100%`, unicode-range `U+0000-00FF, U+0131, U+0152-0153, ...` (line 34).
- Bricolage latin-ext: unicode-range line 42.
- Limelight 400.
- Recursive `300 1000`.

Stacks (tokens.css:59-64):
- `--font-ui: "Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif`
- `--font-deco: "Limelight", "Bricolage Grotesque", serif`
- `--font-mono: "Recursive", ui-monospace, "SF Mono", monospace`
- `--mono-axes: "MONO" 1, "CASL" 0.5, "CRSV" 0`, applied with `font-variation-settings` on code elements.

Body: `font-optical-sizing: auto` (`styles/base.css:71`). The opsz axis tracks the font size, so an Android port should set `opsz` from the size.

Weights: `--w-regular 400`, `--w-medium 520`, `--w-bold 640` (tokens.css:75-77). Non-standard weights such as 520, 640 and 760 need variable-font `FontVariation.weight` on Android (API 26+). Android `Font()` does not take woff2; the same families are OFL TTF/variable files on Google Fonts and the Arrow Type GitHub.

Desktop-only: a `"Password bullet"` face from `local("Geneva")`, U+2022 (`styles/controls.css:412-418`). It is macOS-specific and not needed on Android.

Not Bureau: `packages/ui/src/fonts/` holds Onest and IBM Plex Mono with OFL texts. That is the **web app's** set. Do not port it for the Bureau look.

`e2e/desktop/fonts.test.ts` rules (spec 17 §Performance rule 6):
- Only the Bricolage Latin file is preloaded (`apps/desktop/src/renderer/index.html:15-21`, `crossorigin` required).
- At the welcome screen the loaded set must be exactly: Bricolage latin loaded, Bricolage latin-ext unloaded, Limelight loaded, Recursive unloaded, Password bullet unloaded (lines 45-53).
- The font requests must be exactly `[bricolage latin (from the preload), limelight]` with no double fetch, and there must be no preload console warnings (lines 66-77).
- The Android equivalent is lazy loading: only the UI face at start.

---

### 4. tokens.css and themes

Copies: `docs/design/crew-bureau-2/tokens.css` and `apps/desktop/src/renderer/styles/tokens.css` are byte-identical (513 lines; `cmp` passes, and compare:bureau enforces it). The older `docs/design/crew-bureau/tokens.css` (first edition) and `docs/design/c0-crew/tokens.css` (the original Crew) are history; the app follows the second edition (spec 17 §Design system, ~line 523).

**How colours are written:**
- Plain `oklch(L C H)`, sometimes with `/ alpha`.
- Derived tokens use `color-mix(in oklab, ...)` (tokens.css:471-504: `--focus`, `--hover`, `--press`, `--selected`, `--field`, glass).
- Per-colleague colours use `oklch()` with `calc()` over per-theme numbers (tokens.css:507-513).
- No `light-dark()` and no relative-colour syntax.

**Theme selection:** the `data-theme` attribute on `<html>`, set by `apps/desktop/src/renderer/public/theme-init.js` before the first paint.
- Selectors (tokens.css:131-133, 202, 269-270, 337, 404): `:root` / `[data-theme="whitehaven"]` / `[data-theme="light"]`, `"styles"`, `"orient-express"` / `"dark"`, `"nile"`, `"end-house"`.
- Themes sit on attribute selectors so a preview can nest one theme inside another.
- Theme ids: `THEMES = [whitehaven, styles, orient-express, nile, end-house]`. Day themes are whitehaven and styles; night themes are orient-express, nile and end-house (`apps/desktop/src/ipc/appearance.ts:11-23`).
- Default: follow the system, Whitehaven by day, Orient Express by night, glass 40% (`appearance.ts:49-60`).

| Theme | Kind | Character (tokens.css:19-24) | Block |
|---|---|---|---|
| Whitehaven | light, flagship | ivory and green-black lacquer | 130-199 |
| Styles | light, warm | parchment and walnut | 201-266 |
| Orient Express | dark, flagship | warm wood-black and ivory, never navy | 268-334 |
| Nile | dark | green-black and papyrus | 336-401 |
| End House | dark | claret and aubergine | 403-468 |

Every theme block redefines the same set of tokens:
- surfaces: `--bg`, `--surface`, `--raised`, `--sunken`
- text: `--ink`, `--muted`, `--faint`
- lines: `--line`, `--line-soft`
- crew numbers: `--char-l`, `--char-c`, `--char-shade`, `--char-ink-l`, `--char-tint-l`, `--char-tint-c`
- face paints: `--face-ink`, `--blush`, `--hat`
- reserved colours: `--accent` / `-fg` / `-ink`, `--you` / `-ink` / `-tint`, `--fail` / `-ink` / `-tint`, `--ok` / `-tint`, `--brass`
- project tints `--proj-*`; glass edge, `--scrim`, shadows; the office `--room-*` palette

Theme-independent tokens (tokens.css:58-121): type scale (`--t-11` to `--t-20`, `--t-num 26px`), 4 px space grid, radii, motion (`--dur-1/2/3` 120/200/320 ms, `--ease-out cubic-bezier(.2,.8,.2,1)`, `--ease-spring cubic-bezier(.34,1.5,.64,1)`), hue angles, `--glass-level`.

Colour doctrine (tokens.css:3-17): colour means who. Each colleague owns one hue. State is a pose, never a colour. Four reserved colours belong to no colleague: `--accent` (the one filled button), `--you` (marigold, addressed to you), `--fail` (tomato), `--ok` (green). `--brass` is ornament only.

Crew numbers per theme (tokens.css:146-151, 214-219, 282-287, 349-354, 416-421):

| theme | char-l | char-c | char-shade | char-ink-l | char-tint-l | char-tint-c |
|---|---|---|---|---|---|---|
| whitehaven | 0.78 | 0.125 | 0.085 | 0.49 | 0.95 | 0.03 |
| styles | 0.765 | 0.13 | 0.085 | 0.48 | 0.935 | 0.035 |
| orient-express | 0.76 | 0.12 | 0.09 | 0.8 | 0.3 | 0.045 |
| nile | 0.77 | 0.12 | 0.09 | 0.81 | 0.3 | 0.045 |
| end-house | 0.77 | 0.12 | 0.09 | 0.82 | 0.31 | 0.05 |

Verbatim lines (Whitehaven, tokens.css:135-167):

```css
--bg: oklch(0.965 0.005 95);
--surface: oklch(0.99 0.003 95);
--ink: oklch(0.22 0.014 165);
--face-ink: oklch(0.23 0.025 165);
--blush: oklch(0.72 0.14 15 / 0.38);
--hat: oklch(0.3 0.012 165);
--accent: oklch(0.45 0.09 164);
--you: oklch(0.8 0.155 78);
--fail: oklch(0.62 0.19 27);
--ok: oklch(0.52 0.12 150);
--brass: oklch(0.72 0.085 85);
```

Orient Express (tokens.css:272-303): `--bg: oklch(0.195 0.012 50); --ink: oklch(0.94 0.012 85); --face-ink: oklch(0.22 0.03 55); --hat: oklch(0.36 0.014 50); --you: oklch(0.82 0.15 80);`.

**oklch -> sRGB in the repo.** `apps/desktop/src/main/window-background.test.ts:40-61` has a ready converter (oklch -> OKLab -> LMS cubed -> linear sRGB -> transfer function -> 8-bit round) that matches Chromium. It is a direct template for Kotlin. Its outputs are pinned for `--bg` in `apps/desktop/src/main/window-background.ts:17-23`: whitehaven `#f4f3f0`, styles `#f5eee3`, orient-express `#1a1310`, nile `#0e1714`, end-house `#1d1217`. The page overrides `--bg` with exactly these hex values (`styles/base.css:11-48`) so the tiles match the native window.

Converted values (scratch scripts that were not kept, using that formula; the ticket's token script replaces them):

**Caveat that blocks treating these as exact:** "OOG" rows are outside the sRGB gamut. The hex shown there is per-channel clipped, but Chromium may gamut-map (reduce chroma) instead of clipping, and the two differ visibly at high chroma. Also, on a real Mac the app renders in the display's P3 profile, so OOG colours show more saturated than any sRGB hex. In-gamut rows are exact. Pin OOG rows from the `compare:bureau` reference captures (sRGB-forced) or a confirmed gamut-mapping rule. On Android, consider building colours in Display P3 (`ColorSpaces.DisplayP3`) to match what Mac users see.

Crew colours, sRGB (Whitehaven / Orient Express; all five themes are in the script output):

| hue | WH --who | WH --who-shade | WH --who-ink | WH --who-tint | OE --who | OE --who-shade | OE --who-ink | OE --who-tint |
|---|---|---|---|---|---|---|---|---|
| iris | #abadff* | #9191ec* | #5754a8 | #ebedff* | #a5a7fb* | #898ae0 | #b1b3ff* | #2a2b44 |
| teal | #2ccfd4* | #00b5ba* | #00757b* | #d8f5f6 | #30c8cc* | #00acb1* | #35d6db* | #0a3536* |
| orchid | #f096ca | #d67aaf | #923c71 | #fee7f3 | #e791c2 | #cb74a7 | #f79cd0 | #3e2433 |
| lime | #99c872 | #7eae53 | #436f0a | #e7f3df | #94c16f | #78a54f | #9fcf78 | #25331a |
| sky | #64c1ff* | #41a6e6* | #0067a2* | #ddf2ff* | #62bbf5* | #3e9eda* | #6ac8ff* | #173142 |
| peach | #f6a069* | #dc834a* | #984500* | #ffe9dd* | #ed9a67 | #d17d46 | #fea66f | #402718 |
| mint | #5bd1a5* | #2fb68a* | #00774f* | #ddf5ea | #59c99f | #2ead83 | #61d7ab | #143529 |
| grape | #d2a0f1 | #b884d8 | #794795 | #f5e9fe | #cb9ae8 | #af7dcd | #d9a6f8 | #35273e |

`*` = at least one of that row's four colours is out of sRGB gamut. The script flags by row, so treat every starred row as unverified.

Display-P3 equivalents (same caveat; `!` = outside P3 too): Whitehaven --who: iris #abadff, teal #66ccd2, orchid #e39ac7, lime #a3c77c, sky #7cbffa, peach #eaa373, mint #7bcea8, grape #caa2ec. Orient Express --who: iris #a5a7f5, teal #64c5cb, orchid #db95c0, lime #9ec078, sky #78b9f0, peach #e19e70, mint #78c7a2, grape #c39ce3.

Face paints per theme, sRGB (`@a` = alpha):

| token | whitehaven | styles | orient-express | nile | end-house |
|---|---|---|---|---|---|
| --bg (pinned) | #f4f3f0 | #f5eee3 | #1a1310 | #0e1714 | #1d1217 |
| --surface | #fcfcf9 | #faf6ed | #211a17 | #141f1b | #26191f |
| --raised | #ffffff | #fefcf7 | #2a231e | #1c2824 | #302228 |
| --ink | #151d19 | #2c1e17 | #efebe2 | #f1edde | #f5ede7 |
| --muted | #4e5853 | #604e43 | #bab3a9 | #b8b9a9 | #c5b2b1 |
| --line | #d8dad5 | #dcd1c3 | #39312c | #293631 | #3f3037 |
| --face-ink | #11211a | #301c13 | #25170d | #0c1f17 | #25151e |
| --blush | #ef7d88 @.38 | #ed7477 @.42 | #e87782 @.42 | #e87782 @.40 | #ee7c90 @.42 |
| --hat | #28302c | #402e25 | #433b37 | #35403c | #46393f |
| --you | #f4af2d | #f4aa1d | #f7b83d | #f8bd40 | #fabb41 |
| --fail | #e24942 | #de463f | #ef675a | #ef675a | #f26a5d |
| --ok | #287c42 | #21763c | #76cf8a | #7cd591 | #7cd591 |
| --brass | #bda165 | #bc985b | #c19f61 | #bba265 | #c4a269 |
| --accent | #106548 | #256041 | #73c59e | #e0d199 | #8bcfad |

Note: when a theme's `--bg` is converted from its oklch in tokens.css, the result equals the pinned window hex, which validates the formula for in-gamut colours.

Other appearance state (not colours): glass level. `theme-init.js` sets `--glass-percent`, and `base.css:56` turns it into `--glass-level`. `data-solid-glass` is set under Reduce transparency or 0% glass. `prefers-reduced-transparency` forces glass to 0 (tokens.css:124-128). On Android, glass is likely out of scope; the solid look is glass level 0.

**Spec 17 pointers** (`docs/spec/17-desktop-app.md`):
- §Design system (line 519): the book is the pixel reference; faces are seeded by id (540); poses (542); accessible name (555).
- §Native behaviour (~444-449): the window background is the sRGB `--bg`, and the theme follows the system live.
- §Settings › Appearance (line 1485, table 1491-1492, mechanics 1515-1520): the five themes; Follow the system with a day and a night theme; glass; theme applied before the first paint; changes snap with no transition.
- §Rules (line 1851), rule 2 (1865-1869): faces are still, except the working paws of the message being written.

One divergence to note: spec 17 line 555 says a face's accessible name is "label, pose words", but the code makes the face `aria-hidden` and puts that text on the host row (face.tsx:28-31). The result for a screen reader is the same.


---

## E. Open items for the ticket

Each part also lists its own smaller gaps at its end: A1 §7, A2 §4 and C §5, and D's open questions in place. These are the items that cut across parts, or that the ticket has to decide.

**Transport and deployment**

1. **How the phone reaches the controller.** The default bind is `127.0.0.1:4937`, so a phone cannot reach it out of the box.
   - Spec 13 §19 describes optional Tailscale-managed HTTPS on a second port (default 4938).
   - In this commit the controller serves **plain HTTP only**. Hercule Home has a `tls/` directory (`packages/home/src/paths.ts:167`), but no code serves TLS.
   - The supported way to reach it is a bind to the machine's tailnet address, for example `-c bind.host=100.101.102.103`.
     - The controller warns once at startup when it binds outside loopback and the tailnet ranges (`100.64.0.0/10` and `fd7a:115c:a1e0::/48`), including a wildcard bind. It never refuses to start (`apps/controller/src/http/perimeter.ts`).
     - Tailscale's WireGuard tunnel already encrypts the traffic.
   - The ticket should plan for `http://<tailnet-ip>:4937` now, and for HTTPS when spec 13 §19 lands.
   - Android blocks cleartext HTTP by default, so plain HTTP needs a `network_security_config` that allows it for the controller's host.
2. **Device credential.** Login tokens roll forward 30 days from last use, and no operation reports the new expiry. An API key never expires and is revoked by hand. Two choices:
   - **API key.** The phone logs in once, mints a key with `apiKey.create`, and keeps the key in Keystore-backed storage. "Sign out" then calls `apiKey.revoke`, not `auth.logout`, which refuses a key with 400.
   - **Login token.** The phone keeps the login token and treats a 401 as "log in again".

**Live socket**

3. **No idle timeout is set by Hercule.** Bun's default is 120 s. I did not test it, because the RPC `Ping` every 5 s and the `ping` RPC every 30 s keep the socket busy anyway.
4. **Background alerts need a live socket.** Push to phones is post-v1 in the spec. Alerting while the app is in the background therefore means a foreground service that holds the WebSocket (C §5, question 3). That costs battery and a persistent notification. This is a product decision.
5. **Not observed on the wire:**
   - `session:<id>:stream` and `:tap` deltas with real content;
   - a `session` invalidate with real `conversationIds`;
   - the 5-minute ticket expiry.

   All three come from the source (B.6, B.7). An e2e fixture with a mock provider could capture the first two safely.

**Data shapes**

6. **`item.*.detail` is untyped JSON**, and its keys differ between Claude and Codex (A2 §2.2). The Kotlin model must treat every key as optional, and fall back to a generic row.
7. **Unknown values must not crash the client.** Enums grow: error codes, `ItemKind`, `ProviderEvent._tag`, notification kinds, `unenforced`, `heartbeat.target` and the topic list. Decode them as open strings with an "unknown" branch.

**Product decisions** (from C and D)

8. **What the phone alerts on.** C §5 lists four questions:
   - assistant messages;
   - permission requests;
   - how alerts are delivered in the background;
   - whether alerts are suppressed for the whole app while it is in the foreground, or only for the screen being viewed.

   The desktop alerts only on new open Requests and on urgent Signals.
9. **Which face is "Hercule".** It has three different faces in the desktop today (D §1.2). The ticket should pick one.
10. **Colours outside sRGB.** Some crew colours are oklch values outside the sRGB gamut. D marks the hex values that still need to be pinned from captures with `*`. Decide between Display P3 on Android (`ColorSpace.Named.DISPLAY_P3`) and clamped sRGB.
11. **Fonts.** The desktop ships woff2 files, which Android cannot load. The port needs TTF or OTF builds of the same families, under the licences D §3 lists.
