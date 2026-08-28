# codex/files/update-supersede/run1

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash("/bin/zsh -lc \"pwd && sed -n '1,200p' memory/topics/hydra-project.md && printf '\\\\nADR files:\\\\n' && rg --files doc)
FileChange(update topics/hydra-project.md)

**assistant:** I’ll update Hydra’s memory with the GitLab canonical-repo change, then check the ADR files and report only the merged ADR numbers.
0001, 0002, 0003, 0004, 0014

## s1 flush
**tools:** (none)

**assistant:** DONE

Nothing new to record; the repo move is already in memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
