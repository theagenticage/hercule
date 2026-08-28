# pi/cli/update-supersede/run3

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"ls ~/Dev 2>/dev/null; ls ~/Dev/agentick 2>/dev/null"})
bash({"command":"ls ~/Dev/agentick/agentick-next/docs/adr/ 2>/dev/null && grep -l -i 'status.*merged\\|status.*accepted' ~/De)
bash({"command":"grep -H -i 'status' ~/Dev/agentick/agentick-next/docs/adr/*.md | head -40"})
bash({"command":"head -15 ~/Dev/agentick/agentick-next/docs/adr/0001-runs-freeze-an-execution-plan.md; echo ---; for f in ~/D)
bash({"command":"cd ~/Dev/agentick/agentick-next && git branch --show-current && git remote -v && for f in docs/adr/*.md; do )
bash({"command":"cd ~/Dev/agentick/agentick-next && git branch -a | head -10 && echo --- && for f in docs/adr/*.md; do n=$(ba)
bash({"command":"hydra memory write hydra-project << 'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open)

**assistant:** The memory topic was stale on ADRs (it listed only 5, but the repo has 19 files). Let me check what's actually merged on the main branch, then update memory with the repo move.All ADRs 0001-0019 are merged on main. Now updating memory with the repo move and the stale ADR list:Done. Two things:

**Merged ADRs (numbers only):** 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010, 0011, 0012, 0013, 0014, 0015, 0016, 0017, 0018, 0019 — all of them, verified against `main` in `~/Dev/agentick/agentick-next/docs/adr/`. My memory only knew about 5, so I fixed that too.

**Repo move:** recorded. Note that the local checkout's `origin` still points at `github.com/rogierpennink/hydra.git`. Since GitHub is now read-only, want me to switch the remote to `gitlab.com/rogier/hydra`? Takes one command, but I didn't want to touch your git config unasked — say the word.

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; the repo move, full ADR list, and the stale GitHub remote were all written to `hydra-project` earlier this conversation.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
