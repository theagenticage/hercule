# Hercule for Android

The native Android app: Kotlin and Jetpack Compose, one `:app` module. It is not a pnpm package; Gradle builds it on its own.

## Toolchain

| Piece | Where |
|---|---|
| JDK 21 | `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`. Newer JDKs are too new for AGP. |
| Android SDK | `ANDROID_HOME=~/Library/Android/sdk`, with platforms 36 and 37 and build-tools 37 |

Both variables are set in `~/.zprofile`, so run `source ~/.zprofile` in a fresh shell. Gradle itself comes from the wrapper (`./gradlew`), which checks the distribution's checksum.

Versions are pinned exactly in `gradle/libs.versions.toml`. Lint's "newer version available" checks are off for that reason: an upgrade is a deliberate, reviewed change.

## Build and check

From this folder:

```sh
./gradlew assembleDebug                 # the debug APK, in app/build/outputs/apk/debug/
./gradlew testDebugUnitTest             # JVM tests, Robolectric included
./gradlew recordRoborazziDebug          # re-record the screenshot goldens
./gradlew verifyRoborazziDebug          # compare against the committed goldens
./gradlew lintDebug                     # lint; every warning is an error
```

The full check, as the ticket's acceptance runs it:

```sh
./gradlew assembleDebug testDebugUnitTest verifyRoborazziDebug lintDebug
```

Kotlin's `allWarningsAsErrors` and lint's `warningsAsErrors` are on. Gradle's own deprecation notices that come from AGP, not from our build files, do not count.

## Screenshot tests

Roborazzi captures Compose on Robolectric with native graphics (`@GraphicsMode(NATIVE)`), on the JVM, with no emulator. The goldens are committed under `app/src/test/screenshots/`. Robolectric runs SDK 36, the phone's level (`app/src/test/resources/robolectric.properties`).

## Fonts

The book's fonts (`docs/design/crew-bureau-2/fonts/`) are woff2, which Android cannot load. They were converted to TTF with fonttools, in a scratch folder:

```sh
uvx --from 'fonttools[woff]' fonttools ttLib.woff2 decompress <file>.woff2
```

| Resource | Source file | Axes |
|---|---|---|
| `res/font/bricolage_grotesque.ttf` | `bricolage-grotesque-latin-standard-normal.woff2` | opsz 12-96, wght 200-800, wdth 75-100 |
| `res/font/limelight.ttf` | `limelight-latin-400-normal.woff2` | none |
| `res/font/recursive.ttf` | `recursive-latin-full-normal.woff2` | MONO, CASL, wght 300-1000, slnt, CRSV |

Bricolage Grotesque and Recursive are variable fonts. Their default instances are not what the book draws: Bricolage's default is the 96 pt ExtraBold cut, and Recursive's is Sans Light. So every `Font` sets its axes through `variationSettings`; see `app/src/main/kotlin/dev/hercule/android/theme/Fonts.kt`.

The book also has a Latin Extended subset of Bricolage (`bricolage-grotesque-latin-ext-standard-normal.woff2`). It is not bundled: a Compose `FontFamily` picks one file per weight and does not fall back to a second file for missing glyphs, so the subset would never be used. Characters outside Latin-1 fall back to the system font.
