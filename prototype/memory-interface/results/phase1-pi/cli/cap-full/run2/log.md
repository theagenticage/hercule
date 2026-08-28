# pi/cli/cap-full/run2

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"date +%Y-%m-%d"})
bash({"command":"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open )

**assistant:** That topic has bloated badly (the decision log grew dozens of duplicate entries), so I'll consolidate it while recording your three updates. Let me grab today's date first.All three updates are recorded in `hydra-project`. I also deduplicated the decision log, which had ballooned to ~80 near-identical entries; the topic is back down to 2.2k/12k chars.

6

## s1 flush
**tools:** bash({"command":"hydra memory append hydra-project <<'EOF'\n\nMaintenance note: decision log entries are one line per unique )

**assistant:** DONE
Recorded a maintenance note in `hydra-project` to replace rather than append decision-log entries (the three Hydra updates themselves were already saved earlier this session).

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 2391 chars (was 11824); stub rejects 0; new topics none"}
