| scenario | cli |
|---|---|
| recall-topic-body | 1/1 |
| record-unprompted | 1/1 |
| recall-preference | 1/1 |
| cap-full | 1/1 |
| noise | 1/1 |
| fragmentation | 1/1 |
| rotation-distill | 1/1 |
| update-supersede | 1/1 |

total cost $0.98

- PASS cli recall-topic-body run1 : drilled via: Bash({"command":"hydra memory read discord-setup"})
- PASS cli record-unprompted run1 : recorded at s1t1 in topics/hydra-project
- PASS cli recall-preference run1 : recorded at s1t1 in core
- PASS cli cap-full run1 : facts 3/3; hydra-project 2531 chars (was 11824); stub rejects 0; new topics none
- PASS cli noise run1 : curated untouched, nothing journaled
- PASS cli fragmentation run1 : both in hydra-project, no new topics
- PASS cli rotation-distill run1 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS cli update-supersede run1 : recorded at s1t1 in topics/hydra-project; old url removed
