# pi/hybrid/update-supersede/run2

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"ls docs/adr/ 2>/dev/null || find . -maxdepth 4 -type d -name adr 2>/dev/null"})
bash({"command":"ls ~/Dev/agentick/agentick-next/docs/adr/ 2>/dev/null; ls ~/Dev 2>/dev/null | head -20"})
bash({"command":"cd ~/Dev/agentick/agentick-next && git status --short docs/adr/ && git log --oneline -3 -- docs/adr/ && git )
bash({"command":"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open )

**assistant:** All confirmed committed in the local repo, so here's the answer, then a memory update for the repo move.

**ADRs merged: 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010, 0011, 0012, 0013, 0014, 0015, 0016, 0017, 0018, 0019** (that's all nineteen, no gaps).

Now recording the repo move; I also noticed my notes were stale on two other points (ADR list was way behind, and ADR 0018 already settled the packaging question), so I'm fixing those in the same pass:Done. Notes updated with the GitLab move, the full ADR list, and I dropped the packaging open thread since ADR 0018 settled it (one self-contained binary, Bun compile).

One practical heads-up: the local clone in `agentick-next` still has `origin` pointed at `github.com/rogierpennink/hydra`. Since that's a mirror now, you'll want to repoint it:

```
git remote set-url origin https://gitlab.com/rogier/hydra.git
```

Want me to run that, or are you leaving the mirror in place on purpose for CI or something?

## s1 flush
**tools:** (none)

**assistant:** DONE - nothing new to record; everything durable (GitLab move, full ADR list 0001-0019, ADR 0018 resolving packaging, local remote still on GitHub) was already written to `hydra-project` during this session.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror"}
