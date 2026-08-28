# codex/files/update-supersede/run3

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md && rg --files docs/adr 2>/dev/null | sort && git log --on)
FileChange(update topics/hydra-project.md)

**assistant:** I’ll update the Hydra project memory to reflect GitLab as canonical, then check the repository history for merged ADRs and return only their numbers.
0001, 0002, 0003, 0004, 0014

## s1 flush
**tools:** (none)

**assistant:** DONE — GitLab is canonical for Hydra; GitHub is a read-only mirror.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
