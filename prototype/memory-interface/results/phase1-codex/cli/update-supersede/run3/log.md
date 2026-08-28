# codex/cli/update-supersede/run3

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash("/bin/zsh -lc \"pwd && hydra memory read hydra-project && printf '\\\\n--- ADR files ---\\\\n' && (rg --files docs/adr 2)
Bash("/bin/zsh -lc 'hydra memory write --help'")
Bash("/bin/zsh -lc \"hydra memory write hydra-project --content \\\"# hydra-project\\\\n> Hydra architecture decisions, repo )
Bash("/bin/zsh -lc \"hydra memory read hydra-project | sed -n '1,8p'\"")
Bash("/bin/zsh -lc \"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, o)

**assistant:** I’ll update the durable project note to reflect GitLab as canonical, then check the repository’s ADR history and report only the merged ADR numbers.
The memory update landed with escaped newline characters because of the CLI invocation format, so I’m correcting that stored topic before answering.
0001, 0002, 0003, 0004, 0014

## s1 flush
**tools:** (none)

**assistant:** DONE  
Nothing new recorded; the repo move and merged ADR list are already in `hydra-project`.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
