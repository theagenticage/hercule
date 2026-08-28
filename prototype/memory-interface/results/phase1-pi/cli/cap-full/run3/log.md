# pi/cli/cap-full/run3

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"date +%F"})
bash({"command":"hydra memory write hydra-project << 'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open)

**assistant:** The hydra-project topic is at its cap and the decision log is full of cyclic duplicates, so I'm consolidating it while recording the three updates.All three updates are saved: Bun for the single binary and ADR 0018 recorded as merged, the packaging and join-token open threads closed, and the join-token single-use decision marked final. I also deduplicated the decision log, which had grown cyclical, bringing the topic from 11.8k down to 2.8k chars.

6

## s1 flush
**tools:** bash({"command":"hydra memory append hydra-project << 'EOF'\n- Log discipline: one line per decision, update in place; never )

**assistant:** DONE
All three Hydra updates were already recorded earlier this session; I only added one line on decision-log discipline (update in place, no revisit duplicates) to hydra-project.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 2929 chars (was 11824); stub rejects 0; new topics none"}
