# pi/files/update-supersede/run3

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"ls docs/adr/ 2>/dev/null && grep -ri \"status\" docs/adr/*.md 2>/dev/null | head -40"})
edit({"edits":[{"newText":"- Repo: gitlab.com/rogier/hydra (canonical, moved 2025-06); github.com/rogierpennink/hydra is a re)

**assistant:** Noted in memory: GitLab is now canonical, GitHub a read-only mirror.

ADRs merged so far: 0001, 0002, 0003, 0004, 0014.

## s1 flush
**tools:** (none)

**assistant:** DONE — the repo move (gitlab.com/rogier/hydra canonical, GitHub read-only mirror) was already recorded in `memory/topics/hydra-project.md` when you told me; nothing else durable came up.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror"}
