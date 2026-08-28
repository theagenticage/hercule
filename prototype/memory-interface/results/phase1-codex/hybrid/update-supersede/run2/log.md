# codex/hybrid/update-supersede/run2

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash("/bin/zsh -lc \"pwd; printf '%s\\\\n' '--- hydra-project ---'; sed -n '1,200p' memory/topics/hydra-project.md; printf '%)
Bash("/bin/zsh -lc 'hydra memory write hydra-project --content $'\"'# hydra-project\\\\n> Hydra architecture decisions, repo )

**assistant:** I’ll update the durable project note with the GitLab canonical-repo change, then check the repository’s ADR history and report only the merged ADR numbers.
0001, 0002, 0003, 0004, 0014

## s1 flush
**tools:** (none)

**assistant:** DONE  
Recorded that GitLab is Hydra’s canonical repository and GitHub is a read-only mirror.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
