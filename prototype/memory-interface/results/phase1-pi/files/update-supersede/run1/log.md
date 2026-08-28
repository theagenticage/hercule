# pi/files/update-supersede/run1

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"ls docs/adr/ 2>/dev/null; ls /Users/rogier/Dev/agentick/agentick-next/docs/adr/ 2>/dev/null; ls /Users/rogie)
bash({"command":"ls -d docs/adr 2>/dev/null && echo \"cwd has docs/adr\"; cd /Users/rogier/Dev/agentick/agentick-next 2>/dev/)
bash({"command":"cd /Users/rogier/Dev/agentick/agentick-next && git ls-tree --name-only main -- docs/adr | sed 's/^\\([0-9]*\)
bash({"command":"cd /Users/rogier/Dev/agentick/agentick-next && git branch -a && echo --- && for b in $(git for-each-ref --fo)
bash({"command":"cd /Users/rogier/Dev/agentick/agentick-next && git ls-tree -r --name-only main -- docs/adr | sed 's|docs/adr)
edit({"edits":[{"newText":"- Repo: gitlab.com/rogier/hydra (moved from GitHub; github.com/rogierpennink/hydra is now a read-o)
edit({"edits":[{"newText":"- Repo: gitlab.com/rogier/hydra (moved from GitHub; github.com/rogierpennink/hydra is now a read-o)
read({"path":"memory/topics/hydra-project.md"})
edit({"edits":[{"newText":"## Decisions\n- ADRs 0001-0019 merged to main.","oldText":"- ADRs 0001-0019 merged to main."},{"ne)

**assistant:** All 19 are on main (0001-0019). Updating my notes on the repo move now, plus the stale ADR list:Noted and recorded: repo is now gitlab.com/rogier/hydra, GitHub is a read-only mirror. One practical heads-up: the local `origin` in agentick-next still points at `https://github.com/rogierpennink/hydra.git`, so you'll want to `git remote set-url origin` to the GitLab URL (and push mirror from GitLab, not pull from the Mac).

Merged ADRs: **0001-0019** (all of them, confirmed on main).

My notes also listed 0018 as having settled the packaging question (single self-contained binary), so I dropped that from open threads while I was in there.

## s1 flush
**tools:** (none)

**assistant:** DONE - nothing new to write; the GitLab move and the 0001-0019 ADR list were already recorded in the hydra-project topic during the conversation.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror"}
