# codex/files/cap-full/run1

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,240p' memory/topics/hydra-project.md && printf '\\\\n--- ADR files ---\\\\n' && rg --files doc)
FileChange(update topics/hydra-project.md)

**assistant:** I’ll update the durable Hydra memory, then count the ADR records currently present in the workspace.
I found five explicitly recorded merged ADRs in Hydra memory. I’m adding ADR 0018, locking Bun compilation, and marking single-use runner join tokens final.
6

## s1 flush
**tools:** (none)

**assistant:** DONE

Nothing new; all durable Hydra updates were already recorded.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 11901 chars (was 11824); stub rejects 0; new topics none"}
