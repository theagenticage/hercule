| scenario | cli |
|---|---|
| recall-preference | 2/2 |
| recall-topic-body | 2/2 |
| record-unprompted | 2/2 |
| update-supersede | 2/2 |
| cap-full | 2/2 |
| rotation-distill | 2/2 |
| noise | 2/2 |
| fragmentation | 2/2 |

total cost $2.27

- PASS cli recall-preference run2 : recorded at s1t1 in core
- PASS cli recall-preference run1 : recorded at s1t1 in core
- PASS cli recall-topic-body run1 : drilled via: Bash({"command":"hydra memory read discord-setup"})
- PASS cli recall-topic-body run2 : drilled via: Bash({"command":"hydra memory read discord-setup"})
- PASS cli record-unprompted run1 : recorded at s1t1 in topics/hydra-project
- PASS cli record-unprompted run2 : recorded at s1t1 in topics/hydra-project
- PASS cli update-supersede run1 : recorded at s1t1 in topics/hydra-project; old url removed
- PASS cli update-supersede run2 : recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror
- PASS cli cap-full run1 : facts 3/3; hydra-project 2685 chars (was 11824); stub rejects 0; new topics none
- PASS cli cap-full run2 : facts 3/3; hydra-project 2920 chars (was 11824); stub rejects 0; new topics none
- PASS cli rotation-distill run1 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS cli noise run1 : curated untouched, nothing journaled
- PASS cli rotation-distill run2 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS cli noise run2 : curated untouched, nothing journaled
- PASS cli fragmentation run1 : both in hydra-project, no new topics
- PASS cli fragmentation run2 : both in hydra-project, no new topics
