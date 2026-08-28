# pi/hybrid/update-supersede/run1

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"ls ~/Dev 2>/dev/null; find ~/Dev -maxdepth 4 -type d -name adr -path '*hydra*' 2>/dev/null"})
bash({"command":"ls ~/Dev/agentick; find ~/Dev/agentick -type d -name adr 2>/dev/null | head; find ~ -maxdepth 3 -type d -nam)
bash({"command":"ls -la ~/Dev/agentick/agentick-next/docs/adr/; head -5 ~/Dev/agentick/agentick-next/docs/adr/*.md 2>/dev/nul)
bash({"command":"cd ~/Dev/agentick/agentick-next && git status --short docs/adr/ && git branch --show-current && git log --on)
bash({"command":"cd ~/Dev/agentick/agentick-next && git branch -a --list main master 2>/dev/null; git ls-tree --name-only mai)
bash({"command":"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open )

**assistant:** All 19 are on main. Let me update my memory with the repo move and the current ADR state.Noted the GitLab move in memory (and dropped the stale packaging thread, since ADR 0018 decided it).

Merged ADRs: 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010, 0011, 0012, 0013, 0014, 0015, 0016, 0017, 0018, 0019.

Heads-up: the local checkout in `~/Dev/agentick/agentick-next` still has `origin` pointing at the GitHub URL, so you'll want to repoint it at GitLab.

## s1 flush
**tools:** bash({"command":"hydra memory append hydra-project <<'EOF'\n- Local checkout agentick-next still has origin on the GitHub URL)

**assistant:** DONE

Recorded: repo move, full ADR merge list (0001-0019), and the stale packaging thread cleanup were already saved during the session; added one open thread: local checkout's origin still points at GitHub and needs repointing to GitLab.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror"}
