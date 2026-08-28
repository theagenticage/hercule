# codex/cli/cap-full/run2

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** Bash("/bin/zsh -lc 'hydra memory read hydra-project'")
Bash("/bin/zsh -lc 'hydra memory --help && hydra memory append --help && hydra memory write --help'")
Bash("/bin/zsh -lc \"hydra memory write hydra-project --content '# hydra-project\n> Hydra architecture decisions, repo facts,)
Bash("/bin/zsh -lc 'hydra memory read hydra-project'")

**assistant:** I’m updating the durable Hydra project memory with all three finalized decisions, then I’ll count the ADRs recorded there.
The memory currently has stale “undecided” entries for packaging and join tokens. I’m consolidating those sections so the final decisions replace the old state cleanly, while retaining the known ADR list.
6

## s1 flush
**tools:** (none)

**assistant:** DONE  
All durable updates were already recorded in `hydra-project`.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 3286 chars (was 11824); stub rejects 0; new topics none"}
