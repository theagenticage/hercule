# Android platform facts for the Hercule Android prototype

This document collects what the Android prototype ticket relies on about Android, One UI and the build toolchain. Every claim is marked:

- **[Device]**: observed on Rogier's phone with the probe app.
- **[Built]**: verified by a build on Rogier's Mac.
- **[Docs]**: taken from the Android documentation and not tested here.

Date: 2026-10-13. Its companion is [`wire.md`](wire.md), which covers the controller's HTTP API, the live socket, the crew faces, fonts and tokens.

## 1. The target device

The prototype targets one phone. **[Device]**

| | |
|---|---|
| Phone | Samsung Galaxy S23 Ultra, `SM-S918B` (`dm3q`) |
| Android | 16 QPR2: `ro.build.version.sdk` 36, `sdk_full` 36.1 |
| One UI | 8.5 (`ro.build.version.oneui` 80500), build `BP4A.251205.006.S918BXXSAFZI1` |
| Launcher | Microsoft Launcher. The launcher draws only the home screen. The lock screen, the notification drawer and the Now Bar are drawn by One UI's System UI, so the launcher does not affect notifications. |
| Speech | On-device recognition is available, with en-US installed (`SpeechRecognizer.createOnDeviceSpeechRecognizer`, `checkRecognitionSupport`) |

## 2. Toolchain on Rogier's Mac

| Piece | Where |
|---|---|
| JDK 21 | Homebrew `openjdk@21`, `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`. Homebrew's default JDK (26) is too new for AGP. |
| Android SDK | `ANDROID_HOME=~/Library/Android/sdk`. Installed: platforms 36 and 37.0, build-tools 36.0.0 and 37.0.0, platform-tools, the emulator, and the system images `android-36;google_apis_playstore;arm64-v8a` and `android-36.1;google_apis_playstore;arm64-v8a` |
| Emulator | AVD `hercule-api36-1` (Pixel 8, Android 16 QPR2, SDK 36.1, the phone's level). Start it with `emulator -avd hercule-api36-1 -no-window -no-audio`. Stop it with `adb -s <serial> emu kill`. The probe's Live Update was promoted there (`promoted flag: true`). The older AVD `hercule-api36` (SDK 36.0) cannot request promotion, so do not use it. |
| Google's `android` CLI | Lives in `cmdline-tools/latest/bin`. Use `android sdk install <package>`, because `sdkmanager` is deprecated and package names now use slashes: `platforms/android-37.0`. Pass `--no-metrics` to every command. |

The variables are set in `~/.zprofile`.

### Verified version set **[Built]**

The probe app built with this set. It is the set the ticket pins.

| | Version |
|---|---|
| Gradle (wrapper) | 9.8.1, `distributionSha256Sum=dce76f55f8e251a3a1f130eb120f30b3d271de2b76c9b0729d316b5a1b6dc01f` |
| Android Gradle Plugin | 9.4.0 |
| Kotlin | 2.4.21 |
| Compose BOM | 2026.09.00 (Compose 1.12) |
| androidx.core | 1.19.1 |
| compileSdk | **37**. With 36, `checkDebugAarMetadata` fails: Compose 1.12 requires compileSdk 37. |

Two gotchas:

- **The wrapper checksum.** Changing `distributionUrl` without updating `distributionSha256Sum` fails with "Verification of Gradle distribution failed". Take the checksum from `https://services.gradle.org/distributions/gradle-<v>-bin.zip.sha256`.
- **compileSdk is not targetSdk.** compileSdk 37 only makes the new APIs available. The app keeps `targetSdk 36`, because targeting 37 turns on Android 17's local-network rules, and their effect on a Tailscale address is untested.

## 3. Installing on the phone

1. Turn on Developer options: Settings → About phone → Software information → tap Build number 7 times.
2. Turn off Auto Blocker (Settings → Security and privacy → Auto Blocker). Auto Blocker refuses installs over adb.
3. Turn on Developer options → Wireless debugging. Pair once with `adb pair <ip:port>` and the 6-digit code, then run `adb connect <ip:port>`. The connect port is not the pairing port.
4. adb usually lists the phone twice: once by IP and port, once by an mDNS name (`adb-<serial>-…._adb-tls-connect._tcp`). With two entries, a plain `adb install` fails with "more than one device/emulator", so always pass `-s <ip:port>`. **[Device]**
5. Install with `adb -s <ip:port> install -r <apk>`.

The phone reaches a controller on the Mac at `http://127.0.0.1:<port>` after `adb -s <ip:port> reverse tcp:<port> tcp:<port>`. The emulator reaches the Mac at `http://10.0.2.2:<port>`.

## 4. Probe results

The probe app was a throwaway app that posted the three kinds of notification the prototype needs. Its source is in [`probe-source/`](probe-source/). For each test, Rogier tapped a button, locked the phone, and waited 10 seconds. The probe logged every action with a `[locked]` or `[unlocked]` flag read from `KeyguardManager`.

| Test | Result | Screenshot |
|---|---|---|
| **Live Update** (`ProgressStyle`, `setRequestPromotedOngoing`, `setShortCriticalText`, two actions) | Android granted `FLAG_PROMOTED_ONGOING`. With the developer toggle on (see 5.1), the lock screen drew it as a full card: four segments, the face as the progress tracker, Allow once and Deny. The Now Bar showed a pill with the title and "Push?". **Allow once ran while locked.** | `1-lock-screen-live-update.png`, `2-now-bar.png` |
| Live Update, developer toggle off | Neither the lock screen card nor the Now Bar appeared. The notification appeared only in the notification drawer, still with its segments and both actions. | `8-live-update-without-dev-toggle.png` |
| **Approval** (high importance, face as large icon, two broadcast actions) | **Allow once ran while locked.** The face sits small on the right, with the app icon on the left. The book puts the face on the left with the app as a badge (see 6.2). | `3-approval-collapsed.png`, `4-approval-expanded.png` |
| **Message from Ada** (`MessagingStyle`, a `Person` with an adaptive icon, a long-lived shortcut, `RemoteInput`) | Rendered as a conversation, with Ada's face on the left and the app as a badge, as in the book. One UI added two smart replies ("Okay", "Got it, thanks"). Reply asked for an unlock first; the typed text then arrived in the receiver. | `5-ada-collapsed.png`, `6-ada-expanded.png`, `7-ada-reply-field.png` |
| **On-device speech** | Available, with en-US installed. | |

The probe reported "promoted flag: false" on the phone, and that report was wrong. It read the flag from the `Notification` object it had built, but the system sets `FLAG_PROMOTED_ONGOING` only on its own posted copy. `dumpsys notification` showed `flags=ONGOING_EVENT|PROMOTED_ONGOING`. The fixed probe reads `NotificationManager.activeNotifications` instead; the app must do the same whenever it checks the flag. **[Device]**

## 5. One UI behaviour

### 5.1 The Now Bar and lock screen cards need a developer toggle

On One UI 8.5, Android promotes the Live Update, but One UI draws it on the lock screen and in the Now Bar only when one of these is true:

- the app is on Samsung's own list of apps allowed in the Now Bar;
- Developer options → **"Live notifications for all apps"** is on. This is the setting `secure enable_notification_nowbar_test`.

**[Device]**: Rogier tested both states of the toggle.

A sideloaded app cannot join Samsung's list. On Rogier's phone, the toggle stays on. The app must:

- build its Live Updates to Android's standard, so they work unchanged if Samsung opens the Now Bar to all apps or the phone changes;
- tell the user, once, in its settings or connection screen, that One UI needs that developer toggle to show Live Updates on the lock screen. The system never says this itself, and the app must not hide it.

### 5.2 Ordinary notifications appear only as icons on the lock screen

By default, One UI shows ordinary notifications on the lock screen only as icons. The full cards appear once the user pulls down the drawer. Live Updates are the exception and get a card. The user changes this in Settings → Lock screen and AOD → Notifications. It is a phone setting, and the app cannot change it. **[Device]**

### 5.3 Smart replies

One UI adds system smart replies to a `MessagingStyle` notification that has a `RemoteInput`. Tapping one sends its text through the same `RemoteInput`. `setAllowSystemGeneratedContextualActions(false)` turns them off. **[Device]**

### 5.4 Automatic grouping

Without an explicit `setGroup`, Android may bundle an app's notifications into one collapsed group. On the emulator, two were enough: the Live Update and the approval became one "2" bundle. Give each kind of notification its own group key. **[Device, emulator]**

### 5.5 Several Live Updates, the Now Bar and the status bar chip

Observed on 2026-10-14 with the app itself, not the probe, on One UI 8.5 (SDK 36.1), with "Live notifications for all apps" on:

- Android granted `FLAG_PROMOTED_ONGOING` to two of the app's Live Updates at the same time, both in the group `live-update`. An app is not limited to one promoted Live Update.
- The lock screen's Now Bar shows one pill for them. The user swipes between the two Live Updates, and a tap opens either.
- With the build that gives every waiting thread its own Live Update, two threads waited at once, and both Requests were approved from the lock screen through the Now Bar, one after the other.
- The status bar chip shows on the home screen: the short critical text with the thread's face, such as "Run?".

**[Device]**

## 6. Notification facts

### 6.1 Live Updates **[Docs]**

A Live Update is promoted only when all of these hold:

- it is `ongoing`;
- it has a content title;
- it has no custom views;
- it is not colorized;
- it is not a group summary;
- it requests promotion with `setRequestPromotedOngoing(true)`.

`ProgressStyle`, `FLAG_PROMOTED_ONGOING`, `setShortCriticalText` and `NotificationManager.canPostPromotedNotifications()` are in API 36. `setRequestPromotedOngoing` is only in 36.1: platform 37's `android.jar` has it and platform 36's does not. `NotificationCompat` and `NotificationManagerCompat` in androidx.core 1.19.1 wrap all four and check the version themselves, so an app with `minSdk 36` calls them without version branches and lint's `NewApi` check stays quiet. An SDK 36.0 device cannot request promotion, so Live Updates need a 36.1 device or emulator. The user can turn promotion off per app (`Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS`).

Google's guidance is that a Live Update is for ongoing work the user started, not for alerts or chat. A running thread waiting on its next step fits that. A one-off Request on a thread that is not otherwise tracked is an ordinary high-priority notification.

### 6.2 Conversation notifications **[Device, Docs]**

Android draws the sender's face on the left with the app as a badge only for a conversation notification. That needs all of these:

- `MessagingStyle`;
- a `Person` with an icon (an adaptive icon looked best);
- a long-lived dynamic shortcut, with `setShortcutId` and a `LocusIdCompat`, published before the notification.

Any other notification puts a large icon on the right. To match the book's "message from a colleague" look, a Request notification must therefore be a conversation notification from the thread's colleague, with one shortcut per thread that is waiting. Remove the shortcut once its Request is resolved, so the share sheet and the launcher do not fill up. Android allows about 15 dynamic shortcuts per app (`ShortcutManagerCompat.getMaxShortcutCountPerActivity`). Conversation notifications are also sorted into One UI's "Conversations" section at the top of the drawer.

### 6.3 Actions while locked **[Device]**

An action whose `PendingIntent` is a broadcast runs without unlocking, so Allow once and Deny worked while locked. A `RemoteInput` reply always asks for an unlock first; that is Android's rule, and no app can change it.

### 6.4 Haptics **[Docs]**

| Where | Allow | Deny |
|---|---|---|
| In Compose | `HapticFeedbackType.Confirm` | `HapticFeedbackType.Reject` |
| In a receiver | `VibrationEffect.createPredefined(EFFECT_CLICK)` | `EFFECT_DOUBLE_CLICK` |

## 7. The background connection

### 7.1 What the prototype does

A foreground service holds the one `/ws` connection while the user is signed in, and the app raises its own notifications. There is no Firebase and no controller change.

- **Service type: `specialUse`**, with a `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` that explains the use. `dataSync` would be limited to 6 hours in every 24, and `connectedDevice` requires a paired device. Play Store review would question `specialUse`, but this app is sideloaded. **[Docs]**
- **Battery.** Ask once for `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. Tell the user to add the app to Settings → Battery → Background usage limits → **Never auto sleeping apps**. One UI otherwise puts apps to sleep that have not been opened for a while. **[Docs]**
- **Restart.** Restart the service on `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`.

### 7.2 How common this approach is

Mainstream apps use Firebase Cloud Messaging (FCM). Android keeps one shared Google connection for every app on the phone, and a server sends pushes through Google.

Self-hosted and privacy-focused apps often hold their own connection in a foreground service, because they cannot or will not route through Google:

- **ntfy** uses it for its "instant delivery" mode;
- **Gotify** uses it, always;
- **Home Assistant Companion** uses it for its "persistent connection", which can be limited to the home Wi-Fi;
- **Conversations** (XMPP) uses it;
- **Signal**, in its build without Google Play services, uses it.

So the approach is well trodden for exactly this kind of app. Its cost is the always-visible notification on the "Connection" channel, plus some battery for keeping the socket alive.

The keepalive is the client's choice (wire doc B.8). The desktop's Effect client sends an RPC `Ping` every 5 seconds and the `ping` RPC every 30 seconds. Every ping wakes the phone's radio, so the phone should ping as rarely as still works.

Start with the `ping` RPC every 30 seconds as the only keepalive. A missed answer means the connection is dead. Bun closes a socket after 120 seconds with no traffic by default (not verified), so 30 seconds stays well inside that.

Then measure:

1. `adb shell dumpsys batterystats --reset`
2. Leave the phone idle for an hour.
3. `adb shell dumpsys batterystats dev.hercule.android`

### 7.3 Alternatives if the battery cost is too high

These are not in the prototype. If the measurement shows a real drain, consider them, roughly in order of effort:

1. **Connect only when it is useful.** Home Assistant lets the user limit the connection to chosen Wi-Fi networks or to when the screen is on. A setting like this costs no controller change.
2. **A slower keepalive.** If Bun's idle timeout allows it, ping every 60 to 90 seconds. Dead connections are then noticed later. If Bun's timeout is too short, raising it is a small controller change.
3. **UnifiedPush through a self-hosted ntfy.** The controller posts each alert to an ntfy topic. The ntfy app holds one connection for every app using it, and wakes Hercule with the message. This needs a controller change and the ntfy app on the phone.
4. **FCM.** This is the cheapest option for the battery. It needs a Firebase project, a sender in the controller, and an end-to-end encrypted payload, so that Google cannot read what the agents ask. Spec 01 rules routing notifications to a phone post-v1, and ADR 0012 says notifications are routed by the core to sinks. An FCM sink would fit that design.
