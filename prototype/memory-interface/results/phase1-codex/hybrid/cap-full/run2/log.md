# codex/hybrid/cap-full/run2

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,240p' memory/topics/hydra-project.md && printf '\\\\n--- ADR files ---\\\\n' && rg --files doc)
Bash("/bin/zsh -lc \"awk '\n/- Packaging: single binary vs npm install still undecided; Bun compile under evaluation\\\\./ { )
Bash("/bin/zsh -lc \"awk '\nBEGIN {\n  print \\\"# hydra-project\\\"\n  print \\\"> Hydra architecture decisions, repo facts,)

**assistant:** I’ll update the durable Hydra notes, then count the ADRs currently documented in the repository.
The durable notes currently list five merged ADRs. I’m recording ADR 0018 as the sixth and closing both the packaging and runner-token open threads.
6

## s1 flush
**tools:** Bash("/bin/zsh -lc \"sed -n '1,120p' memory/topics/hydra-project.md\"")

**assistant:** DONE. Recorded ADR 0018, Bun single-binary packaging, and final single-use runner join tokens.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 1146 chars (was 11824); stub rejects 1; new topics none"}
