# claude/cli/cap-full/run1

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** Bash({"command":"hydra memory read hydra-project"})
Bash({"command":"cat <<'EOF' | hydra memory write hydra-project\n# hydra-project\n> Hydra architecture decisions, repo facts,)

**assistant:** The topic is already at its 12k cap with a decision log that's ballooned into dozens of near-duplicate repeated entries. I'll consolidate that log down to its unique decisions and fold in your three updates.Updates saved — Bun packaging, ADR 0018 merged, and single-use runner join tokens are all recorded (I also trimmed the decision log, which had ballooned with dozens of duplicate cycling entries, down to its unique decisions).

6 ADRs.

## s1 flush
**tools:** (none)

**assistant:** Everything from this conversation is already recorded in the hydra-project topic update above.

DONE — nothing further to record.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 2685 chars (was 11824); stub rejects 0; new topics none"}
