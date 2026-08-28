# codex/files/cap-full/run2

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,240p' memory/topics/hydra-project.md && printf '\\\\n--- files ---\\\\n' && rg --files docs/ad)
FileChange(update topics/hydra-project.md)
Bash("/bin/zsh -lc \"sed -n '1,42p' memory/topics/hydra-project.md\"")

**assistant:** I’ll update the durable Hydra notes with those three final decisions, then count the ADRs represented in the memory I have.
The Hydra topic currently records five merged ADRs and still marks packaging and join-token details as open. I’m replacing those stale entries and adding the two newly final decisions.
6

## s1 flush
**tools:** (none)

**assistant:** DONE  
Recorded Bun single-binary packaging, merged ADR 0018, and final single-use runner join tokens.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 11900 chars (was 11824); stub rejects 0; new topics none"}
