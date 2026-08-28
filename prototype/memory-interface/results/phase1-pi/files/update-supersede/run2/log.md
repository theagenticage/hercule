# pi/files/update-supersede/run2

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** bash({"command":"ls -la . memory memory/topics docs/adr 2>&1"})
read({"path":"memory/topics/hydra-project.md"})
edit({"edits":[{"newText":"- Repo: gitlab.com/rogier/hydra (moved from GitHub on 2024; github.com/rogierpennink/hydra is now )

**assistant:** Noted the repo move in memory (gitlab.com/rogier/hydra, GitHub now a read-only mirror).

Merged ADRs: 0001, 0002, 0003, 0004, 0014.

## s1 flush
**tools:** (none)

**assistant:** DONE — the repo move (gitlab.com/rogier/hydra, GitHub read-only mirror) was already recorded in `hydra-project` during the session; nothing further to add.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror"}
