# codex/hybrid/update-supersede/run1

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash("/bin/zsh -lc \"pwd && rg --files -g 'docs/adr/**' -g 'memory/**' -g 'AGENTS.md' -g 'docs/agents/**' | sort && hydra mem)
Bash("/bin/zsh -lc 'find . -maxdepth 3 -type f -print | sort && git status --short && git log --oneline --all -- docs/adr 2>/)
Bash("/bin/zsh -lc \"sed -n '1,240p' AGENTS.md && sed -n '1,240p' memory/topics/hydra-project.md && sed -n '1,160p' memory/IN)
Bash("/bin/zsh -lc \"hydra memory write hydra-project --content '# hydra-project\n> Hydra architecture decisions, repo facts,)

**assistant:** I’ll update the durable repo-location note, then check the ADR history and return only the merged ADR numbers.
0001  
0002  
0003  
0004  
0014

## s1 flush
**tools:** (none)

**assistant:** DONE  
Recorded that Hydra moved to `gitlab.com/rogier/hydra` and GitHub is now a read-only mirror.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror"}
