# Android app

The Android app is a native phone app, written in Kotlin with Jetpack Compose and drawn in the Crew Bureau design system. Like the web app and the desktop app, it is an ordinary client of the public API, with no privileged path ([ADR 0042](../adr/0042-the-phone-app-is-a-native-android-client-of-the-public-api.md)). It shares no code with the other clients: it reads the same HTTP API and `/ws` socket with its own Kotlin types.

This document covers:

- the scope of the first milestone and the one target phone
- the Gradle project, its stack and its names
- reaching the controller, signing in, and storing the API Key
- the live connection and the foreground service that holds it
- the screens and how each translates the book
- the alerts and the Live Update
- the design system on Compose
- the performance baseline and how to measure it
- testing and distribution

What a thread does - its transcript, its Requests, its composer - is owned by [./14-web-app.md](./14-web-app.md). What an assistant's Conversation is is owned by [./12-assistants.md](./12-assistants.md). This document owns how the phone draws that behaviour, and what the phone adds: alerts on the lock screen and a Live Update for one thread.

**Status:** locked 2026-10-13 for [Android prototype: the assistant, threads, and lock screen notifications, native in Kotlin (#630)](https://github.com/theagenticage/hercule/issues/630), with [ADR 0042](../adr/0042-the-phone-app-is-a-native-android-client-of-the-public-api.md). The prototype on branch `prototype/android` (`apps/android`) builds everything here and passed every acceptance step. It is not merged. A landing ticket brings it to `main` with the changes this document makes to it; [Landing the prototype](#landing-the-prototype) lists them.

## Scope of the first milestone

**The phone.** The app has one target device: Rogier's Samsung Galaxy S23 Ultra (SM-S918B) on Android 16 QPR2 (SDK 36.1, One UI 8.5). Nothing else needs to be supported, and no rule here is bent to support another phone.

**SDK levels:** `minSdk 36`, `targetSdk 36`, `compileSdk 37`.

- `compileSdk` is 37 because Compose 1.12 (in Compose BOM 2026.09.00) refuses to build against anything lower.
- `targetSdk` stays 36, because targeting 37 adds local-network rules whose effect on a controller reached over Tailscale is unverified.
- The Live Update needs `setRequestPromotedOngoing`, which exists only from SDK 36.1. An SDK 36.0 device or emulator cannot draw one.

**In:**

1. **Sign in:** the controller's address, the user name and the password.
2. **Office:** the home screen, with threads and assistants only.
3. **Thread:** the transcript, live while open; the docked Request; a composer.
4. **Assistant:** the main Conversation, live; the docked Request; a composer with hold-to-talk.
5. **You:** the account, the live connection with Sign out, the two phone settings that keep alerts arriving, and the font licences.
6. **Alerts and the Live Update,** posted by a foreground service that holds one `/ws` socket while the user is signed in.

**Out:** Intake, Decision, New thread, Runs, Triggers, Settings (except sign out and the connection), tablets, and themes other than light and dark following the system. The tab bar keeps the book's shape: its Threads tab, Intake tab and new-thread button are drawn faint and do nothing ([The tab bar](#the-tab-bar)).

## Architecture

### The Gradle project

`apps/android` is a Gradle project with one `:app` module. It is not a pnpm package, and no `pnpm` command builds or checks it; it has its own check command ([Testing](#testing)). Gradle's outputs (`.gradle/`, `build/`, `local.properties`) are ignored by git, by oxfmt and by eslint.

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

The four SDK 36 notification calls (`setRequestPromotedOngoing`, `setShortCriticalText`, `ProgressStyle`, `canPostPromotedNotifications`) go through `NotificationCompat` and `NotificationManagerCompat`, which check the version themselves. The app's code has no version branches, and lint's `NewApi` check stays quiet.

### Names

- **Alerts, not notifications.** CONTEXT.md's **Notification** is the controller's own message record, which the app never reads. The app's code calls the Android notifications it posts **alerts** (`AlertKey`, `AlertPoster`, `AlertActionReceiver`), so the two never share a name. Android's own classes keep their names.
- **No bare `Thread` type.** Kotlin has `java.lang.Thread`. The record is `Session`; the screen and its row are `ThreadScreen` and `ThreadRow`.
- **`ControllerWatchService`** is the foreground service that holds the one `/ws` socket, decides which Requests and messages alert, and posts the alerts. The prototype calls it `ConnectionService`, which shares a word with CONTEXT.md's **Connection**; the landing ticket renames it.
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
| `alerts/` | The alert rules, the pipeline that runs them, the poster, the Live Update, and the receiver for alert buttons |
| `office/` | The Office's data: the lanes, Request questions, poses, capacity, ages. The `client-core` ports live here |
| `faces/` | The crew faces, drawn on Canvas |
| `theme/` | `Tokens.kt` (generated) and `Fonts.kt` |
| `ui/` | The screens and their view models, and the shared components |

Tests sit under `app/src/test/`, beside the same packages. Screenshot goldens are committed under `app/src/test/screenshots/`.

### Decoding the wire

Every enum on the wire decodes as an open string with an "unknown" branch, so a new value from a newer controller never fails a read. `item.*.detail` is untyped JSON whose keys differ per provider, so every key is optional, and an item of an unknown kind gets a generic row. The wire itself is described in [the wire research](../research/android/wire.md).

### Logic ported from `client-core`

The app shares no code with `client-core` ([ADR 0042](../adr/0042-the-phone-app-is-a-native-android-client-of-the-public-api.md)). It ports these functions to Kotlin:

| Function | Source |
|---|---|
| `listWaiting` | `packages/client-core/src/waiting.ts` |
| `formatRequestQuestion` | `packages/client-core/src/request-question.ts` |
| `decideThreadPose` | `packages/client-core/src/session-pose.ts` |
| `describeCapacity` | `packages/client-core/src/runner-capacity.ts` |
| `decideOpenReply` | `packages/client-core/src/assistants/conversation-blocks.ts` |

Each port:

- names its source file in a comment at the top;
- has JVM tests with the same cases as the source's test, copied case by case, with the source test's path in a comment.

A change to one of these functions in `client-core` changes its Kotlin port and the copied tests in the same pull request. The crew faces are a port too ([Faces](#faces)).

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

**Storing the key.**

- The key is encrypted with AES-256-GCM under an Android Keystore key (alias `api_key_encryption`), through `javax.crypto`. The ciphertext, with its 12-byte IV in front, is stored in DataStore beside the controller's address, the user name and the key's id. `EncryptedSharedPreferences` is deprecated and not used.
- The Keystore key requires neither user authentication nor an unlocked device. An alert button answers a Request while the phone is locked, and that call needs the key.
- One lock serializes sign-in, sign-out and restoring the stored sign-in at start, so none of them can interleave.

**When stored credentials are cleared.** Only two errors mean the stored key can never be read again: `KeyPermanentlyInvalidatedException` (the Keystore key is gone) and `AEADBadTagException` (the ciphertext is damaged). Only these two clear the stored credentials, and the user signs in again. Any other storage failure (`GeneralSecurityException`, `ProviderException`, `IOException`) may pass: the credentials are kept, and the app posts an app alert ([App alerts](#app-alerts)) saying it could not read the sign-in just now.

**A revoked key.** When the controller refuses the key (`unauthenticated`), the app clears the sign-in, returns to the sign-in screen and posts an app alert saying the controller no longer accepts this phone's API Key. The controller does not close the socket when a credential is revoked; the next call fails, and that is how the app learns of it.

**Signing out**, in this order:

1. Stop the live connection and the service.
2. Remove every alert, the Live Update and every shortcut.
3. Clear the alert memory ([When to alert](#when-to-alert)).
4. Remove the stored key and its id. The address and the user name stay, so signing in again takes only the password.
5. Call `apiKey.revoke` (`DELETE /api/v1/api-keys/:id`) with the old key. A key may revoke itself. An `unauthenticated` reply counts as done, because the key no longer works. Any other failure shows a toast that says the key still works and that the user can revoke it in the web app's settings.

Local credentials are cleared before the revoke, so a sign-out never depends on reaching the controller. `auth.logout` is not used: it refuses an API Key ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md#secret-credential)).

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
| `session:<id>:stream` | A thread's transcript, while its screen is open, from its cursor |
| `session:<id>:tap` | The token deltas of a thread or an assistant's session, while its screen is open |

Projects have no topic, so they are read each time the connection comes up. Pushes that arrive while a read is running are merged into one read after it.

### Keepalive and reconnect

- **Keepalive:** the `ping` RPC every 30 seconds, and nothing more often, because each message wakes the radio. No reply within 10 seconds means the socket is dead, and the app reconnects. This is slower on purpose than the 5 to 15 seconds the desktop uses: on the phone, the radio's wake-ups are the cost. `hello` has the same 10-second limit.
- **Reconnect:** the first wait is 1 second, doubling up to 30 seconds. Each wait is shortened by up to 20% at random, so many clients do not reconnect in step. The wait starts over at 1 second once a connection has stayed up for 30 seconds.
- **A `Defect` frame reconnects.** A `Defect` means the controller could not parse a frame the app sent, so a reply to one of the app's requests may never arrive. The app drops the socket and reconnects. The wire research ([§B](../research/android/wire.md#b-live-websocket-ws)) notes that the controller keeps the socket open after a `Defect`; this rule overrides what a client does with it.
- A subscription to a topic that does not exist, such as the stream of a deleted session, ends without a retry.

### ControllerWatchService

`ControllerWatchService` is a foreground service of type `specialUse`. While the user is signed in, it:

- holds the one `/ws` socket;
- runs the alert pipeline, which decides which Requests and messages alert;
- posts the alerts and the Live Update.

**Why `specialUse`.** `dataSync` is limited to 6 hours in every 24, and `connectedDevice` requires a paired device. Its `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` reads:

> Keeps one connection open to the user's own self-hosted agent controller, so that alerts about agents waiting on the user arrive in time. The controller is not reached through Firebase Cloud Messaging, so no push service can deliver them instead.

Play Store review would question `specialUse`. The app is not distributed through the Play Store ([Distribution](#distribution)).

**Its ongoing notification** sits on the "Connection" channel, with notification id 11. Its title says where the connection stands: "Connecting to <host>", "Connected to <host>" or "Reconnecting…". Android requires it for as long as the service runs.

**Starting.** The service starts at sign-in, after boot (`BOOT_COMPLETED`) and after an app update (`MY_PACKAGE_REPLACED`), through `BootReceiver`. Each start calls `startForeground` first. When Android refuses the start (`ForegroundServiceStartNotAllowedException`), the service stops and posts an app alert saying Hercule could not connect in the background and the user should open the app. When the user grants the notification permission after the service started, the service posts its notification again, because Android dropped the first one.

**Keeping it alive.** The service survives the app being swiped away. One UI puts apps to sleep that have not been opened for a while, so the phone needs two settings:

- After sign-in, the app asks once for `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. It remembers that it asked, in DataStore, and does not ask again.
- The You screen tells the user to add Hercule to Settings → Battery → Background usage limits → **Never auto sleeping apps**. The app cannot set this itself.

The app asks for `POST_NOTIFICATIONS` at sign-in.

**Open:** the background-permission ask is not repeated if Android kills the process while the ask is on screen. Whether to ask again at the next start, and how to tell that case from a refusal, is handed to a ticket. *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

### The manifest

| Entry | What it is for |
|---|---|
| `INTERNET` | The controller |
| `POST_NOTIFICATIONS` | Alerts |
| `POST_PROMOTED_NOTIFICATIONS` | The Live Update |
| `VIBRATE` | The haptics of alert buttons, in the receiver |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE` | `ControllerWatchService` |
| `RECEIVE_BOOT_COMPLETED` | Restarting the service after boot |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | The one battery ask. Lint's `BatteryLife` check is silenced for it, because the ask is the point |
| `RECORD_AUDIO` | Hold-to-talk |

Components:

- `MainActivity`: `singleTop`, the launcher activity.
- `ControllerWatchService`: not exported, `foregroundServiceType="specialUse"`.
- `AlertActionReceiver`: not exported. It receives every alert button.
- `BootReceiver`: exported, for `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`.
- The network security config ([Reaching the controller](#reaching-the-controller)) and the data extraction rules.

## Screens

Every screen is drawn from the book's phone pages in `docs/design/crew-bureau-2/mobile/`. Navigation is Navigation 3. The bar at the top and the tab bar are the book's; the status bar and the gesture bar are the system's, and the screens lay out inside their insets.

### Sign in

The book has no sign-in page. The layout is the desktop's centred screen: the mark, 40 dp, 12 dp from the wordmark "Hercule" in Limelight at 32 sp, above a 320 dp column for the address, the user name and the password. The column's top sits at 34% of the window's height, so it does not move when an error line appears. While the keyboard is open, the form scrolls until the Sign in button sits 24 dp above it.

The form starts with the address and user name of the last sign-in, so signing in again takes only the password. Editing a field while an error shows hides the error.

### Office

The Office (`mobile/office.html`) is the home screen. It shows threads and assistants only.

- **Receipt line:** one count per lane shown, such as "3 waiting on you · 8 working · 4 idle". The waiting count is bold, in the waiting colour.
- **Plan:** one wing per runner from `runner.query`, two to a row, then the Lobby. A wing shows up to four faces of the threads placed there, with "+N" for the rest, then the runner's name and, on its own line under the name, its capacity line from `describeCapacity`, such as "8 running of 8". The Lobby holds the asleep assistants. Wings are ordered by the runner's name, as the desktop orders them. Faces follow lane order: Waiting on you oldest first, then Working, then Idle.
- **Lanes:** Waiting on you, Working, Idle. There is no "waiting on you" endpoint; `listWaiting` derives the list from sessions and their open Requests. Run sessions (`runId` set) are left out, as the desktop leaves them out of Waiting on you.
- **Rows:** the face, the title, the age, and a second line of `<project> · <state>`. The project name comes from `project.query`. The state is the question for a waiting row (`formatRequestQuestion`), in the waiting colour, and the pose words for the others. The age is the time since `lastActivityAt`. A lane's head shows its count, and Waiting on you also shows its oldest age.
- **The ask card.** The first row of Waiting on you is drawn as the book's ask card when its Request is an approval, so it can be answered from the Office: **Allow** and **Deny**, each shown only when the Request accepts it. Once answered, the buttons stop taking taps; a failed answer makes them answerable again.
- Tapping a row opens its Thread or its Assistant.

**Not shown, and why:**

- Runs, because the desktop keeps run sessions out of Waiting on you and out of notifications.
- The Paused lane. In the book it holds a Trigger paused by its Spawn Bound, which is not a thread.
- The book's step descriptions ("running `pnpm test cart`", "step 2 of 4"). A session record has no such field, and reading every transcript to get one costs a read per row.

### Thread

The Thread screen (`mobile/session-active.html`):

- **The bar:** the back button with the Waiting on you count, the thread's face at 30 dp, the title, and "<project> · <pose words>".
- **The transcript,** live while the screen is open: `session:<id>:stream` from its cursor, plus the `:tap` token deltas for the words still streaming. An agent's message is signed with the thread's face and title, and the time. A work stretch is a divider, "Worked for 2m 14s ›", with its summary; a tap opens it to one row per item.
- **The docked Request:** the oldest open Request, docked above the composer ([The docked Request](#the-docked-request)).
- **The composer** sends `session.input`. Its button is a send arrow. The thread composer has no voice input.

**Open:** the screen rebuilds every transcript block on each streamed token, off the main thread. Rebuilding only the changed block is handed to a ticket, to be done if long threads drop frames on the phone. *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

### Assistant

The Assistant screen (`mobile/assistant.html`):

- **The bar:** the back button, the assistant's face from `buildAssistantLook(assistant.id)`, its name and its state: answering, idle, or asleep. An assistant is asleep when its newest session exited and can be resumed, as after an idle unload, and idle when it has no session. The Memory button is drawn disabled; memory is not part of the app.
- **The messages** of the main Conversation (`conversation.queryMessages`), in position order, live by invalidate. The owner's messages are bubbles; the assistant's are signed with its face; a Notice is drawn with the failed face, its text and its time. Messages are plain text.
- **The live answer.** While the assistant writes, the app shows the text of its reply that no stored message holds yet, from the running turn's transcript, with a blinking caret, as the desktop does. `decideOpenReply` decides which text that is, so no text is drawn twice.
- **The docked Request.** An open Request of the assistant's current session is docked above the composer, as on the Thread screen. An assistant's Request that an alert cannot answer (several questions, `multiSelect`, `secret`) opens this screen, so it needs the dock.
- **The composer** sends `conversation.send`. While it is empty, it shows the hold-to-talk mic ([Hold-to-talk](#hold-to-talk)).
- A reminder card's Edit button is drawn disabled. The wire has no reminders yet, so only a fixture fills one.

### You

The You screen keeps the look of the book's `mobile/settings.html`, but holds only what the phone needs. The book's version lists the controller's settings, which the app does not edit.

- **Controller:** the user name and the controller's address; Connection, with a dot and its state ("Connected" in green, "Connecting…", "Reconnecting…", "Sign in again", "Not connected"); Sign out, in the failure colour.
- **On this phone:**
  - "Show Live Updates", on a Samsung phone only: One UI shows a Live Update on the lock screen and in the Now Bar only after the user turns on Settings → Developer options → "Live notifications for all apps" ([One UI](#one-ui)).
  - "Keep alerts arriving": add Hercule to "Never auto sleeping apps" in the battery settings.
- **Font licences:** each bundled font's name and its full OFL text, which opens in place.

### The tab bar

The book's tab bar: Threads, Intake, the new-thread button, Office and You. Only Office and You have screens. Threads, Intake and the new-thread button are drawn faint and do nothing, so the bar keeps the book's shape without offering what the app cannot do. Threads carries a badge with the Waiting on you count when it is above zero. Intake has no badge, because the app reads no Intake data.

### Following new messages

The Thread and Assistant lists open on their newest message. A new message scrolls into view while the user is at the newest one, and always after the user sends. A user who has scrolled up to read is not moved. A reverse-layout `LazyColumn` keeps its first visible item in place when an item is added before it, which is why the list follows on purpose; `AssistantScrollTest` covers it.

### The docked Request

The docked Request answers every Request shape, on the Thread and the Assistant screens:

- **An approval** offers one row per decision it accepts, in its order: **Allow**, **Allow always**, **Deny**, **Cancel**. Allow is the accent row. Each row's fine print says what it does, in the words of the contract's `describeApprovalAnswer`, such as "Runs `git push` this once; the agent asks again next time." A tap gives a confirming haptic for an allow and a rejecting one for a deny or a cancel (`HapticFeedbackType.Confirm`, `Reject`), then calls `session.respondToApprovalRequest`.
- **A question** shows each question with its options, `multiSelect` where asked, and a field for the user's own answer, masked when the question is `secret`. Send answers is enabled once every question has an answer, and calls `session.respondToQuestion`.
- **Its title** names the command, the file or the tool as code: "Run `git push`?", "Change `src/a.ts`?". A question reads "The agent needs answers."
- **A Request of a kind the app does not know** is shown with no answers, and a line saying it can be answered on the desktop or in the web app.
- Once answered, the dock stops taking taps. A failed answer makes it answerable again, and the question's draft is still there.
- The dock takes at most a share of the height below the bar and scrolls beyond it, so a tall Request never pushes the composer off screen. The composer covers the dock's last 14 dp, as the book's `margin-bottom: -14px` does.

**The first approval decision is labelled "Allow"** everywhere on the phone: alert buttons, Live Update buttons, the docked Request and the Office's ask card. That is the contract's shared label, which the desktop shows. The book and the prototype say "Allow once"; the landing ticket changes the code.

### Hold-to-talk

The Assistant composer's mic turns speech into a message.

- It uses only the device's on-device recognizer (`SpeechRecognizer.createOnDeviceSpeechRecognizer`). The user's voice is never sent to a recognition service off the device. When the device has no on-device recognition, no mic shows.
- Pressing the mic listens; letting go stops, and the recognised words are sent with `conversation.send`. The mic turns marigold while it listens.
- The first press asks for `RECORD_AUDIO` and does not listen. Once it is granted, a press listens.
- A failed recognition shows a sentence: nothing was heard; the microphone is not allowed; or the words could not be recognised.
- TalkBack cannot hold a button. With TalkBack on, a double tap starts listening and a second double tap stops, through a custom accessibility action.

## Alerts

An **Alert** is an Android notification the app posts about one destination: a Thread or an Assistant. The app decides its alerts itself, from the live lists, as the desktop decides its native notifications ([./17-desktop-app.md](./17-desktop-app.md#native-behaviour)). It never reads or routes the controller's Notifications ([ADR 0042](../adr/0042-the-phone-app-is-a-native-android-client-of-the-public-api.md)).

### What alerts

- A new open Request (approval or question) on a thread.
- A new open Request on an assistant's current session.
- A new message from an assistant in its main Conversation.

Nothing else alerts. Permission Requests, Signals and run sessions do not. Requests are the desktop's rule; assistant messages are the phone's own addition, because on the phone a message from an assistant is something the user reads away from the desk.

### One alert per destination

- An alert's key is `thread:<sessionId>` or `assistant:<assistantId>`. Each key is also the id of the destination's long-lived shortcut, and the alert is posted with the key as its tag. A destination has at most one alert.
- **A thread** alerts when its newest open Request was not open in the last list. The alert replaces any earlier one. Its heading is "<thread title> · Request", or "· Question" for a question, and its message is the question, ending "+N more waiting" when other Requests of the thread are open. N counts open Requests only. When the Request it shows closes, the alert is removed and no other takes its place, even if older Requests stay open; the dock pages through those.
- **An assistant's** messages and Requests share its one key, so each assistant is one conversation in the drawer. Its alert holds the assistant's last 6 messages, the owner's and the assistant's, and an open Request as the newest message. While a Request is open, the buttons are the Request's. When it closes, the alert is shown again silently, with Reply.
- When another Request of a destination opens or closes without alerting, its alert is shown again silently, so "+N more waiting" stays true. Showing an alert again never brings back an alert the user swiped away.
- A destination that leaves the lists loses its alert.
- Nothing alerts while its destination is on screen. Other destinations still alert while the app is open. An assistant's alert is removed while its Conversation is on screen.
- **The Followed Thread** has no alert of its own: its Live Update alerts once instead ([The Live Update](#the-live-update)). When the user opens another thread while the thread followed before still waits, that thread gets an alert, posted silently.

Unlike the desktop's notification, a thread's alert does not name the subagent that asks.

### When to alert

- **The alert memory is persisted** in DataStore: the open Request ids, the alerts shown, the position of each assistant's last message, and the Followed Thread. Android killing the process causes neither an alert storm nor an alert posted twice.
- **Only the first list after sign-in records without alerting.** Signing in clears the memory, so the first list records what is open and alerts for nothing. After an app start or a reconnect, the app compares against the memory it persisted. A Request that opened while the process was dead or the socket was down still alerts once, and nothing alerts twice. This differs from the desktop, which shows nothing at launch: the phone's process dies and its socket drops often, and a Request that opens during a gap must still reach the user.
- Assistant messages are compared by position, not id.
- **Decisions are sampled every 250 ms,** not debounced, so a streaming thread never holds back another thread's alert. A snapshot is skipped while any list is half-read.
- An alert is removed when its Request is answered anywhere: on the phone, the desktop, the web app or the CLI ([ADR 0027](../adr/0027-a-decision-resolves-when-its-question-is-answered-wherever.md)). It is removed at the next list.
- Signing out removes every alert, the Live Update and every shortcut.

### Answering from an alert

An alert's buttons are decided per Request:

- **An approval** shows **Allow** (`allow`) and **Deny** (`deny`), each only when the Request accepts it. When it accepts neither, the alert shows **Open**. Its other decisions (`allow_always`, `cancel`) are offered in the app only.
- **A question** shows its options as buttons when the Request holds exactly one question, without `multiSelect` or `secret`, and with one to three options. A tap answers `{ <header>: [<label>] }`. Any other question, and any Request of an unknown kind, shows **Open**, which opens the Thread or the Assistant, where the docked Request answers every shape.
- **An assistant's alert with no open Request** shows **Reply**, a `RemoteInput` that sends `conversation.send`. Android asks for an unlock before a reply. One UI adds its smart replies, which stay on.

Every button is a broadcast to `AlertActionReceiver`, never an activity, so Allow, Deny and option buttons work while the phone is locked. The receiver:

- calls `goAsync()` so the call can finish, with a 9-second limit;
- calls the controller over plain HTTP with the stored credentials, so it works in a process Android started only for the tap, without the service;
- gives a haptic: `EFFECT_CLICK` for Allow and options, `EFFECT_DOUBLE_CLICK` for Deny, none for Reply;
- on success, removes a thread's alert and a replied assistant alert. An assistant's Request alert and the Live Update stay until the next list posts them again with what is open then;
- on `invalid_state`, which means the Request was answered elsewhere, removes the alert;
- on any other failure, replaces the alert with one that says what failed and why: "<button> failed: <reason>". On the Live Update, only the text changes, so it stays the thread's one notification. A blank reply fails with "the reply was empty"; a tap after sign-out fails with "you are signed out of the controller".

The receiver does nothing to a notification that shows another Request by the time the call returns: the outcome is about the tapped Request, not the newer one.

### Channels and grouping

| Channel | Importance | What it carries |
|---|---|---|
| Waiting on you | High | Thread alerts, assistant alerts with an open Request, app alerts |
| Messages | High | Assistant alerts with messages only |
| Working now | Default | The Live Update. It sounds once when a Request opens, without popping up |
| Connection | Min, silent, no badge | `ControllerWatchService`'s ongoing notification |

Each kind has its own `setGroup` key: thread alerts, assistant alerts and the Live Update. Without one, Android bundles the app's notifications into one collapsed card.

### Conversation notifications

Every alert is a conversation notification, because only a conversation notification draws the colleague's face on the left with the app as a badge, as the book does:

- `MessagingStyle`, with the user as "You";
- a `Person` named for the thread's heading or the assistant's name, with the face as an adaptive icon, marked important;
- a long-lived dynamic shortcut whose id is the key, with a `LocusId`, published before the alert.

A thread's shortcut is removed when its alert is removed, so the share sheet and the launcher do not fill up with old threads; Android allows about 15. An assistant's shortcut stays, because the assistant is a lasting conversation. A thread alert is public on the lock screen; an assistant alert is private, because it holds the user's messages.

### App alerts

An alert about the app itself opens the app when tapped. It is posted on the "Waiting on you" channel with notification id 10, because the user has to act on it. There are three:

- "You were signed out: the controller no longer accepts this phone's API key. Open the app to sign in again."
- "Hercule could not connect in the background. Open the app to connect."
- "Hercule could not read this phone's sign-in just now. Open the app to try again."

### One UI

These are facts about One UI 8.5 on the target phone ([platform research §5](../research/android/platform.md#5-one-ui-behaviour)). They are phone settings; the app cannot change them.

- **Ordinary notifications show only as icons on the lock screen** by default. Request and assistant alerts appear in full in the notification list the user opens from the lock screen. The user changes this in Settings → Lock screen and AOD → Notifications.
- **The Live Update shows as a full card on the lock screen itself,** with its segments, its face and its buttons, and as a pill in the Now Bar. One UI does this for a sideloaded app only with Settings → Developer options → "Live notifications for all apps" on. Without it, the Live Update is an ordinary notification in the drawer. The app says so once, on the You screen.
- One UI adds smart replies to a `MessagingStyle` notification with a `RemoteInput`. They stay on.

**Open:** the Live Update's status bar chip was not checked on the phone. Checking it is handed to a ticket. *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

## The Live Update

A **Live Update** is Android's promoted ongoing notification. The app posts at most one, for the **Followed Thread**. Google meant Live Updates for ongoing work the user started, and the book's lock screen shows one Live Activity beside ordinary notifications.

**Which thread.** The Followed Thread is the thread on screen, or else the thread followed before. It stays followed while it works or waits on the user (open Requests, or status Queued, Starting or Busy), or while it is on screen. It stops being followed when it goes idle or ends off screen, or when the user opens another thread. Its Live Update shows only while it works or waits, also while it is on screen.

**Segments.**

- The done steps of the thread's own agent's current turn, counting every item kind except agent messages and reasoning. A subagent's steps do not count. The current turn is the one the latest `turn.started` began.
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

**Text.** While waiting: "Waiting on you · <question>". While working: the latest step, such as the command's first line, "Edit <file>", "Read <file>", "Search <pattern>", "Search the web", the tool's name or the subagent's description; "Working" when there is none.

**Buttons:** the same as a Request alert ([Answering from an alert](#answering-from-an-alert)).

**Alerting.** The Followed Thread gets no separate Request alert, because there is one notification per destination. When a new Request opens and the thread is off screen, the Live Update is posted again to alert once. Otherwise it is silent.

**Promotion.** Android promotes a notification only when it is ongoing, has a content title, has no custom views, is not colourised, is not a group summary, and asks with `setRequestPromotedOngoing(true)`. Whether Android granted it shows as `FLAG_PROMOTED_ONGOING` in `activeNotifications`. The user can turn promotion off per app.

A Live Update equal to the one posted last is not posted again. At the first decision after the process starts, the app ends any Live Update left from before.

## Design

The app draws the book's phone pages (`docs/design/crew-bureau-2/mobile/office.html`, `session-active.html`, `assistant.html`, `settings.html` and `lock.html`). The bar is "Rogier cannot tell them apart at arm's length", not identical pixels: text renders differently on Compose and in a browser.

### Where the book and Android differ

The book draws an iPhone, and some of it is not Android's or not the wire's. These translations are accepted:

| Book | Chosen |
|---|---|
| Live Activity with labels under the track ("Read / Edited 3 / 24 passed") | Segments only; a Live Update draws no labels |
| Glass cards, wallpaper and the crew on the hill on the lock screen | Out of scope; the system draws the lock screen |
| The colleague's face on the left of a Request alert | A conversation notification: `MessagingStyle`, a `Person` and a long-lived shortcut per waiting thread |
| Status bar and home indicator in the frame | Not drawn; the test frame adds the insets |
| Wing note "8 of 8 · at cap" on one line beside the runner's name | The note on its own line under the name, from `describeCapacity`; wings are about 15 dp taller |
| Rooms ordered build-box-1, studio-mac, build-box-2 | By name, as the desktop |
| Three approval choices | One row per decision the Request offers, up to four: Allow, Allow always, Deny, Cancel |
| "Allow once" on the first approval decision | "Allow", the contract's shared label |
| Hand-picked wing faces | Lane order: Waiting on you oldest first, then Working, then Idle |
| Request options with tool-specific words ("Always allow git push") | The generic decision words; the Request carries no such data |
| Diff chip "+48 -12", changed-files card, test line | Left out; the transcript carries no diff or test data |
| "Opus 5.5" in the byline | Time only; the wire carries no model display name |
| Mic in the thread composer | Send arrow |
| Thread back badge 9 | The Waiting on you count |
| "Milo" chip, thread chip and "Draft it for Marta" button in Ada's messages | Text only |
| "said out loud" mark, memory and heartbeat footer | Left out |
| Assistant faces from the book's `CAST` table | `buildAssistantLook`, as the desktop |
| Runs, the Paused lane and step descriptions on the Office | Left out ([Office](#office)) |

### Tokens

`scripts/gen-android-tokens.ts` (`pnpm gen:android-tokens`) reads `docs/design/crew-bureau-2/tokens.css` and writes `apps/android/app/src/main/kotlin/dev/hercule/android/theme/Tokens.kt`:

- one field per colour token, in two instances: the light theme Whitehaven and the dark theme Orient Express. The book's other three themes are left out;
- the four colours of each crew hue (`--who`, `--who-shade`, `--who-ink`, `--who-tint`) per theme, worked out in the script so the app does no oklch maths;
- the theme-independent scales: type sizes, weights, spacing, radii, durations, easings and hue angles.

Colours are in **Display P3**, not sRGB: the phone's screen is wide gamut, and several of the book's oklch colours lie outside sRGB. A colour outside P3 too is clamped per channel, and its Kotlin line says so.

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

- Every screen works at 200% font scale; text wraps or the screen scrolls, and nothing is cut off.
- Every tap target is at least 48 dp.
- Hold-to-talk has a TalkBack action ([Hold-to-talk](#hold-to-talk)).
- Screens draw inside the system insets in landscape as in portrait, including the camera cutout's side; `LandscapeScreenTest` covers it.

**Open:** UI text lives in Kotlin, not in Android string resources; only alerts use resources. Moving it touches every golden. Whether and when to move it is handed to a ticket. *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

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

**Open:** the service could drop the UI's caches once the app leaves the screen, then measure idle memory again. Whether that brings the 143 MB down is handed to a ticket. *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

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

**Open:** CI does not build the Gradle project. Adding the check above as a CI job, with the JDK and the Android SDK it needs, is handed to a ticket. *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

**Tests:**

- **JVM tests** on Robolectric (SDK 36, the phone's level), with no emulator: the alert rules, the Live Update, the credentials, the live connection against `mockwebserver3`, the `client-core` ports with their copied cases, the face vectors, and the screens' behaviour (`AssistantScrollTest`, `LandscapeScreenTest`).
- **Screenshot goldens** with Roborazzi, committed under `app/src/test/screenshots/`. Every screenshot test runs with `@GraphicsMode(NATIVE)`; without it, Robolectric draws neither the P3 colours nor the variable font axes.
- **Compare sheets** in `apps/android/screenshots/compare/`: the book page beside the app, for the Office, the Thread waiting on a Request and the Assistant, in light and dark, at 390×844 dp, the book's frame. The book side is rendered with `node docs/design/shared/shoot.mjs <page> <out.png> --w 390 --h 844 --scheme light|dark`. Every remaining difference is one of the accepted translations ([Where the book and Android differ](#where-the-book-and-android-differ)).
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

**Open:** release signing. The release APK is unsigned. Which key signs it, where that key is kept and how a build reaches it is handed to a ticket. *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

**Open:** how updates reach the phone. Today a new build is installed by hand with `adb`. Whether the controller serves the APK, the app checks for updates, or a store-like channel does it is handed to a ticket. *(Added 2026-10-13, [#630](https://github.com/theagenticage/hercule/issues/630).)*

## Landing the prototype

The landing ticket brings `apps/android` from `prototype/android` to `main`, with these changes to the prototype's code:

- Rename `ConnectionService` to `ControllerWatchService`.
- Label the first approval decision "Allow", not "Allow once", in the alert buttons, the Live Update, the docked Request, the Office's ask card, and the comments.
- Clear stored credentials only for `KeyPermanentlyInvalidatedException` and `AEADBadTagException`, as [Sign-in and the API Key](#sign-in-and-the-api-key) says. The prototype also clears them when the stored value is not valid base64 or is shorter than its IV.
- Update the alert rules' docstring, which still says a first list follows sign-in, app start or a reconnect; only the first list after sign-in records without alerting.

It also needs these changes outside `apps/android`, which the prototype made on its branch. Each is small and can go to `main` on its own:

- `packages/home/src/origin.ts`: `bracketIpv6`, used by `config.ts`, the controller's listening line and `scripts/controller-process.ts`, so an IPv6 bind address prints as a valid URL.
- `scripts/gen-android-tokens.ts` and its test, with the `gen:android-tokens` script.
- `apps/desktop/scripts/book-world.ts` and the `world:book` script.
- `apps/desktop/scripts/find-look-seeds.ts`: it also searches `buildAssistantLook`.
- `.gitignore`, `.oxfmtrc.json` and `eslint.config.js`: Gradle's outputs are ignored.

## Post-v1

The phone app is itself beyond what spec 01 obliges for v1. These are what later milestones add:

- **The other screens:** Intake, Decision, New thread, the Threads list, Runs and Triggers.
- **Memory and reminders** on the Assistant screen, once operations read them.
- **Voice in the thread composer.**
- **Presence-aware routing** ("desktop idle, send to phone"), which stays post-v1 in [./01-overview-and-scope.md](./01-overview-and-scope.md). It would make the phone a sink of the core's router (ADR 0012), not change how the phone decides its own alerts.
- **Another push path** if a later phone measures a real drain: connecting only on chosen Wi-Fi networks, a slower ping, UnifiedPush through a self-hosted ntfy, or FCM ([platform research §7.3](../research/android/platform.md#73-alternatives-if-the-battery-cost-is-too-high)).
- **Other phones and tablets,** and the themes beyond light and dark.
- **iOS.** Not prepared by anything here; its own decision.
- **A live wallpaper** of the crew, the book's lock screen idea.

## Sources

- [Android prototype: the assistant, threads, and lock screen notifications, native in Kotlin (#630)](https://github.com/theagenticage/hercule/issues/630), with its prototype on branch `prototype/android`
- [#630: the prototype report](https://github.com/theagenticage/hercule/issues/630#issuecomment-6143269197)
- [#630: the phone results, acceptance 5 and 7](https://github.com/theagenticage/hercule/issues/630#issuecomment-6144697779)
- [ADR 0042 - The phone app is a native Android client of the public API](../adr/0042-the-phone-app-is-a-native-android-client-of-the-public-api.md)
- Research: [wire.md](../research/android/wire.md), the HTTP API and the `/ws` socket as a native client reads them, with the crew face algorithm, the fonts and the tokens; [platform.md](../research/android/platform.md), the phone, the toolchain, One UI's behaviour, notification facts and the background connection; the notification probe's [source](../research/android/probe-source/) and [screenshots](../research/android/probe-screenshots/)
