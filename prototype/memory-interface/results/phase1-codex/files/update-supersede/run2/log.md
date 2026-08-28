# codex/files/update-supersede/run2

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md && printf '\\\\n--- ADR files ---\\\\n' && rg --files doc)
Bash("/bin/zsh -lc \"find docs -maxdepth 3 -type f -print 2>/dev/null | sort; printf '\\\\n--- git status ---\\\\n'; git stat)
FileChange(update topics/hydra-project.md)

**assistant:** I’ll update the durable repo-location note, then check `docs/adr/` and reply with only the merged ADR numbers.
0001  
0002  
0003  
0004  
0014

## s1 flush
**tools:** (none)

**assistant:** DONE  
Recorded nothing; all durable details were already in memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
