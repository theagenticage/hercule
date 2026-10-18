# Android app

The Android app is a native phone app, written in Kotlin with Jetpack Compose and drawn in the Crew Bureau design system. Like the web app and the desktop app, it is an ordinary client of the public API, with no privileged path ([ADR 0042](../adr/0042-the-phone-app-is-a-native-android-client-of-the-public-api.md)). It shares no code with the other clients: it reads the same HTTP API and `/ws` socket with its own Kotlin types.

This document covers:

- the scope of the first milestone and the one target phone
- the Gradle project, its stack and its names
- reaching the controller, signing in, and storing the API Key
- the live connection and the foreground service that holds it
- the screens and how each translates the book
- the alerts and the Live Updates
- the design system on Compose
- the performance baseline and how to measure it
- testing and distribution

What a thread does - its transcript, its Requests, its composer - is owned by [./14-web-app.md](./14-web-app.md). What an assistant's Conversation is is owned by [./12-assistants.md](./12-assistants.md). This document owns how the phone draws that behaviour, and what the phone adds: alerts on the lock screen and a Live Update for each thread that waits on the user.

**Status:** locked 2026-10-13 for [Android prototype: the assistant, threads, and lock screen notifications, native in Kotlin (#630)](https://github.com/theagenticage/hercule/issues/630), with [ADR 0042](../adr/0042-the-phone-app-is-a-native-android-client-of-the-public-api.md). The app in `apps/android` builds everything here; it came to `main` with [#645](https://github.com/theagenticage/hercule/issues/645).

## Scope of the first milestone

**The phone.** The app has one target device: Rogier's Samsung Galaxy S23 Ultra (SM-S918B) on Android 16 QPR2 (SDK 36.1, One UI 8.5). Nothing else needs to be supported, and no rule here is bent to support another phone.

**SDK levels:** `minSdk 36`, `targetSdk 36`, `compileSdk 37`.

- `compileSdk` is 37 because Compose 1.12 (in Compose BOM 2026.09.00) refuses to build against anything lower.
- `targetSdk` stays 36, because targeting 37 adds local-network rules whose effect on a controller reached over Tailscale is unverified.
- A Live Update needs `setRequestPromotedOngoing`, which exists only from SDK 36.1. An SDK 36.0 device or emulator cannot draw one.

**In:**

1. **Sign in:** the controller's address, the user name and the password.
2. **Office:** the home screen, with threads and assistants only.
3. **Threads:** every thread the desktop sidebar lists, by project, with the Done shelf.
4. **Thread:** the transcript, live while open; the docked Request; a composer.
5. **Assistant:** the main Conversation, live; the docked Request; a composer with hold-to-talk.
6. **You:** the account, the live connection with Sign out, the two phone settings that keep alerts arriving, and the licences.
7. **Alerts and Live Updates,** posted by a foreground service that holds one `/ws` socket while the user is signed in.

**Out:** Intake, Decision, New thread, Runs, Triggers, Settings (except sign out and the connection), tablets, and themes other than light and dark following the system. The tab bar keeps the book's shape: its Intake tab and new-thread button are drawn faint and do nothing ([The tab bar](#the-tab-bar)).

## Architecture

### The Gradle project

`apps/android` is a Gradle project with one `:app` module. It is not a pnpm package, and no `pnpm` command builds or checks it; it has its own check command ([Testing](#testing)). Gradle's outputs (`.gradle/`, `build/`) are ignored by git, oxfmt and eslint. `local.properties` and Kotlin's `.kotlin/` cache are ignored by git.

The application id and the Kotlin package are `dev.hercule.android`. That is the app's identity, as `hercule` is the binary's name. AGENTS.md's rule against the product name in identifiers applies to the app's classes, functions and fields, not to its package.

### Stack

Every version is pinned exactly in `apps/android/gradle/libs.versions.toml`, as AGENTS.md requires. Upgrading one is a deliberate, reviewed change, so lint's "newer version available" checks are off.

| Piece | Choice |
|---|---|
| Build | Gradle 9.8.1 through the wrapper, with its `distributionSha256Sum`; AGP 9.4.0; a version catalog |
| Language | Kotlin 2.4.21, JVM toolchain 21 |
| UI | Compose BOM 2026.09.00 (Compose 1.12). Material 3 only for primitives, at the version the BOM picks. The look is the book's, not Material's |
| App frame | androidx.activity 1.13.0, androidx.lifecycle 2.11.0 |
| Navigation | Navigation 3, 1.2.0 |
| Notifications | androidx.core 1.19.1: `NotificationCompat`, `NotificationManagerCompat`, `ShortcutManagerCompat` |
| Storage | DataStore (preferences) 1.2.1 |
| Concurrency | kotlinx.coroutines 1.11.0 |
| Network | OkHttp 5.5.0 for HTTP and the WebSocket; kotlinx.serialization 1.11.0 |
| Tests | JUnit 4.13.2, Robolectric 4.17 (SDK 36), Roborazzi 1.76.0, OkHttp's `mockwebserver3` |

The three SDK 36 notification calls (`setRequestPromotedOngoing`, `setShortCriticalText`, `ProgressStyle`) go through `NotificationCompat`, which checks the version itself. The app's code has no version branches, and lint's `NewApi` check stays quiet.

### Names

- **Alerts, not notifications.** CONTEXT.md's **Notification** is the controller's own message record, which the app never reads. The app's code calls the Android notifications it posts **alerts** (`AlertKey`, `AlertPoster`, `AlertActionReceiver`), so the two never share a name. Android's own classes keep their names.
- **No bare `Thread` type.** Kotlin has `java.lang.Thread`. The record is `Session`, and the screen is `ThreadScreen`.
- **`ControllerWatchService`** is the foreground service that holds the one `/ws` socket, decides which Requests and messages alert, and posts the alerts. It is not named for a connection, because CONTEXT.md's **Connection** is another thing.
- The other CONTEXT.md words apply to Kotlin identifiers as they do to TypeScript: Thread, Assistant, Request, Conversation, Session, Runner, Project.

### Package layout

Source sits under `app/src/main/kotlin/dev/hercule/android/`, one folder per concern:

| Folder | What lives there |
|---|---|
| (top level) | `MainActivity`, `MainApplication` |
| `wire/` | The Kotlin types the HTTP API and the socket decode to: sessions and their Requests, transcripts, assistants, Conversations, runners, projects, pages, errors |
| `controller/` | `ControllerApi` (HTTP), `LiveConnection` (the socket), `ControllerStore` (the lists every screen and the alerts read) |
| `credentials/` | `CredentialStore` and `KeystoreKey`: the stored sign-in and the encrypted API Key |
| `app/` | `AppGraph` (wiring), sign-in and sign-out, `BackgroundPermissions` |
| `service/` | `ControllerWatchService`, `BootReceiver` |
| `alerts/` | The alert rules, the pipeline that runs them, the poster, the Live Updates, and the receiver for alert buttons |
| `office/` | The Office's data: the lanes, Request questions, poses, capacity, ages. Most `client-core` ports live here |
| `threads/` | The Threads tab's data: the project groups and their order, the row status, the Done shelf, and why a thread cannot be resumed |
| `faces/` | The crew faces, drawn on Canvas |
| `theme/` | `Tokens.kt` (generated) and `Fonts.kt` |
| `ui/` | The screens and their view models, and the shared components |

Tests sit under `app/src/test/`, beside the same packages. Screenshot goldens are committed under `app/src/test/screenshots/`.

### Decoding the wire

Every enum on the wire decodes as an open string with an "unknown" branch, so a new value from a newer controller never fails a read. `item.*.detail` is untyped JSON whose keys differ per provider, so every key is optional, and an item of an unknown kind gets a generic row. The wire itself is described in [the wire research](../research/android/wire.md).

### Logic ported from `client-core`

The app shares no code with `client-core` ([ADR 0042](../adr/0042-the-phone-app-is-a-native-android-client-of-the-public-api.md)). It ports these functions to Kotlin. Every source path is under `packages/client-core/src/`.

| Function | Source | Kotlin port |
|---|---|---|
| `listWaiting`, `formatNotificationBody` | `waiting.ts` | `office/Waiting.kt` |
| `formatRequestQuestion` | `threads/request-question.ts` | `office/RequestQuestion.kt` |
| `decideThreadPose` | `threads/pose.ts` | `office/SessionPose.kt` |
| `decideAssistantPose` | `assistants/rows.ts` | `office/SessionPose.kt` |
| `describeCapacity` | `runner-capacity.ts` | `office/RunnerCapacity.kt` |
| `formatAge` | `threads/age.ts` | `office/Age.kt` |
| `buildThreadBlocks` | `threads/blocks.ts` | `ui/thread/ThreadBlocks.kt` |
| `summarizeWork` | `threads/work-summary.ts` | `ui/thread/ThreadBlocks.kt` |
| `formatDuration` | `threads/duration.ts` | `ui/thread/ThreadBlocks.kt` |
| The question draft | `threads/question-draft.ts` | `ui/thread/QuestionDraft.kt` |
| The tail buffer | `threads/tail-buffer.ts` | `controller/TailBuffer.kt` |
| `decideOpenReply`, `findOpenItem` | `assistants/conversation-blocks.ts`, `threads/open-item.ts` | `ui/assistant/OpenReply.kt` |
| `trimToRunningTurn` | `assistants/conversation-blocks.ts` | `controller/ControllerStore.kt` |
| `pickProjectHue` | `threads/tone.ts` | `ui/Components.kt` |
| `pickLastStartedAt` | `threads/project-rows.ts` | `threads/ProjectThreads.kt` |
| The project grouping and sorting of `buildThreadGroups`, `listProjectRows` and `sortProjectsByNewestThread`, without workspaces, caps or the draft | `threads/groups.ts`, `threads/project-rows.ts` | `threads/ProjectThreads.kt` (`groupThreadsByProject`) |
| `isMarkedDone` | `threads/status.ts` | `threads/ThreadStatus.kt` |
| `findResumeBlockedReason` | `threads/resume-blocked.ts` | `threads/ThreadStatus.kt` |
| `decideThreadRowStatus`, with `decideThreadRowEnd` folded in | `threads/pose.ts` | `threads/ThreadRowStatus.kt` |
| `buildDoneShelf`, without `selectedId` | `threads/sidebar-sections.ts` | `threads/DoneShelf.kt` |
| `parseMarkdown`, with `mergeAdjacentTexts`, on commonmark-java with marked's rules where the two differ; also checked against the trees client-core builds for `scripts/markdown-parity-corpus.json` (`MarkdownParityTest`) | `markdown.ts` | `markdown/Markdown.kt`, with `markdown/InlineSource.kt`, `markdown/InlineText.kt` and `markdown/FootnoteSyntax.kt` |
| `buildBlocksFromPieces`, `buildInlinesFromPieces` | `markdown-html.ts` | `markdown/MarkdownHtml.kt` |
| `decodeCharacterReferences`, `normalizeAddress`, `isSafeAddress`, `trimTrailingNewlines`, `extractPlainText`, `removeNestedLinks` | `markdown-text.ts` | `markdown/MarkdownText.kt` |
| The markdown tree | `markdown-tree.ts` | `markdown/MarkdownTree.kt` |
| `splitStreamingText` | `threads/streaming-text.ts` | `markdown/StreamingText.kt` |
| `describeSender`, which takes whether the phone can open the session as a thread ([Thread](#thread)) | `threads/sender.ts` | `threads/Sender.kt` |

Each port:

- names its source function and file in its docstring;
- has JVM tests with the same cases as the source's test, copied case by case, with the source test's path in a comment.

A change to one of these functions in `client-core` changes its Kotlin port and the copied tests in the same pull request. The crew faces are a port too ([Faces](#faces)).

**Where the markdown port differs.** `parseMarkdown` builds the tree client-core's builds, checked against client-core for every input of `scripts/markdown-parity-corpus.json` in each way the apps parse a message, except for the known differences listed in `MarkdownParityTest`, approved by Rogier on 2026-10-18 ([#747](https://github.com/theagenticage/hercule/issues/747)). Each would need the text read again by marked's own rules:

- **Lazy lines in a quote:** marked reads the lines that continue a quote's paragraph lazily as blocks of their own, so a lone HTML tag, a table or a backslash line there differs.
- **Lazy lines in a list item:** marked reads a list item's lines one at a time as blocks, so a lone HTML tag or a heading underline on a lazy line differs.
- **Lines after a blank-looking quote line:** marked keeps in the quote the lines after a quote line that holds only spaces or a tab, where they are code, a definition or a nested quote's line.
- **Emphasis:** marked pairs `*` and `_` by its own rules, which differ from CommonMark's in corner cases, such as a `*` right after an underscore.
- **A tab after a quote's `>`:** marked takes the whole tab away, where commonmark-java counts it to the next tab stop, so the line's indentation, and whether it is code, differs.
- **A closing `</pre>` line followed by HTML:** marked reads it as a paragraph, which the port follows, unless a later line starts with `<`.
- **Link definitions:** marked reads no definition with a tab after its colon, ends a definition at its line where an indented line follows, and takes a lone `(` as a link's address.

**Nesting.** A message whose finished tree nests deeper than 100 levels, blocks and inlines counted together, is shown as its raw text: `MAX_MARKDOWN_NESTING`, the same rule as client-core's ([./14-web-app.md](./14-web-app.md) §The thread's prose renders as markdown). Levels the tree does not keep, such as emphasis in an image's alt text, do not count. Apart from it, commonmark-java's own nesting is held to 300 levels while it parses, a guard on time and stack, which a parse fits in a 1 MB stack.

## Reaching the controller

The user types the controller's address on the sign-in screen. The app keeps only the address's origin. An address without a scheme gets `http://`.

The controller serves plain HTTP on a LAN or tailnet ([./13-security.md](./13-security.md#1-perimeter-and-threat-model)). The app's network security config allows cleartext traffic for every host (`base-config cleartextTrafficPermitted="true"`). The app only ever talks to the one controller its user typed in.

- **The phone** reaches the controller over Tailscale. The controller listens on the Mac's tailnet address (`-c bind.host=<tailscale ip -4>`), and the user signs in at `http://<that address>:<port>`.
- **The emulator** reaches a controller on the Mac at `http://10.0.2.2:<port>`.

A native app sends no `Origin` header, so the controller's CORS allow-list ([./17-desktop-app.md](./17-desktop-app.md#reaching-the-controller)) does not apply to it. The app needs no controller change.

## Sign-in and the API Key

Signing in follows the `hercule login` pattern ([./13-security.md](./13-security.md#43-api-keys)):

1. `auth.login` with the user name and the password returns a login token.
2. `apiKey.create { name: "Android - <model>" }` under that token mints the phone's own API Key. `<model>` is `Build.MODEL`, such as `SM-S918B`, so the key is recognisable in the web app's settings.
3. The login token is dropped. It is never written to disk.

The sign-in result is one of: signed in; a bad address; the controller could not be reached; the controller refused, with its message; or the key could not be stored. The form shows a sentence for each. When the key cannot be stored, the app revokes the key it just minted, so no unused key is left behind.

A sign-in runs to its end even when its screen closes, because a key minted and then abandoned would stay valid with nobody holding it. A sign-in screen opened while it runs shows it instead of starting a second one. A failure is kept until the user edits the form it is about, because it can name an API Key the user must revoke: while one is kept, the app opens on sign-in, which shows it, rather than the Office. A success is not kept. The phone is signed in, and the background permissions are asked for the next time the app is in front past sign-in ([The live connection](#the-live-connection)).

**Storing the key.**

- The key is encrypted with AES-256-GCM under an Android Keystore key (alias `api_key_encryption`), through `javax.crypto`. The ciphertext, with its 12-byte IV in front, is stored in DataStore beside the controller's address, the user name and the key's id. `EncryptedSharedPreferences` is deprecated and not used.
- The Keystore key requires neither user authentication nor an unlocked device. An alert button answers a Request while the phone is locked, and that call needs the key.
- One lock serializes sign-in, sign-out and restoring the stored sign-in at start, so none of them can interleave.

**When stored credentials are cleared.** The stored key and its id are cleared only when the key can never be read back:

- the Keystore key is gone for good (`KeyPermanentlyInvalidatedException`);
- the ciphertext is damaged (`AEADBadTagException`);
- the stored value cannot be decoded: it is not valid base64, or it is shorter than its 12-byte IV.

The user is then signed out, and the app posts an app alert ([App alerts](#app-alerts)) saying the key could not be read. Any other failure, such as a Keystore that fails for a moment (`GeneralSecurityException`, `ProviderException`, `IOException`), may pass: the credentials are kept, and the app posts an app alert saying it could not read the sign-in just now. A credentials file that DataStore cannot parse is replaced with an empty one, so the app starts signed out.

**A revoked key.** The controller does not close the socket when a credential is revoked. The app learns of it when `auth.wsTicket` refuses the key with HTTP 401 at the next connection. It then clears the sign-in, returns to the sign-in screen and posts an app alert saying the controller no longer accepts this phone's API Key. A subscription that ends `unauthenticated` drops the socket, so the next ticket request decides.

**Signing out**, in this order:

1. Stop the live connection and the service.
2. Remove every alert, every Live Update and every shortcut.
3. Clear the alert memory ([When to alert](#when-to-alert)).
4. Remove the stored key and its id. The address and the user name stay, so signing in again takes only the password.
5. Call `apiKey.revoke` (`DELETE /api/v1/api-keys/:id`) with the old key. A key may revoke itself. An `unauthenticated` reply counts as done, because the key no longer works. Any other failure shows a toast that says the key still works and that the user can revoke it in the web app's settings.

Local credentials are cleared before the revoke, so a sign-out never depends on reaching the controller. A sign-out while connected revokes the key the connection holds. Otherwise, when the stored key cannot be read, nothing is revoked, and the toast says the key still works because this phone could not read it. When the stored key cannot be removed, the key is still revoked, the phone stays signed in, and an app alert says so. When the revoke worked, the next start finds the key refused and clears it again. `auth.logout` is not used: it refuses an API Key ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#secret-credential)).

## The live connection

### The socket

The app holds one `/ws` socket, in the shape the web app uses ([./14-web-app.md](./14-web-app.md#live-model-one-websocket-subscriptions-only)):

- It gets a ticket from `auth.wsTicket` (`POST /api/v1/auth/ws-ticket`) with its API Key, then sends `hello { v: 1, ticket }`. A ticket is single use and lasts 5 minutes, so every connection gets a new one.
- It speaks Effect RPC JSON. Every request carries `"headers": []`; without it the controller closes the socket with code 1011.
- It acknowledges every chunk.
- Every subscription is made again on each new connection. A log topic resumes from the last cursor it received. A mutable topic's first message names no ids, which means every record may have changed, so the app reads its list again.

It subscribes to:

| Topic | What the app reads again |
|---|---|
| `session` | The threads, when the push names a session in no Conversation, or names nothing. An assistant's current session, when the push names a session of that assistant's main Conversation. A push that names a session without its Conversation reads both again, for every assistant |
| `assistant` | The assistants |
| `runner` | The runners |
| `conversation` | The open Conversation's messages, and each assistant's recent messages for its alert |
| `session:<id>:stream` | A session's transcript, from its cursor: the open thread's; the Followed Thread's, also in the background, for its Live Update; the running turn of every other thread waiting on the user, for its Live Update; and the open assistant's running turn |
| `session:<id>:tap` | The token deltas of the same sessions |

Projects have no topic, so they are read each time the connection comes up. Pushes that arrive while a read is running are merged into one read after it.

### Keepalive and reconnect

- **Keepalive:** the `ping` RPC every 30 seconds, as `client-core` sends it, and nothing more often, because each message wakes the radio. The wire research suggests a shorter interval; the phone does not use it. No reply within 10 seconds means the socket is dead, and the app reconnects. `hello` has the same 10-second limit.
- **Reconnect:** the first wait is 1 second, doubling up to 30 seconds. Each wait is shortened by up to 20% at random, so many clients do not reconnect in step. The wait starts over at 1 second once a connection has stayed up for 30 seconds.
- **A `Defect` frame reconnects.** A `Defect` means the controller could not parse a frame the app sent, so a reply the app waits for may never arrive. The controller keeps the socket open after a `Defect` ([wire research §B](../research/android/wire.md#b-live-websocket-ws)); the app closes it anyway and reconnects.
- **A failed subscription:**
  - one to a log topic that does not exist, such as the stream of a deleted session, ends without a retry;
  - one whose cursor the controller rejects (`Validation`) starts again from the head of the log;
  - any other failure is retried after a wait that grows, with the same random shortening.

### ControllerWatchService

`ControllerWatchService` is a foreground service of type `specialUse`. While the user is signed in, it:

- holds the one `/ws` socket;
- runs the alert pipeline, which decides which Requests and messages alert;
- posts the alerts and the Live Updates.

**Why `specialUse`.** `dataSync` is limited to 6 hours in every 24, and `connectedDevice` requires a paired device. Its `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` reads:

> Keeps one connection open to the user's own self-hosted agent controller, so that alerts about agents waiting on the user arrive in time. The controller is not reached through Firebase Cloud Messaging, so no push service can deliver them instead.

Play Store review would question `specialUse`. The app is not distributed through the Play Store ([Distribution](#distribution)).

**Its ongoing notification** sits on the "Connection" channel, with notification id 11. Its title says where the connection stands: "Connecting to <host>…", "Connected to <host>" or "Reconnecting…". Android requires it for as long as the service runs.

**Starting.** The service starts at sign-in, after boot (`BOOT_COMPLETED`) and after an app update (`MY_PACKAGE_REPLACED`), through `BootReceiver`. Each start calls `startForeground` first. When Android refuses the start (`ForegroundServiceStartNotAllowedException`), the service stops and posts an app alert saying Hercule could not connect in the background and the user should open the app. When the user grants the notification permission after the service started, the service posts its notification again, because Android dropped the first one.

**Keeping it alive.** The service survives the app being swiped away. One UI puts apps to sleep that have not been opened for a while, so the phone needs two settings:

- After sign-in, once the app is in front past the sign-in screen, it asks once for `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. It remembers that it asked, in DataStore, and does not ask again.
- The You screen tells the user to add Hercule to Settings → Battery → Background usage limits → **Never auto sleeping apps**. The app cannot set this itself.

The app asks for `POST_NOTIFICATIONS` after sign-in, just before the battery question, whichever screen is in front.

**Open:** the background-permission ask is not repeated if Android kills the process while the ask is on screen. Whether to ask again at the next start, and how to tell that case from a refusal, is handed to [#651](https://github.com/theagenticage/hercule/issues/651). *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

### The manifest

| Entry | What it is for |
|---|---|
| `INTERNET` | The controller |
| `POST_NOTIFICATIONS` | Alerts |
| `POST_PROMOTED_NOTIFICATIONS` | The Live Updates |
| `VIBRATE` | The haptics of alert buttons, in the receiver |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE` | `ControllerWatchService` |
| `RECEIVE_BOOT_COMPLETED` | Restarting the service after boot |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | The one battery ask. Lint's `BatteryLife` check is silenced for it, because the ask is the point |
| `RECORD_AUDIO` | Hold-to-talk |

Components:

- `MainApplication`: the application class.
- `MainActivity`: `singleTop`, the launcher activity.
- `ControllerWatchService`: not exported, `foregroundServiceType="specialUse"`.
- `AlertActionReceiver`: not exported. It receives every alert button.
- `BootReceiver`: exported, for `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`.
- The network security config ([Reaching the controller](#reaching-the-controller)) and the data extraction rules.

## Screens

Every screen is drawn from the book's phone pages in `docs/design/crew-bureau-2/mobile/`. Navigation is Navigation 3. The bar at the top and the tab bar are the book's; the status bar and the gesture bar are the system's, and the screens lay out inside their insets.

### Sign in

The book has no sign-in page. The layout is the desktop's centred screen, in one 320 dp column: the mark, 40 dp, 12 dp from the wordmark "Hercule" in Limelight at 32 sp, then, 24 dp below, the address, the user name and the password. The column's top sits at 34% of the window's height, so it does not move when an error line appears. While the keyboard is open, the form scrolls until the Sign in button sits 24 dp above it.

The form starts with the address and user name of the last sign-in, so signing in again takes only the password. Editing a field while an error shows hides the error.

### Office

The Office (`mobile/office.html`) is the home screen. It shows threads and assistants only.

- **Receipt line:** one count per lane shown, such as "3 waiting on you · 8 working · 4 idle". The waiting count is bold, in the waiting colour.
- **Plan:** one wing per runner that is not retired, in the order `runner.query` returns them, which is by name. Two wings to a row, then the Lobby, which is drawn only when an assistant is asleep and holds the asleep assistants. A wing shows up to four faces of the threads and assistants whose session runs there, with "+N" for the rest, then the runner's name and, on its own line under the name, its capacity line from `describeCapacity`, such as "8 running of 8". Faces follow lane order. An asleep assistant has no row in the lanes, so the Lobby opens it: with one asleep assistant a tap anywhere on the Lobby opens it, with several each of the first four faces opens its own, and "+N" opens a menu of the others, by name, in which each row opens its own. Opening an assistant does not wake it; it stays in the Lobby until a message wakes it.
- **Lanes:** Waiting on you, Working, Idle. A thread goes in the lane of its pose (`decideThreadPose`); an asleep or away thread is not shown here, only on the Threads tab. An assistant goes in Waiting on you or Working by its pose (`decideAssistantPose`), in the Lobby when asleep, and in Idle otherwise. Run sessions (`runId` set) are left out, as the desktop leaves them out of Waiting on you. An assistant's own sessions (`agentId` set) are not thread rows; an assistant's current session is drawn as that assistant's row. There is no "waiting on you" endpoint; the app derives the lane from sessions and their open Requests.
- **Order:** Waiting on you is oldest first. Working and Idle are most recently active first. An assistant with no session goes last in its lane.
- **Rows:** the face, the title, the age, and a second line. The second line is `<project> · <pose words>` for a thread, `Assistant · <pose words>` for an assistant, and the question alone for a waiting row (`formatRequestQuestion`), in the waiting colour. The project name comes from `project.query`. The age is the time since `lastActivityAt`. A lane's head shows its count, and Waiting on you also shows "oldest <age>".
- **The ask card.** The first row of Waiting on you is drawn as the book's ask card when its Request is an approval, so it can be answered from the Office: **Allow** and **Deny**, each shown only when the Request accepts it. Once answered, the buttons stop taking taps; a failed answer makes them answerable again.
- Tapping a row opens its Thread or its Assistant.

**Not shown, and why:**

- Runs, because the desktop keeps run sessions out of Waiting on you and out of notifications.
- The Paused lane. In the book it holds a Trigger paused by its Spawn Bound, which is not a thread.
- The book's step descriptions ("running `pnpm test cart`", "step 2 of 4"). A session record has no such field, and reading every transcript to get one costs a read per row.

### Threads

The Threads tab (`mobile/threads.html`) lists every thread the desktop sidebar lists ([./17-desktop-app.md](./17-desktop-app.md) §The sidebar), in one scrolling list under the title "Threads", with no receipt line. No section is capped: the desktop's caps are for a sidebar of fixed height, and the phone's list scrolls. It reads the same lists as the Office, with no read or topic of its own; its ages are redone by the same minute tick as the Office's, which stops five seconds after the screen is left, and is drawn as one `LazyColumn`, so only the rows on screen are composed. *(Added 2026-10-14, [#659](https://github.com/theagenticage/hercule/issues/659).)*

- **Which threads:** every session with no `runId` and no `agentId`, as on the Office. Assistants are not listed; they live in the Office.
- **Rows:** the Office's rows: the face, the title, the status slot, and a second line.
- **Waiting on you,** with a marigold count pill: every thread with an open Request, newest activity first, as `listWaiting` sorts them. The second line is the oldest Request's question, in the waiting colour. The status slot shows the age since the last activity. A waiting thread is listed here and in its project, as on the desktop. A waiting thread marked Done stays here, and is on the Done shelf, not in a project. The section is not drawn when no thread waits.
- **One section per project,** for the threads not marked Done:
  - The header is the project's rug swatch and name, in muted bold. At its right, in the waiting colour, "N need you" or "1 needs you" while any of its threads waits, and nothing otherwise. It has no `+`, because the app does not start threads.
  - Threads are sorted newest started first by `pickLastStartedAt` (created, or last reopened), then by session id. Projects are sorted by their newest thread, then by project id.
  - "No project" comes last, with its swatch drawn as an outline only. A thread whose project is not in the project list goes there too.
  - The second line is the question, in the waiting colour, for a waiting thread, and the pose words otherwise: "working", "idle", "asleep" or "can't be reached".
  - The status slot follows `decideThreadRowStatus`: the waiting mark (16 dp, marigold) for an approval or a question; the working mark (three dots, muted) while starting or busy; the word "queued" or "offline" (faint); otherwise the age since the last activity.
- **The Done shelf,** at the bottom: a header button "Done" with a count pill and a chevron, closed by default.
  - Whether it is open is kept in memory only. It closes when the user switches tabs or the app's process ends, and stays open while a thread opened from the list is on top.
  - Open, it lists the 10 threads most recently marked Done, newest first by `done.at`, then by session id. While some are hidden, a "Show 25 more" row follows, which shows 25 more per press.
  - A Done row is drawn at 60% opacity. Its second line is the project's swatch and name, or "No project", and its status slot is the time since it was marked Done ([./17-desktop-app.md](./17-desktop-app.md) §The Done shelf).
  - The phone has no Reopen action. Sending a message to a Done thread reopens it.
- **Empty:** with no threads at all, the asleep Hercule face at 56 dp, "No threads yet", and "A thread you start on your Mac or from Intake shows here, under its project."

Tapping a row opens its Thread on top of the list. Opening a thread from the list makes it the Followed Thread, as opening it from the Office does, and the thread on screen raises no alert ([The Live Update](#the-live-update)).

### Thread

The Thread screen (`mobile/session-active.html`):

- **The bar:** the back button with the count of threads waiting on the user, the same count as the Threads badge, the thread's face at 30 dp, the title, and "<project> · <pose words>". The back button names the screen below: "Back to Threads" from the Threads tab, and "Back to the Office" from the Office or an alert.
- **The transcript,** live while the screen is open: `session:<id>:stream` from its cursor, plus the `:tap` token deltas for the words still streaming. An agent's message is signed with the thread's face and title, and the time. Messages are drawn as markdown, and the agent's message still being written streams paragraph by paragraph ([Messages as markdown](#messages-as-markdown)). Until its first word arrives, that message is a "Writing…" line in the divider's drawing, with no byline, as on the desktop. A work stretch is a divider, "Worked for 2m 14s ›", with its summary; a tap opens it to one row per item.
- **A message another session's agent sent names that agent,** as on the desktop ([./17-desktop-app.md](./17-desktop-app.md), "A message another session's agent sent names that agent"). *(Added 2026-10-18, [#773](https://github.com/theagenticage/hercule/issues/773).)* Its `user_message` detail names a `senderSessionId`. The message is the user's bubble on the right, with three differences:
  - A chip above the bubble, on the right, names the agent: its 18 dp idle face and its name, bold, in the agent's `whoInk`. The chip is at most 240 dp wide, and a longer name ends in an ellipsis. The chip's width never widens the bubble.
  - The bubble is tinted with the agent's `whoTint`; in dark, the tint is mixed 70% into the neutral bubble.
  - A screen reader reads the message as "Message from" and the agent's name.

  The name, the face and the link follow `describeSender`, so the phone names a sender as the desktop does. A sender the phone lists as a thread links to its thread, and an assistant's session to the assistant's page. Any other readable session, such as a workflow step's session or an Agent's, is named by its title with its face and links nowhere, because the phone has no screen for a session it does not list. A session that cannot be read, deleted, forbidden or failed, is "Another agent" with no link, and is never an error. Tapping a linked chip opens the sender's thread or assistant, or goes back to it when it is already on the back stack.

  The sender's session comes from the store's lists when they hold it, so a title generated later shows at once. Any other sender is read once with `session.read`, while the store lives, which is while the phone is signed in; a read that fails is not made again, and no push reads it again. Unlike the desktop, the thread does not wait for these reads before it is drawn. Until a sender is known, its bubble is untinted and the chip's row is held empty at its height, so nothing moves when the name arrives and nothing names a sender that may be wrong.
- **The docked Request:** the oldest open Request, docked above the composer ([The docked Request](#the-docked-request)).
- **The composer** sends `session.input`. Its button is a send arrow. The thread composer has no voice input.
- **An exited thread that can be resumed** behaves as an idle one: the composer is enabled, and sending a message resumes the thread in place ([./14-web-app.md](./14-web-app.md) §The composer). There is no Continue control. Its face still shows asleep, as on the desktop ([./17-desktop-app.md](./17-desktop-app.md), the pose table).
- **An exited thread that cannot be resumed** (`findResumeBlockedReason`) shows a disabled composer whose placeholder reads "This thread can't be resumed: <reason>.". The reason is "its transcript is gone" when the session has no native session id, or "its runner was retired". *(Added 2026-10-14, [#659](https://github.com/theagenticage/hercule/issues/659).)*

The transcript's blocks are built off the main thread. A streamed token builds again only the block of the message it extends, and every other block keeps its instance, so Compose skips its row; a new row builds them all again, and a block equal to the one before still keeps its instance (`ThreadBlockBuilder`). *(Resolved 2026-10-18, [#650](https://github.com/theagenticage/hercule/issues/650), in [#747](https://github.com/theagenticage/hercule/issues/747): the screen rebuilt every block on each token.)*

### Assistant

The Assistant screen (`mobile/assistant.html`):

- **The bar:** the back button, the assistant's face from `buildAssistantLook(assistant.id)`, its name and its state: "answering…" while it writes, or else its pose words from `decideAssistantPose`, such as "idle", "asleep", "waiting on you" or "can't be reached". An assistant is asleep when its newest session exited and can be resumed, as after an idle unload, and idle when it has no session or its session is idle. The Memory button is drawn disabled; memory is not part of the app.
- **The messages** of the main Conversation (`conversation.queryMessages`), in position order, live by invalidate. The owner's messages are bubbles; the assistant's are signed with its face; a Notice is drawn with the failed face, its text and its time. A message's text is drawn as markdown, as spec 14 and the desktop draw it ([Messages as markdown](#messages-as-markdown)); a Notice's is plain text.
- **The live answer.** While the assistant writes, the app shows the text of its reply that no stored message holds yet, from the running turn's transcript, as the desktop does. `decideOpenReply` decides which text that is, so no text is drawn twice. While the text being written streams, its finished paragraphs are markdown and the paragraph being written is plain text ending in a blinking caret ([Messages as markdown](#messages-as-markdown)); once every text of the reply has ended, the whole reply is markdown and the caret is gone.
- **The docked Request.** An open Request of the assistant's current session is docked above the composer, as on the Thread screen. An assistant's Request that an alert cannot answer (several questions, `multiSelect`, `secret`) opens this screen, so it needs the dock.
- **The composer** sends `conversation.send`. While it is empty, it shows the hold-to-talk mic ([Hold-to-talk](#hold-to-talk)).
- A reminder card's Edit button is drawn disabled. The wire has no reminders yet, so only a fixture fills one.

### Messages as markdown

A message's text is drawn as markdown, from the tree `parseMarkdown` builds ([./14-web-app.md](./14-web-app.md) §The thread's prose renders as markdown), in the look of the desktop's `markdown.tsx` and `markdown.css` ([./17-desktop-app.md](./17-desktop-app.md)). The parser is a Kotlin port; its tree is `markdown/MarkdownTree.kt`, and `ui/markdown/` draws it in Compose.

- **Who wrote it decides the rules,** as on the desktop. An agent's own message keeps CommonMark's newlines and reads embedded HTML. The user's bubble turns each newline into a break and shows every tag as typed. A message another session's agent sent into the thread (its `user_message` detail names a `senderSessionId`) is a bubble with breaks that reads its HTML.
- **Everything the tree holds is drawn:** paragraphs; headings, all at body size in bold; strong, emphasis and strikethrough; inline code on its chip; code blocks on the sunken card, scrolling sideways; bulleted, numbered, nested, tight and loose lists, and task items with a read-only box; quotes; rules; hard breaks; tables, with each column's alignment, `colspan`, an optional header row and a hairline under each row, each scrolling sideways on its own; details blocks, shut until tapped; footnotes, in a muted section under the message, with raised numbered references and a back link.
- **Sizes** are the desktop's, carried to the phone's body text the way the book's phone pages carry it (15 sp at line height 1.5): the desktop's 14 px text is 15 sp, its 13 px text (tables, footnotes) 14 sp, inline code stays 12.5 sp, a CSS px of spacing is a dp, and the code block takes the book's phone values. Strong text and a table's header cells are the browser's bold, 700, and headings the book's `--w-bold`, as on the desktop. Margins collapse as CSS margins do, also under a message's last block, where the desktop keeps the margin of what ends a quote or a list. The mapping is written out in `ui/markdown/MarkdownLook.kt`.
- **Links** are underlined. A tap on an http or https address opens it in the app that views it; any other link, a relative one, and a `#` link that is not a footnote's are drawn as links and do nothing, as on the desktop. A phone with no app for the address says so in a toast. A long press on a link opens nothing. An image is never loaded: it is a link to its address, named by its alt text.
- **Links for a screen reader and the keyboard.** Each link is a node of its own that TalkBack and the keyboard focus, read by its text and then its title when it has one; Enter follows it. The text a screen reader reads marks its links, for TalkBack's link navigation.
- **Footnote links** bring their target into view inside the transcript, between the bar and the composer: a reference its footnote, a back link the first reference, opening any details block around it first, and scrolling a wide table sideways to it.
- **A details block** the user opened stays open while its message streams and when its row scrolls away and back. Its state is kept by its place in the document, as the desktop's browser keeps it, so it is positional there too: text added at the end can still move it, as a reference definition added at the end can change how an earlier block is read. When the message's text is replaced rather than extended, while it streams, as it ends or after, the details blocks the user opened shut.
- **Selection.** A message's text can be selected and copied, from one block to another. A copy holds only what the message says: the padding of inline code and the caret are drawn, not set in the text, and a list's markers are left out.

**Streaming.** On the Thread and the Assistant, an agent's message still being written is drawn as the desktop draws it ([./17-desktop-app.md](./17-desktop-app.md), "A paragraph is drawn as markdown once the agent has finished it"):

- The message's text so far is split after its last blank line outside a code block (`splitStreamingText`). The finished paragraphs before it are markdown; the paragraph being written is plain text, and on the Assistant it ends in the caret.
- The finished part is parsed again only when a paragraph finishes, so a token that finishes none costs no parse.
- Both parts come from the same text in one composition, so no text is drawn twice or missing for a frame.
- Once the message ends, its whole text is parsed and drawn as markdown.
- Parsing runs off the main thread, in the screen's view model (`MessageDocuments`), so a row arrives at composition already parsed. Each message is parsed once per text, kept in a cache bounded by the text it holds; the newest messages are parsed before the screen's state is published, and the rest in the background, newest first. While a newer text of a message is parsed, its row keeps the document of the older text, with the rest as plain text, so every frame draws one revision of the text. The decision came from measurements on the phone ([Performance](#performance)). *(Changed 2026-10-18, [#747](https://github.com/theagenticage/hercule/issues/747): parsing ran in composition.)*

### You

The You screen keeps the look of the book's `mobile/settings.html`, but holds only what the phone needs. The book's version lists the controller's settings, which the app does not edit.

- **Controller:** the user name and the controller's host; Connection, with a dot and its state: "Connected" (green dot), "Connecting…", "Reconnecting…" and "Sign in again" (red dot and red text), or "Not connected"; Sign out, in the failure colour.
- **On this phone:**
  - "Show Live Updates", on a Samsung phone only (`Build.MANUFACTURER` is "samsung", ignoring case): One UI shows a waiting colleague in the status bar only after the user turns on Settings → Developer options → "Live notifications for all apps" ([One UI](#one-ui)).
  - "Keep alerts arriving": add Hercule to "Never auto sleeping apps" in the battery settings.
- **About:** the licences: each bundled font's name and its full OFL text, and those of commonmark-java (BSD-2) and marked (MIT), which open in place.

### The tab bar

The book's tab bar: Threads, Intake, the new-thread button, Office and You. Threads, Office and You have screens, and switching tabs replaces the whole back stack with that tab's screen. Intake and the new-thread button are drawn faint and do nothing, so the bar keeps the book's shape without offering what the app cannot do. The app still opens on the Office.

Threads carries a badge, on every tab's screen, with the number of threads waiting on the user, hidden at zero. It counts threads only, not assistants: an assistant's question shows at a glance in the Office's Waiting on you lane and its receipt. Intake has no badge, because the app reads no Intake data. *(Amended 2026-10-14, [#659](https://github.com/theagenticage/hercule/issues/659): Threads was drawn faint and had no screen, and its badge was the Office's Waiting on you count, assistants included.)*

### Following new messages

The Thread and Assistant lists open on their newest message. A new message scrolls into view while the user is at the newest one, and always when it is the user's own, so a sent message is always shown. A user who has scrolled up to read is not moved. A reverse-layout `LazyColumn` keeps its first visible item in place when an item is added before it, which is why the list follows on purpose; `AssistantScrollTest` covers it.

### The docked Request

The docked Request answers every Request shape, on the Thread and the Assistant screens:

- **An approval** offers one row per decision it accepts, in its order: **Allow**, **Allow always**, **Deny**, **Cancel**. Allow is the accent row. Each row's fine print says what it does, in the words of the contract's `describeApprovalAnswer`, naming what is approved by its kind (the command, the change, the read or the tool call), such as "Runs the command this once; the agent asks again next time." A tap gives a confirming haptic for an allow and a rejecting one for a deny or a cancel (`HapticFeedbackType.Confirm`, `Reject`), then calls `session.respondToApprovalRequest`.
- **A question** shows each question with its options, `multiSelect` where asked, and a field for the user's own answer, masked when the question is `secret`. Send answers is enabled once every question has an answer, and calls `session.respondToQuestion`.
- **Its title** names the command, the file or the tool as code: "Run `git push`?", "Change `src/a.ts`?". A question reads "The agent needs answers."
- **A Request of a kind the app does not know** is titled "Answer this request?", with no answers and the line: This build of the app can't answer a Request of kind "<kind>". Answer it on the desktop or in the web app.
- Once answered, the dock stops taking taps. A failed answer makes it answerable again, and the question's draft is still there.
- The dock takes at most 60% of the height below the bar and scrolls beyond it, so a tall Request never pushes the composer off screen. The composer covers the dock's last 14 dp, as the book's `margin-bottom: -14px` does.

**The first approval decision is labelled "Allow"** everywhere on the phone: alert buttons, Live Update buttons, the docked Request and the Office's ask card. That is the contract's shared label, which the desktop shows. The book's "Allow once" is not used.

### Hold-to-talk

The Assistant composer's mic turns speech into a message.

- It uses only the device's on-device recognizer (`SpeechRecognizer.createOnDeviceSpeechRecognizer`). The user's voice is never sent to a recognition service off the device. When the device has no on-device recognition, no mic shows.
- Pressing the mic listens; letting go stops, and the recognised words are sent with `conversation.send`. The mic turns marigold while it listens.
- The first press asks for `RECORD_AUDIO` and does not listen. Once it is granted, a press listens.
- A failed recognition shows one of three sentences: "Nothing was heard. Hold the mic while you speak.", "Hercule may not use the microphone. Allow it in the app's settings." or "Your words could not be recognised. Try again."
- TalkBack cannot hold a button. With TalkBack on, a double tap starts listening and a second double tap stops. The mic's click action is labelled "Start listening" or "Stop listening" to match.

## Alerts

An **Alert** is an Android notification the app posts about one Assistant, or about the app itself ([App alerts](#app-alerts)). A Thread has no alert: its [Live Update](#the-live-update) is its one notification, and alerts for it. The app decides its alerts and Live Updates itself, from the live lists, as the desktop decides its native notifications ([./17-desktop-app.md](./17-desktop-app.md#native-behaviour)). It never reads or routes the controller's Notifications ([ADR 0042](../adr/0042-the-phone-app-is-a-native-android-client-of-the-public-api.md)).

### What alerts

- A new open Request (approval or question) on a thread, through the thread's Live Update.
- A new open Request on an assistant's current session.
- A new message from an assistant in its main Conversation.

Nothing else alerts. Permission Requests, Signals and run sessions do not. Requests are the desktop's rule; assistant messages are the phone's own addition, because on the phone a message from an assistant is something the user reads away from the desk.

### One notification per destination

- A destination's key is `thread:<sessionId>` or `assistant:<assistantId>`. It is the tag its notification is posted with: a thread's Live Update, or an assistant's alert. An assistant's key is also the id of its long-lived shortcut. A destination has at most one notification.
- **A thread** shows its Live Update while it waits on the user, and the Followed Thread also while it works ([The Live Update](#the-live-update)). It has no alert of its own.
- **An assistant's** messages and Requests share its one key, so each assistant is one conversation in the drawer. Its alert holds the assistant's last 6 messages, the owner's and the assistant's, and an open Request as the newest message. While a Request is open, the buttons are the Request's. When it closes, the alert is shown again silently, with Reply.
- When another Request of an assistant opens or closes without alerting, its alert is shown again silently, so "+N more waiting" stays true. Showing an alert again never brings back an alert the user swiped away.
- A destination that leaves the lists loses its notification.
- Nothing alerts while its destination is on screen. Other destinations still alert while the app is open. An assistant's alert is removed while its Conversation is on screen.

### When to alert

- **The alert memory is persisted** in DataStore: the open Request ids, the assistant alerts shown, the position of each assistant's last message, and the Followed Thread. Android killing the process causes neither an alert storm nor an alert posted twice.
- **Only the first list with no stored memory records without alerting.** Signing in clears the memory, so the first list after it records what is open and alerts for nothing. A damaged stored memory counts as none. After an app start or a reconnect, the app compares against the memory it persisted. A Request that opened while the process was dead or the socket was down still alerts once, and nothing alerts twice. This differs from the desktop, which shows nothing at launch: the phone's process dies and its socket drops often, and a Request that opens during a gap must still reach the user.
- Assistant messages are compared by position, not id.
- **Decisions are sampled every 250 ms,** not debounced, so a streaming thread never holds back another destination's alert. A snapshot is skipped while any list is half-read, or while the transcript of a thread that shows a Live Update is still being read.
- An alert or a Live Update changes when its Request is answered anywhere: on the phone, the desktop, the web app or the CLI ([ADR 0027](../adr/0027-a-decision-resolves-when-its-question-is-answered-wherever.md)). It changes at the next list. An alert is removed. A Live Update shows the thread's next open Request while one is left, shows the work while the thread is the Followed Thread and works, and is removed otherwise.

### Answering from an alert

The buttons of an alert and of a Live Update are decided per Request:

- **An approval** shows **Allow** (`allow`) and **Deny** (`deny`), each only when the Request accepts it. When it accepts neither, the notification shows **Open**. Its other decisions (`allow_always`, `cancel`) are offered in the app only.
- **A question** shows its options as buttons when the Request holds exactly one question, without `multiSelect` or `secret`, and with one to three options. A tap answers `{ <header>: [<label>] }`. Any other question, and any Request of an unknown kind, shows **Open**, which opens the Thread or the Assistant, where the docked Request answers every shape.
- **An assistant's alert with no open Request** shows **Reply**, a `RemoteInput` that sends `conversation.send`. Android asks for an unlock before a reply. One UI adds its smart replies, which stay on.

Every button is a broadcast to `AlertActionReceiver`, never an activity, so Allow, Deny and option buttons work while the phone is locked. The receiver:

- calls `goAsync()` so the call can finish, with a 9-second limit;
- calls the controller over plain HTTP with the stored credentials, so it works in a process Android started only for the tap, without the service;
- gives a haptic at the tap, before the call: `EFFECT_CLICK` for Allow and options, `EFFECT_DOUBLE_CLICK` for Deny, none for Reply;
- on success, removes a replied assistant alert. An assistant's Request alert and a Live Update stay until the next list posts them again with what is open then;
- on `invalid_state`, which means the Request was answered elsewhere, removes an assistant's alert. A Live Update stays until the next list posts it again;
- on any other failure, replaces the alert with a plain alert that says what failed and why: "<button> failed: <reason>". On a Live Update, only the text changes, so it stays the thread's one notification. A blank reply fails with "the reply was empty", a tap after sign-out with "you are signed out of the controller", and a call past the time limit with "the controller did not answer in time".

The receiver does nothing to a notification that shows another Request by the time the call returns: the outcome is about the tapped Request, not the newer one.

### Channels and grouping

| Channel | Importance | What it carries |
|---|---|---|
| Waiting on you | High | The Live Update of a thread waiting on the user, assistant alerts with an open Request, app alerts |
| Messages | High | Assistant alerts with messages only |
| Working now | Default | The Followed Thread's Live Update while it works. Always silent |
| Connection | Min, silent, no badge | `ControllerWatchService`'s ongoing notification |

Each kind has its own `setGroup` key: assistant alerts and Live Updates. Without one, Android bundles the app's notifications into one collapsed card.

### Conversation notifications

Every assistant alert is a conversation notification, because only a conversation notification draws the colleague's face on the left with the app as a badge, as the book does. It has:

- `MessagingStyle`, with the user as "You";
- a `Person` named for the assistant, with the face as an adaptive icon, marked important;
- a long-lived dynamic shortcut whose id is the key, with a `LocusId`, published before the alert.

An app alert, a failure alert and a Live Update are not conversation notifications. An assistant's shortcut stays, because the assistant is a lasting conversation. A thread has no shortcut. A Live Update is public on the lock screen; an assistant alert is private, because it holds the user's messages.

### App alerts

An alert about the app itself opens the app when tapped. It is posted on the "Waiting on you" channel with notification id 10, because the user has to act on it. There are six:

- "You were signed out: the controller no longer accepts this phone's API key. Open the app to sign in again."
- "You were signed out: this phone's API key could not be read. Open the app to sign in again."
- "Hercule could not read this phone's sign-in just now. Open the app to try again."
- "Hercule could not connect in the background. Open the app to connect."
- "Hercule stopped alerting after an error. Open the app to start alerts again."
- "Hercule could not remove this phone's sign-in, because its storage failed. Open the app to try again."

### One UI

These are facts about One UI 8.5 on the target phone ([platform research §5](../research/android/platform.md#5-one-ui-behaviour)). They are phone settings; the app cannot change them.

- **Ordinary notifications show only as icons on the lock screen** by default. Assistant alerts appear in full in the notification list the user opens from the lock screen. The user changes this in Settings → Lock screen and AOD → Notifications.
- **A Live Update shows as a full card on the lock screen itself,** with its segments, its face and its buttons, and as a pill in the Now Bar. One UI does this for a sideloaded app only with Settings → Developer options → "Live notifications for all apps" on. Without it, a Live Update is an ordinary notification in the drawer. The app says so once, on the You screen.
- **Several Live Updates at once are all promoted.** With that setting on, Android granted `FLAG_PROMOTED_ONGOING` to two of the app's Live Updates at the same time. The Now Bar shows one pill; the user swipes between the Live Updates and taps to open either. With two threads waiting, both Requests were approved from the lock screen through it. *(Added 2026-10-14, [#645](https://github.com/theagenticage/hercule/issues/645).)*
- **The status bar chip shows** on the home screen: the short text with the thread's face, such as "Run?". *(Added 2026-10-14, [#645](https://github.com/theagenticage/hercule/issues/645).)*
- One UI adds smart replies to a `MessagingStyle` notification with a `RemoteInput`. They stay on.

~~**Open:** the Live Update's status bar chip was not checked on the phone. Checking it is handed to [#645](https://github.com/theagenticage/hercule/issues/645). *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*~~ **Resolved 2026-10-14 ([#645](https://github.com/theagenticage/hercule/issues/645)):** the chip shows, as above.

## The Live Update

A **Live Update** is Android's promoted ongoing notification. It is a thread's one notification: a thread has no alert. The app posts one per thread that waits on the user, and one for the **Followed Thread** while it works, so several can show at once.

~~The app posts at most one, for the **Followed Thread**. Google meant Live Updates for ongoing work the user started, and the book's lock screen shows one Live Activity beside ordinary notifications.~~ *(Amended 2026-10-14, [#645](https://github.com/theagenticage/hercule/issues/645).)* Every waiting thread now has a Live Update, and a thread's ordinary Request alert is gone. This departs from Google's intent, which is Live Updates for ongoing work the user started, and from the book's lock screen, which shows one Live Activity. The reason: with one Live Update, a thread the user was not following waited unseen in the Now Bar, so its Request could not be answered from the lock screen. Every thread that waits on the user now shows there. The phone stacks several Live Updates in one Now Bar pill, which was tested before the change ([One UI](#one-ui)).

**Which threads.**

- **A thread waiting on the user** (with an open Request) shows its Live Update, whether or not it is followed.
- **The Followed Thread** also shows its Live Update while it works (status Queued, Starting or Busy). The Followed Thread is the thread on screen, or else the thread followed before. It stays followed while it works or waits on the user, or while it is on screen. It stops being followed when it goes idle or ends off screen, or when the user opens another thread.
- A Live Update shows also while its thread is on screen. A thread that neither waits nor works shows none.

A Live Update is ongoing, so the user cannot swipe it away. It goes when the thread's Requests are answered, on the phone or anywhere else, unless it is the Followed Thread and still works.

**Segments.**

- The done steps of the thread's own agent's current turn, counting every item kind except agent messages and reasoning. A subagent's steps do not count. The current turn is the one the latest `turn.started` began.
- The Followed Thread's steps are counted from its whole transcript, which the Thread screen shares. Every other waiting thread follows only its running turn (read once, then followed on the stream). A waiting thread does almost nothing, so following it costs almost nothing.
- At most the last 3, in the thread's hue.
- Then one last segment: while working, the same hue, not yet filled; while waiting, drawn in full in the "you" colour.
- Android draws no labels under segments, so the book's "Read / Edited 3 / 24 passed" labels do not appear.

**Tracker:** the thread's face, in the pose for its state, where the done segments end.

**Short text** (the Now Bar pill):

| State | Short text |
|---|---|
| Working, no Request | Working |
| `command_approval`, `tool_approval` | Run? |
| `file_change_approval` | Edit? |
| `file_read_approval` | Read? |
| `question` | Answer? |
| Any other kind | Waiting |

**Text.** While waiting: "Waiting on you · <question>", with a second line "+N more waiting" when other Requests of the thread are open. N counts open Requests only. Unlike the desktop's notification, the text does not name the subagent that asks. While working: the latest step, such as the command's first line, "Edit <file>", "Read <file>", "Search <pattern>", "Search the web", the tool's name or the subagent's description; "Working" when there is none.

**Buttons:** while waiting, those of the thread's newest open Request ([Answering from an alert](#answering-from-an-alert)); while working, none.

**Alerting.** A waiting thread's Live Update is posted on the "Waiting on you" channel, so it pops up. It alerts once, with sound, when the thread's newest open Request was not open in the last list and the thread is not on screen. Otherwise it is posted silently. The Followed Thread's Live Update while it works is on the "Working now" channel and is always silent ([Channels and grouping](#channels-and-grouping)).

**Promotion.** Android promotes a notification only when it is ongoing, has a content title, has no custom views, is not colourised, is not a group summary, and asks with `setRequestPromotedOngoing(true)`. Whether Android granted it shows as `FLAG_PROMOTED_ONGOING` in `activeNotifications`. The user can turn promotion off per app.

A Live Update equal to the one posted last for its thread is not posted again. At the first decision after the process starts, the app ends any Live Update left from before that no thread shows any more.

## Design

The app draws the book's phone pages (`docs/design/crew-bureau-2/mobile/office.html`, `threads.html`, `session-active.html`, `assistant.html`, `settings.html` and `lock.html`). The bar is "Rogier cannot tell them apart at arm's length", not identical pixels: text renders differently on Compose and in a browser.

### Where the book and Android differ

The book draws an iPhone, and some of it is not Android's or not the wire's. These translations are accepted:

| Book | Chosen |
|---|---|
| Live Activity with labels under the track ("Read / Edited 3 / 24 passed") | Segments only; a Live Update draws no labels |
| Glass cards, wallpaper and the crew on the hill on the lock screen | Out of scope; the system draws the lock screen |
| The colleague's face on the left of a Request alert | For an assistant, a conversation notification: `MessagingStyle`, a `Person` and a long-lived shortcut. For a thread, the face is the Live Update's tracker, where the done segments end |
| Status bar and home indicator in the frame | Not drawn; the test frame adds the insets |
| Wing note "8 of 8 · at cap" on one line beside the runner's name | The note on its own line under the name, from `describeCapacity`; wings are about 15 dp taller |
| Rooms ordered build-box-1, studio-mac, build-box-2 | By name, as `runner.query` lists them |
| Three approval choices | One row per decision the Request offers, up to four: Allow, Allow always, Deny, Cancel |
| "Allow once" on the first approval decision | "Allow", the contract's shared label |
| Hand-picked wing faces | The faces of the threads and assistants whose session runs there, in lane order |
| Request options with tool-specific words ("Always allow git push") | The generic decision words; the Request carries no such data |
| Diff chip "+48 -12", changed-files card, test line | Left out; the transcript carries no diff or test data |
| "Opus 5.5" in the byline | Time only; the wire carries no model display name |
| Mic in the thread composer | Send arrow |
| Thread back badge 9 | The count of threads waiting on the user |
| "Milo" chip, thread chip and "Draft it for Marta" button in Ada's messages | Text only |
| "said out loud" mark, memory and heartbeat footer | Left out |
| Assistant faces from the book's `CAST` table | `buildAssistantLook`, as the desktop |
| Runs, the Paused lane and step descriptions on the Office | Left out ([Office](#office)) |
| No page draws an exited thread open | A resumable exited thread keeps its asleep face in the bar while its composer is enabled, as on the desktop ([Thread](#thread)) |
| The working mark's dots take turns fading | The three dots stand still. One animation per working row would redraw the list every frame while anything works |
| Code chips in the paragraph Ada is still writing | Plain text, its backticks showing, until the paragraph is finished, as on the desktop ([Messages as markdown](#messages-as-markdown)) |
| A link's `title` shows as a tooltip on hover (desktop `markdown.tsx`) | No tooltip; the title is read out with the link's text ([Messages as markdown](#messages-as-markdown)) |
| A details block's chevron darkens on hover (desktop `markdown.css`) | The chevron keeps its colour |
| A selection on the desktop can run across several messages | A selection stays within one message, each message being its own selection ([Messages as markdown](#messages-as-markdown)). *(Approved by Rogier, 2026-10-18, [#747](https://github.com/theagenticage/hercule/issues/747).)* |

### Tokens

`scripts/gen-android-tokens.ts` (`pnpm gen:android-tokens`) reads `docs/design/crew-bureau-2/tokens.css` and writes `apps/android/app/src/main/kotlin/dev/hercule/android/theme/Tokens.kt`:

- one field per colour token, in two instances: the light theme Whitehaven and the dark theme Orient Express. The book's other three themes are left out;
- the four colours of each crew hue (`--who`, `--who-shade`, `--who-ink`, `--who-tint`) per theme, worked out in the script so the app does no oklch maths;
- the theme-independent scales: type sizes, weights, spacing, radii, durations, easings and hue angles.

Colours are in **Display P3**, not sRGB: the phone's screen is wide gamut, and several of the book's oklch colours lie outside sRGB. A colour outside P3 too is clamped per channel, and its Kotlin line says so. The activity asks for a wide-gamut window (`android:colorMode="wideColorGamut"`); without it, Android draws the window in sRGB and clamps every P3 colour outside sRGB.

The Kotlin file is checked in, because Gradle does not run TypeScript. It starts with a line saying it is generated by `scripts/gen-android-tokens.ts` and must not be edited. A test in the script's own test file fails when the checked-in file is stale. The theme follows the system: light is Whitehaven, dark is Orient Express.

### Fonts

The book's woff2 fonts are converted to TTF with fonttools (`uvx --from 'fonttools[woff]' fonttools ttLib.woff2 decompress <file>.woff2`) and bundled:

| Resource | Axes |
|---|---|
| `bricolage_grotesque.ttf` | opsz 12-96, wght 200-800, wdth 75-100 |
| `limelight.ttf` | none |
| `recursive.ttf` | MONO, CASL, wght 300-1000, slnt, CRSV |

- Every `Font` sets its axes through `variationSettings`. The default instances are not what the book draws: Bricolage's is the 96 pt ExtraBold cut, and Recursive's is Sans Light.
- Bricolage's Latin Extended subset is not bundled. A Compose `FontFamily` does not fall back between files, so the subset would never be used. Characters outside Latin-1 fall back to the system font.
- Each font's `OFL.txt`, fetched from its upstream repository, is bundled in `assets/licenses` and shown on the You screen.
- The licences of commonmark-java, the markdown parser the app ships, and of marked, whose rules the Kotlin port copies, are bundled beside them and shown on the You screen too: commonmark-java's BSD-2 licence asks that a binary carry its notice, and marked's MIT notice is in the source files that port its rules.

### Icons

- **The app icon** is the book's mark, a lime egg with two eyes and a waxed mustache (`docs/design/crew-bureau-2/crew.js:763-795`, as the desktop's `logo-mark.tsx` draws it), as an adaptive icon: the lacquer colour as background, the mark as foreground, and a one-colour mark as the monochrome layer for themed icons. The brass ring is left out, because launchers mask the icon into different shapes.
- **The notification small icon** is the mark in one colour, with the eyes and the mustache cut out. It shows on every alert and in the Now Bar pill.
- **The sign-in mark** has a dark-theme drawing in `drawable-night`.
- The vector drawables are written by hand from the mark's SVG paths.

### Faces

The crew faces are a port of `apps/desktop/src/renderer/faces/` to Compose Canvas.

- A face is seeded by id, never by name. Threads use `buildLook(session.id)`; assistants, including the one named Hercule, use `buildAssistantLook(assistant.id)`.
- The port passes the known-answer vectors of `look.test.ts` as JVM tests. `face.test.tsx` pins SVG strings, which do not apply to Canvas, so its cases are ported as checks on the look and the pose.
- The desktop's specimen sheet (`apps/desktop/src/renderer/specimens/cells.ts`) is the golden for the drawing. `FaceSpecimenTest` renders the same cells, and the sheets are compared side by side.
- An alert's face is the same face, drawn into an adaptive icon for the `Person` and the tracker.

### Accessibility

- Every screen works at 200% font scale; text wraps or the screen scrolls, and nothing is cut off. The Office has a golden at 200%.
- Every tap target is at least 48 dp. A control drawn smaller than 48 dp, as the book draws many, keeps its drawn size and gets a 48 dp touch area. Compose gives it one: it extends the touch area of any control that takes taps, and the bounds TalkBack reports, to 48 dp without changing the layout. `TouchAreaTest` checks every kind of control drawn under 48 dp. Two limits follow from keeping the book's layout:
  - Where the book places a control closer than 24 dp to the edge of another, a tap on the other's drawn area goes to the other. The composer's attach button sits 4 dp from the text field, so a tap 7 dp past its edge focuses the field. The drawn area always wins, so a tap never reaches a control the finger is not on.
  - A disabled control drawn without a click handler, such as New thread, which the app does not offer yet, takes no taps, so it has no touch area and TalkBack reports its drawn bounds.
- Hold-to-talk works with TalkBack ([Hold-to-talk](#hold-to-talk)).
- Screens draw inside the system insets in landscape as in portrait, including the camera cutout's side; `LandscapeScreenTest` covers it.

**Open:** UI text lives in Kotlin, not in Android string resources; only alerts use resources. Moving it touches every golden. Whether and when to move it is handed to [#648](https://github.com/theagenticage/hercule/issues/648). *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

## Performance

### Baseline

Measured on the target phone during the prototype's acceptance, against `world:book` on the Mac over Tailscale, and reported, not gated. The idle run lasted 37.5 minutes, with battery stats reset after the app was swiped away, the phone unplugged and locked (screen off 96% of the time).

| Measure | Result |
|---|---|
| Battery | 0.084 mAh in 37.5 min: about 0.13 mAh an hour, 0.003% of the 5000 mAh battery an hour, and 0.26% of what the whole phone used (32.6 mAh) |
| Wake locks | 143 ms in total (one alert posted) |
| CPU | 6.2 s in 37.5 min |
| Network | 127 KB over Wi-Fi, about 250 packets each way: the 30-second ping |
| Cold start to the Office | 485, 469 and 459 ms on the phone; about 540 ms on the emulator |
| Memory (PSS) | 143 MB idle with no UI, after the UI had been used; 127 MB just after a cold start with the Office open; 87 MB idle on the emulator |
| APK | 36.7 MB debug, 27.7 MB release (unsigned) |

One `/ws` socket in a foreground service with a 30-second ping costs close to nothing on this phone, so FCM is not needed for battery reasons. Memory is the number to watch: the idle process held more without its UI than a fresh start with the Office open.

**Open:** the service could drop the UI's caches once the app leaves the screen, then measure idle memory again. Whether that brings the 143 MB down is handed to [#649](https://github.com/theagenticage/hercule/issues/649). *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

### Markdown ([#747](https://github.com/theagenticage/hercule/issues/747)), 2026-10-18

Measured on the target phone (120 Hz, so a frame has 8.3 ms) against the live controller over Tailscale, comparing `main` (edb155e4b, which draws only code fences) with the markdown branch after its performance work (645c09cbd). Both are release builds, not debuggable, signed with the debug key so they install over the app and keep its sign-in, and compiled as an install compiles them (`cmd package compile -m speed-profile -f`). A debug build runs much of the app in ART's interpreter, so its numbers say little about what a user sees and served only to find the costs. Reported, not gated. Each row gives the median and, in brackets, the range of three runs.

| Measure | main | branch |
|---|---|---|
| APK, debug | 36.0 MB | 36.8 MB (+0.8 MB) |
| APK, release (unsigned) | 27.9 MB | 28.4 MB (+0.5 MB) |
| Long thread fling: frames | 4,143 | 4,094 |
| Long thread fling: p50 / p95 / p99 | 8 / 10 / 13 ms | 8 / 10 / 20 ms |
| Long thread fling: frames over 16 ms | 23 (19-24) | 65 (61-65) |
| Long thread fling: frames over 32 ms | 0 | 12 (10-12) |
| Long thread fling: janky frames | 1.4% (1.4-1.5) | 2.1% (2.1-2.1) |
| Long thread fling: slow UI thread | 55 (53-58) | 84 (81-84) |
| Long thread: PSS after the fling | 120.5 MB (119.0-124.5) | 134.0 MB (133.4-134.0) |
| Long thread: peak RSS (`VmHWM`) | 205.3 MB (205.1-206.1) | 211.6 MB (211.1-211.7) |
| Streaming a 20 KB reply: frames | 931 (561-933) | 1,313 (1,306-1,337) |
| Streaming a 20 KB reply: p50 / p95 / p99 | 15 / 23 / 28 ms | 10 / 18 / 27 ms |
| Streaming a 20 KB reply: frames over 16 ms | 335 (176-389) | 99 (93-102) |
| Streaming a 20 KB reply: frames over 32 ms | 2 (2-6) | 6 (5-7) |
| Streaming a 20 KB reply: janky frames | 66% (66-67) | 44% (44-44) |
| Streaming a 20 KB reply: main thread CPU | 11.2 s (6.9-11.6), 12 ms a frame | 11.2 s (11.2-11.4), 8.5 ms a frame |
| Streaming a 20 KB reply: CPU of the whole app | 20.8 s (15.2-21.3) | 24.4 s (24.3-24.6) |
| Streaming a 20 KB reply: PSS after | 104.6 MB (103.4-104.9) | 137.7 MB (129.5-139.1) |
| Streaming a 20 KB reply: peak RSS | 204.6 MB (202.4-205.6) | 219.5 MB (218.6-220.0) |
| Streaming a 20 KB reply: token to screen, p50 / p95 / p99 (one run) | 13.7 / 25.7 / 291 ms | 12.2 / 19.5 / 29 ms |

The branch streams better than main on every frame measure but the frames over 32 ms, and draws 40% more frames for the same reply, with no more main-thread time. Flinging the long thread is worse than main, and the branch holds more memory, from the parsed documents and the drawn markdown. The long frames of the fling are rows coming into view: composing their markdown (building the text of each block) and laying out tables. The same fling with the parse still in composition and the row layers (562337ce1) has as many frames over 32 ms, so moving the parse did not cause them. They were not optimized further.

What the performance work changed, each in a commit of its own, with what a profile of the release build showed it costs before:

- **A layer per transcript row, and one around a message's finished blocks** (562337ce1). Recording the drawing again was 60% of the main thread while a reply streamed, because every token re-recorded every visible row's text.
- **A streamed token builds again only its message's block** (a437a1003, [#650](https://github.com/theagenticage/hercule/issues/650)): 0.13-0.30 ms per token for the whole long thread on the Mac's JVM, 0.006-0.016 ms after.
- **Messages are parsed off the main thread, once per text** (cb083fdc5): the parse was 4-5% of the main thread while streaming and 3% while flinging, and a settle of a 20 KB reply took 4.7 ms in a release build.
- **A screen's state changes at most once a frame, and a thread's bar shows before its transcript** (645c09cbd). The Thread screen was blank, the bar included, until its whole transcript was read and decoded: 0.4-0.7 s for the long thread's 1.7 MB in a release build, about 3 s in a debug build. Both builds now show content 0.7-1.1 s after the tap, measured from screenshots 0.35 s apart, and the branch shows the bar in between.
- **TailBuffer** keeps its `+`: a row removes its text from the tail's front every 4 KB, so a tap copies at most that, 1.2-1.6 ms in all for a 20 KB reply on the Mac's JVM, and a `StringBuilder` was no faster.

Two costs remain that the app does not cause: with any accessibility service on, such as Link to Windows on the target phone, Compose checks the semantics tree for changes every 100 ms, which was 12-22% of the main thread while streaming and most of `advanceGlobalSnapshot`'s 17% while flinging; and the paragraph being written is laid out again on each token, so a long paragraph costs more per token as it grows.

How each was measured:

- **The long thread** is "Fix GitHub mention reply shortcut contrast and rendering" (01a14402): 51 agent messages, 50.8 KB of markdown with 40 table rows, 5 code fences and many lists, the longest message 5.7 KB. Each run force-stops the app, opens the thread with `am start -W` and the alert destination extra (`--es dev.hercule.android.extra.ALERT_DESTINATION thread:<id>`), waits 6 s, resets `dumpsys gfxinfo`, flings 80 times towards older messages on the phone itself (`input swipe 540 700 540 1900 120`, then 0.25 s, in one `adb shell` loop), which reaches the first message in both builds, then reads `dumpsys gfxinfo dev.hercule.android framestats`, the total PSS and `VmHWM` from `/proc/<pid>/status`. Three runs after one warm-up run per install. The percentiles and the frames over 16 and 32 ms come from the gfxinfo histogram.
- **Streaming** spawns a Haiku Thread (`hercule session spawn --instance c15ae616 --model haiku --access-mode approval-required`) whose prompt asks it to copy a fixed 20 KB markdown document exactly, so both builds stream the same text at Haiku's pace, about 1,000 characters a second. The thread is opened on the phone at once, and the window ends when the session is idle. A run counts only when the reply is the document and the phone drew more than 400 frames: in about half the runs, in both builds, the phone got the reply only in the controller's 4 KB rows, which a later ticket should look into. The CPU is the threads' `utime + stime` from `/proc/<pid>/task/*/stat` over the window.
- **Token to screen** used builds of both, not committed, that log each token's arrival in the store and each time the message's row is drawn, and gives, for each token, the time to the first draw that shows it.
- **APK size:** `./gradlew assembleDebug assembleRelease`, the files in `app/build/outputs/apk/`.

**Parsing on the phone's ART.** A temporary instrumentation test, never committed, ran the JVM markdown tests on the phone: `MarkdownParityTest` built the same tree as on the JVM for all 3,564 parses (none differs besides the known differences, and no pin went stale), and `MarkdownTest`, `MarkdownHtmlTest`, `StreamingTextTest` and `MarkdownWorstCaseTest`'s checks passed. The guard boundaries parse with no `StackOverflowError` on a 1 MB thread and on the main thread: emphasis 299 deep in alt text, and quotes 299 deep flattened inside `<b>`. Parse times, in the debug build and in a non-debuggable build of the same code (installed beside it as `dev.hercule.android.perf`, then removed):

| Parse | debug | not debuggable | Mac JVM |
|---|---|---|---|
| A settle of a 20 KB streamed reply (the finished part parsed again) | 16-19 ms | 4.7-4.9 ms | |
| The 20 KB message of `MarkdownSpeedTest` | 47 ms | 32 ms | 3.3 ms |
| The thread's 5.7 KB message, first parse in the process | 45-52 ms | 17 ms | |
| The thread's 5.7 KB message, warm | 9-10 ms | 2.5 ms | |
| A row of the thread, warm: p50 / p90 | 1.6 / 3.7 ms | 0.4 / 0.9 ms | |
| The slowest worst-case inputs of 200 KB | 1,028 ms and 1,282 ms (over the test's 1,000 ms ceiling) | 499 ms and 619 ms | 48 ms and 53 ms |
| Indented lists 1,000 deep (1 MB) | 3,537 ms (over the ceiling) | 502 ms | 196 ms |
| `splitStreamingText` on 21 KB | 0.3 ms | 0.09 ms | |

In the debug build the phone runs, a settle of a long reply and the first draw of a long row each cost two to six frames on the main thread, and even without the debugger's cost a settle takes over half a frame. So parsing moved off the main thread (cb083fdc5, above).

### Measuring

Each number is measured on the target phone over wireless debugging (`adb -s <ip:port>`). Package `dev.hercule.android`.

- **Battery, wake locks, CPU and network:** `adb shell dumpsys batterystats --reset` with the app running and swiped away, the phone unplugged and locked; leave it idle (an hour is the target); then `adb shell dumpsys batterystats dev.hercule.android`. Keep the Mac awake during the run with `caffeinate -i`, and stop it by its PID afterwards.
- **Memory:** `adb shell dumpsys meminfo dev.hercule.android`, reading the total PSS: once idle with no UI after use, once just after a cold start with the Office open.
- **Cold start:** `adb shell am force-stop dev.hercule.android`, then `adb shell am start -W dev.hercule.android/.MainActivity`, reading `TotalTime`. Three runs.
- **APK size:** the files in `app/build/outputs/apk/debug/` and `release/`.

## Testing

**The check.** From `apps/android`:

```
./gradlew assembleDebug testDebugUnitTest verifyRoborazziDebug lintDebug
```

It must pass with no warnings: Kotlin's `allWarningsAsErrors` and lint's `warningsAsErrors` are on. Gradle's own deprecation notices that come from AGP, not from the app's build files, do not count. `./gradlew recordRoborazziDebug` records the goldens again.

CI runs the check above as a job named `android`, whenever CI runs; a change to Markdown alone runs nothing. The job runs on a macOS runner, because the goldens are recorded on a Mac: on Linux, five of them differ by anti-aliasing at the edge of vector shapes. A Linux job would need goldens recorded on Linux, which the local check on a Mac would then fail, or a tolerance, which loosens the comparison. When the check fails, the job uploads Roborazzi's compare images and the test and lint reports as the artifact `android-check`, kept for seven days. *(Resolved 2026-10-15, [#646](https://github.com/theagenticage/hercule/issues/646).)*

**Tests:**

- **JVM tests** on Robolectric (SDK 36, the phone's level), with no emulator: the alert rules, the Live Updates, the credentials, the live connection against `mockwebserver3`, the `client-core` ports with their copied cases, the face vectors, and the screens' behaviour (`AssistantScrollTest`, `LandscapeScreenTest`).
- **Screenshot goldens** with Roborazzi, committed under `app/src/test/screenshots/`. Every screenshot test runs with `@GraphicsMode(NATIVE)`; without it, Robolectric draws neither the P3 colours nor the variable font axes.
- **Compare sheets** in `apps/android/screenshots/compare/`: the book page beside the app, for the Office, the Threads list (`threads-light.png`, `threads-dark.png`), the Thread waiting on a Request and the Assistant, in light and dark, at 390×844 dp, the book's frame. The book side is rendered with `node docs/design/shared/shoot.mjs <page file> <out.png> --w 390 --h 844 --scheme light|dark`, such as `node docs/design/shared/shoot.mjs docs/design/crew-bureau-2/mobile/threads.html out.png --w 390 --h 844 --scheme light`. A dark shot needs `?theme=dark` on the page's path as well as `--scheme dark`, because `tokens.css` switches theme by an attribute, not by `prefers-color-scheme`. The Threads sheets are full length, so the lower lanes and the open Done shelf are compared too: the book side is `threads.html?state=done-open` with its `.phone` frame grown by however far its `.m-body` scrolls, beside the full-length golden of `drawsOpenDoneShelf`. Each sheet lists its accepted differences under the pair. Every remaining difference is one of the accepted translations ([Where the book and Android differ](#where-the-book-and-android-differ)).
- **The Threads goldens:** `ThreadsScreenTest` draws the full list, the empty state and the Done shelf open, in light and dark. `ThreadScreenTest` draws a thread that cannot be resumed, with its disabled composer.
- **The markdown specimen:** `MarkdownSpecimenTest` draws a message holding every element the tree can hold, in light and dark.
- **The face specimen sheet,** beside the desktop's.
- **Acceptance captures** in `apps/android/screenshots/acceptance/`: the emulator, against the book world, from sign-in to an assistant's reply alert.

**The book world.** `apps/desktop/scripts/book-world.ts` starts a throwaway controller in a new Hercule Home under the system's temp folder, never `~/.hercule`, and fills it with the world of `docs/design/shared/CONTENT.md`: the projects, Ada, Milo and Juno, and the book's threads on three scripted runners sized as in the book. Run it after `pnpm build:binary`:

```
pnpm --filter @hercule/desktop world:book [--host <address>] [--port <port>] [--defer-question] [--defer-approval]
```

- `--host` binds to another address than 127.0.0.1, such as the Mac's tailnet address for the phone.
- `--port` asks for a fixed port, so a device's saved address keeps working across runs.
- `--defer-question` and `--defer-approval` hold back the book's question and approval, so the app can be watched as they open and alert.
- The script keeps running while the app is used, and answers each message to Ada with a canned reply.
- Juno is asleep: she answers one message, and her session is then unloaded with reason `idle_unload`.
- The book's Runs are made as ordinary threads with the same titles, because the app shows no Runs. The paused Trigger is left out.

The book world is not Android-specific: it seeds the book's world on any controller.

## Distribution

The app is a debug APK, installed on the target phone over wireless debugging:

```
adb -s <ip:port> install -r app/build/outputs/apk/debug/app-debug.apk
```

The steps to pair the phone are in [the platform research §3](../research/android/platform.md#3-installing-on-the-phone). The app is not on the Play Store, which is also why the `specialUse` service and the battery ask need no store review.

**Open:** release signing. The release APK is unsigned. Which key signs it, where that key is kept and how a build reaches it is handed to [#647](https://github.com/theagenticage/hercule/issues/647). *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

**Open:** how updates reach the phone. Today a new build is installed by hand with `adb`. Whether the controller serves the APK, the app checks for updates, or a store-like channel does it is handed to [#647](https://github.com/theagenticage/hercule/issues/647). *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

## Post-v1

The phone app is itself beyond what spec 01 obliges for v1. These are what later milestones add:

- **The other screens:** Intake, Decision, New thread, Runs and Triggers.
- **Mark done, Reopen and search** on the Threads tab.
- **Memory and reminders** on the Assistant screen, once operations read them.
- **Voice in the thread composer.**
- **Presence-aware routing** ("desktop idle, send to phone"), which stays post-v1 in [./01-overview-and-scope.md](./01-overview-and-scope.md). It would make the phone a sink of the core's router (ADR 0012), not change how the phone decides its own alerts.
- **Another push path** if a later phone measures a real drain: connecting only on chosen Wi-Fi networks, a slower ping, UnifiedPush through a self-hosted ntfy, or FCM ([platform research §7.3](../research/android/platform.md#73-alternatives-if-the-battery-cost-is-too-high)).
- **Other phones and tablets,** and the themes beyond light and dark.
- **iOS.** Not prepared by anything here; its own decision.
- **A live wallpaper** of the crew, the book's lock screen idea.

## Sources

- [Android prototype: the assistant, threads, and lock screen notifications, native in Kotlin (#630)](https://github.com/theagenticage/hercule/issues/630)
- [#630: the prototype report](https://github.com/theagenticage/hercule/issues/630#issuecomment-6143269197)
- [#630: the phone results, acceptance 5 and 7](https://github.com/theagenticage/hercule/issues/630#issuecomment-6144697779)
- [ADR 0042 - The phone app is a native Android client of the public API](../adr/0042-the-phone-app-is-a-native-android-client-of-the-public-api.md)
- Research: [wire.md](../research/android/wire.md), the HTTP API and the `/ws` socket as a native client reads them, with the crew face algorithm, the fonts and the tokens; [platform.md](../research/android/platform.md), the phone, the toolchain, One UI's behaviour, notification facts and the background connection; the notification probe's [source](../research/android/probe-source/) and [screenshots](../research/android/probe-screenshots/)
