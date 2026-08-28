# codex/cli/update-supersede/run1

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash("/bin/zsh -lc \"hydra memory read hydra-project && printf '\\\\n--- files ---\\\\n' && rg --files -g 'docs/adr/**' -g 'A)
Bash("/bin/zsh -lc \"hydra memory write hydra-project --content \\\"# hydra-project\\\\n> Hydra architecture decisions, repo )
Bash("/bin/zsh -lc 'hydra memory read hydra-project'")
Bash("/bin/zsh -lc \"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, o)

**assistant:** I’ll update the durable repo-location note, then check the repository’s ADRs and report only the merged ADR numbers.
The repo checkout is a test workspace without the ADR files, so I’m using the maintained project-memory record for the merged list. I noticed the first memory update preserved literal `\n` characters; I’m correcting that formatting now.
0001  
0002  
0003  
0004  
0014

## s1 flush
**tools:** (none)

**assistant:** DONE  
Nothing new; the repo move and merged ADR list are already in memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
