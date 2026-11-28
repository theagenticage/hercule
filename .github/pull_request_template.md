## What and why

<!-- One or two sentences: what was wrong, and what you get now. Closes #<ticket> -->

## Checks

<!-- Keep every row. Write what ran and where, or "not run, because ...", or "n/a" when the change cannot affect it. -->

- `pnpm typecheck`:
- `pnpm lint`:
- `pnpm dep-lint`:
- `pnpm test` (or the files you ran):
- `pnpm build:binary` and `pnpm test:binary`:
- Desktop: `pnpm build:desktop` and `pnpm test:desktop` (or `:container`), on Linux or Mac:
- Desktop looks: `ui:metrics`, goldens, perf counts:
- Android: `./gradlew assembleDebug testDebugUnitTest verifyRoborazziDebug lintDebug`:

## Needs updating to see the change

Controller, runner, desktop app, Android app, or None:
