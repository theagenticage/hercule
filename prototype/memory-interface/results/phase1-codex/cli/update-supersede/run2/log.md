# codex/cli/update-supersede/run2

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash("/bin/zsh -lc 'rg --files docs/adr 2>/dev/null | sort'")
Bash("/bin/zsh -lc 'git log --all --oneline --decorate -- docs/adr'")
Bash("/bin/zsh -lc 'hydra memory read hydra-project'")
Bash("/bin/zsh -lc 'hydra memory write hydra-project --content $'\"'# hydra-project\\\\n> Hydra architecture decisions, repo )

**assistant:** I’ll update the durable Hydra project note with GitLab as canonical, then check the repository history for merged ADRs and reply with only their numbers.
0001, 0002, 0003, 0004, 0014

## s1 flush
**tools:** (none)

**assistant:** DONE  
Nothing new; the GitLab repo move is already recorded in memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
