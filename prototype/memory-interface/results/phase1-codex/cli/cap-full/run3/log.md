# codex/cli/cap-full/run3

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** Bash("/bin/zsh -lc 'hydra memory read hydra-project'")
Bash("/bin/zsh -lc 'hydra memory --help && hydra memory write --help'")
Bash("/bin/zsh -lc 'hydra memory read hydra-project | wc -c'")
Bash("/bin/zsh -lc \"hydra memory read hydra-project | awk '{if (\"'$0 == \"- 0014 assistants remember through distilled memo)
Bash("/bin/zsh -lc \"hydra memory read hydra-project | sed -n '1,24p'; hydra memory read hydra-project | awk '/## Decisions \)

**assistant:** I’ll update the durable Hydra project memory with all three final decisions, then count the ADRs currently recorded there.
The project memory currently lists five merged ADRs. I’m replacing the two stale “undecided” entries and adding ADR 0018, while keeping the memory document within its size limit.
6

## s1 flush
**tools:** (none)

**assistant:** DONE — Nothing new; all three Hydra decisions are already recorded in `hydra-project` memory.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 11884 chars (was 11824); stub rejects 0; new topics none"}
