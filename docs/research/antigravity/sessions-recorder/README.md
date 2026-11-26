# The recorder of #1282

Scratch scripts that drove Google's `agy` 1.5.15 over ACP and wrote the recordings in `packages/acp/src/recordings/` (the ones added by #1282, PR #1298). Research code, kept for reproducing a recording; it is not part of Hercule and follows none of its code rules.

- `agy-session.ts`: starts `agy acp --process-per-session` with the environment and flags of the adapter (`SSH_CONNECTION`, `AGY_CLI_DISABLE_AUTO_UPDATE=true`, `--gemini-dir`, `--app-data-dir antigravity-acp`, a private `--log-file`), records every JSON-RPC message both ways as `{ t, direction, message }`.
- `login.ts`: signs a scratch Harness Home in (prints the link, waits for the code in `<home>.code`).
- `proxy.ts`: a CONNECT proxy that can cut the network mid-turn.
- `scenarios/*.ts`: one scenario per recording: `bun scenarios/<name>.ts <home> <outDir>`. Set `WORKROOT` to a folder outside `/tmp` and `TMPDIR` to a private folder: `agy` lets the agent write unasked into its temporary folder, so a workspace there measures the wrong thing.

Never run it without a Harness Home of its own, never against `~/.hercule`, and only with a Google account whose owner agreed.
