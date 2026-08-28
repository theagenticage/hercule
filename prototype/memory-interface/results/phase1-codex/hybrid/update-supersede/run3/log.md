# codex/hybrid/update-supersede/run3

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash("/bin/zsh -lc \"pwd && rg --files -g 'docs/adr/**' -g 'memory/**' -g 'docs/agents/**' | sort && printf '\\\\n--- hydra h)
Bash("/bin/zsh -lc \"ls -la && find . -maxdepth 4 -type f -print | sort | head -200 && printf '\\\\n--- memory ---\\\\n' && h)
Bash("/bin/zsh -lc 'hydra memory write hydra-project --content $'\"'# hydra-project\\\\n> Hydra architecture decisions, repo )

**assistant:** I’ll update the durable Hydra repo location, then check the ADR directory and report only the merged ADR numbers.
0001, 0002, 0003, 0004, 0014

## s1 flush
**tools:** (none)

**assistant:** DONE
Nothing new recorded.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
