# Check details

Details of the checks in `AGENTS.md` that an agent needs only in some pull requests, or only to understand why a rule is as it is. `AGENTS.md` says when each applies.

## CI shards

CI splits `pnpm test:node`, `pnpm test:react` and the desktop end-to-end suite into shards by each file's recorded run time (`scripts/test-shards.ts`). The times are kept in the Actions cache and updated after every run on `main`, so nobody refreshes them. A new file weighs the median until then. To run CI's second shard locally, put the run's `test-shard-weights` artifact at the repository root and run `pnpm test:react --shard=<x>/<y>`, with the `x/y` that the CI job shows in its name (for example `2/6`); without that file, `--shard` splits by file count.

## Android check

The Android app has a check of its own, which no `pnpm` command runs. CI runs it in a job of its own, `android`, on a macOS runner: the screenshot goldens are recorded on a Mac, and Linux rasterises vector shapes slightly differently. It needs JDK 21 (newer JDKs are too new for the Android Gradle plugin) and the Android SDK with platforms 36 and 37 and build-tools 37, located by `JAVA_HOME` and `ANDROID_HOME`; `apps/android/README.md` has the paths. Run it before a PR that changes `apps/android`:

```
cd apps/android && ./gradlew assembleDebug testDebugUnitTest verifyRoborazziDebug lintDebug
```

When `verifyRoborazziDebug` fails on a screen you meant to change, run `./gradlew recordRoborazziDebug`, then look at every golden that moved in the diff before committing it. Never run `./gradlew --stop`: it stops the Gradle daemons of every worktree on this machine.

## Why `typescript` stays on 6.0

`bun check` is TypeScript 7. The `typescript` package stays on 6.0, because typescript-eslint and `scripts/dep-lint.ts` need its JavaScript API, which TypeScript 7 does not have. 6.0 is the release built to behave like 7, so the editor and `bun check` should agree.

## Unused oxlint disable comments

oxlint does not report a comment that turns off one of its rules once the rule no longer fires, because its check for unused comments also reports every `eslint-disable` comment.
