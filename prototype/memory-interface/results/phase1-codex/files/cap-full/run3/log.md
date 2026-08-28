# codex/files/cap-full/run3

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,240p' memory/topics/hydra-project.md && find docs/adr -maxdepth 1 -type f -print 2>/dev/null |)
Bash("/bin/zsh -lc 'wc -l memory/topics/hydra-project.md; rg -n \"''^(##|'\"\\\\- 0|\\\\- Packaging|\\\\- Runner join|ADR)\\\)
FileChange(update topics/hydra-project.md)
Bash("/bin/zsh -lc \"sed -n '9,28p' memory/topics/hydra-project.md\"")
FileChange(update topics/hydra-project.md)

**assistant:** I’m updating the durable Hydra notes and checking the repository’s ADR inventory so the final count reflects both the new decisions and the existing records.
The notes currently list five merged ADRs and still mark packaging and runner-token decisions as open. I’m correcting those stale entries and adding the two newly finalized decisions to the durable decision log.
6

## s1 flush
**tools:** (none)

**assistant:** DONE  
Nothing; all durable updates from this conversation are already in `hydra-project`.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 11890 chars (was 11824); stub rejects 0; new topics none"}
