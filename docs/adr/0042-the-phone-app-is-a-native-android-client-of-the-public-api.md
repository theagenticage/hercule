# 42. The phone app is a native Android client of the public API

Date: 2026-10-13

## Status

Accepted. Decided by [Android prototype: the assistant, threads, and lock screen notifications, native in Kotlin (#630)](https://github.com/theagenticage/hercule/issues/630), from its [prototype report](https://github.com/theagenticage/hercule/issues/630#issuecomment-6143269197) and its [phone results](https://github.com/theagenticage/hercule/issues/630#issuecomment-6144697779). Keeps [ADR 0017](./0017-the-web-app-is-a-static-pure-client-of-the-public-api.md) and [ADR 0037](./0037-the-desktop-app-is-its-own-electron-client-of-the-public-api.md): the phone app is an ordinary client of the public API, with no privileged path. Keeps [ADR 0012](./0012-notifications-are-core-routed-sinks-are-dumb.md): the phone is not a Notification sink.

## Context

The user's agents ask for decisions all day: an approval to run a command, a question with options, a message from an assistant. On a computer, the desktop app shows them (spec 17). Away from the computer, nothing does. An agent that waits on the user waits until the user is back at a desk, and a five-second answer turns into an hour of idle work.

The phone is where the user is when they are away. Rogier's phone is a Samsung Galaxy S23 Ultra on Android 16 QPR2 (SDK 36.1, One UI 8.5). The Crew Bureau book already draws the phone pages: the Office, a thread, an assistant and the lock screen (`docs/design/crew-bureau-2/mobile/`).

Three questions had to be answered.

**What the app is built with.** The app must:

- draw the book's pages closely enough that Rogier cannot tell them apart at arm's length, in Display P3 colour on a wide-gamut screen;
- post Android's own notification kinds: conversation notifications with the colleague's face on the left, a promoted Live Update on the lock screen, buttons that answer while the phone is locked;
- keep a connection open in the background at a cost the battery does not notice.

All three are native Android features. A webview reaches none of the notification kinds, and holds a page in memory where a service would do. A cross-platform toolkit (React Native, Flutter) reaches them only through native modules written in Kotlin anyway, adds a second runtime, and draws text and colour through its own engine. With one target phone, the cross-platform promise buys nothing.

**How alerts reach the phone.** Mainstream Android apps receive pushes through Firebase Cloud Messaging (FCM): Android keeps one shared connection to Google, and the app's server sends each push through Google. Hercule's controller is self-hosted on a LAN or tailnet (spec 13 §1). It has no sender for Google's push service. Adding one means a Firebase project, credentials in the controller, a controller change, and an encrypted payload so that Google cannot read what the agents ask. Self-hosted apps such as ntfy, Gotify, Home Assistant and Conversations solve this instead with one connection of their own, held by a foreground service ([platform research §7.2](../research/android/platform.md#72-how-common-this-approach-is)).

The open risk of that design was the battery. The prototype measured it on the phone: locked, unplugged and idle for 37.5 minutes, with one `/ws` socket and the `ping` RPC every 30 seconds, the app used 0.084 mAh. That is about 0.13 mAh an hour, 0.003% of the 5000 mAh battery an hour, and 0.26% of what the whole phone used in that time. The socket costs close to nothing.

**Who decides what alerts.** The controller's Notifications are Hercule's messages about itself, routed by the core to sinks (ADR 0012), and presence-aware routing to a phone is post-v1 (spec 01). The desktop app does not use them for its native notifications: it decides those itself from the live list of open Requests (spec 17 §Native behaviour). The phone needs the same thing the desktop needs.

## Decision

**The phone app is a native Android app written in Kotlin with Jetpack Compose, in the Gradle project `apps/android`. It is an ordinary client of the public API. It holds one `/ws` socket in a foreground service, decides its own alerts from the live lists of sessions and Conversations, and uses no FCM and no controller change.**

- **Native Kotlin and Compose.** Compose draws the book's pages with the book's P3 tokens and fonts. The app posts Android's notification kinds through `NotificationCompat`. The stack, the SDK levels and the pinned versions are in spec 18 §Architecture.
- **Its own client, sharing no code.** The phone app links no package of the pnpm workspace: not `@hercule/contract` and not `@hercule/client-core`. It reads the HTTP API and the `/ws` socket as any client may, and decodes them with its own Kotlin types. The few `client-core` functions it needs are ported to Kotlin, each with the tests of its source copied case by case.
- **One socket in a foreground service.** `ControllerWatchService`, a `specialUse` foreground service, holds the one `/ws` socket while the user is signed in, decides which Requests and messages alert, and posts the alerts. The `ping` RPC every 30 seconds is the only keepalive. The service starts at sign-in, after boot and after an app update.
- **The phone decides its alerts, as the desktop does.** An alert follows live state: an open Request on a Thread or on an assistant's session, or a new message in an assistant's main Conversation. It is removed when nothing it shows waits any more. The phone never reads or routes the controller's Notifications, so it is not a sink in ADR 0012's sense, and presence-aware routing stays post-v1 as spec 01 says.
- **Signing in follows the CLI.** `auth.login`, then `apiKey.create`, then the login token is dropped (spec 13 §4.3). The key is encrypted under an Android Keystore key.

## Considered options

- **A webview of the web app, or a wrapped PWA.** Rejected. A page cannot post conversation notifications, Live Updates or lock screen buttons. Web Push needs a secure context that the plain-HTTP LAN default does not give, and spec 01 rules it post-v1. The page would also look like the web app, not the book.
- **A cross-platform toolkit: React Native or Flutter.** Rejected. Every feature that matters here is an Android API reached through a Kotlin module, so the toolkit adds a runtime and a bridge without saving the Kotlin. React Native would let the app share `client-core`'s TypeScript, which is the strongest argument for it. With one Android target and about a dozen small ports, copied tests are cheaper than the bridge.
- **Kotlin Multiplatform with an iOS app later.** Rejected for now. There is no iOS device to build for, and the shared layer would be designed for a second consumer that does not exist (AGENTS.md: an abstraction earns its place with its second consumer).
- **FCM.** Rejected. It needs a Firebase project, a sender in the controller and an encrypted payload, puts Google in the path of every alert, and solves a battery problem that the measurement shows does not exist. It stays the fallback if a later phone measures a real drain ([platform research §7.3](../research/android/platform.md#73-alternatives-if-the-battery-cost-is-too-high)).
- **UnifiedPush through a self-hosted ntfy.** Rejected for the same reason: it needs a controller change and a second app on the phone, to save battery the socket does not spend.
- **The controller's Notifications as the alert source.** Rejected. A Notification is Hercule's message about itself, and a thread's open Request is not one. The desktop already derives its alerts from live Request state; the phone doing the same keeps one rule for both apps.

## Consequences

- **Ported logic can drift.** The phone shares no code with `client-core`, so the functions it ports, such as `listWaiting`, `formatRequestQuestion`, `decideThreadPose`, `describeCapacity` and `decideOpenReply`, exist twice. Spec 18 lists them all. Each Kotlin port names its source file in its docstring and carries its source's test cases, copied case by case. A change to a ported `client-core` function changes its Kotlin port and the copied tests in the same pull request.
- **A second design-system implementation.** Crew Bureau now has a React implementation in the desktop renderer and a Compose one on the phone. Colours cannot drift, because a script generates the Kotlin tokens from `tokens.css` and a test fails when they are stale. Components and the faces can drift, and only the compare sheets and the face vectors catch that.
- **Android only.** There is no iOS app, and nothing here prepares one. An iOS app would be its own decision.
- **Kotlin in a TypeScript monorepo.** `apps/android` is a Gradle project outside the pnpm workspace, with its own check command (spec 18 §Testing). `pnpm typecheck`, `pnpm lint` and `pnpm test` do not reach it, and CI does not build it yet.
- **An always-visible notification.** The foreground service shows an ongoing notification on a silent channel, for as long as the user is signed in. Android requires it.
- **No controller change.** The phone uses operations the controller already has. A native app sends no `Origin`, so the controller's CORS allow-list stays as it is.
- The phone app has its own spec, [`docs/spec/18-android-app.md`](../spec/18-android-app.md), with its performance baseline.
