| scenario | files | hybrid | cli |
|---|---|---|---|
| recall-preference | 3/3 | 3/3 | 3/3 |
| recall-topic-body | 3/3 | 3/3 | 3/3 |
| record-unprompted | 3/3 | 3/3 | 3/3 |
| update-supersede | 3/3 | 3/3 | 3/3 |
| cap-full | 3/3 | 3/3 | 3/3 |
| rotation-distill | 3/3 | 3/3 | 3/3 |
| noise | 3/3 | 3/3 | 3/3 |
| fragmentation | 3/3 | 3/3 | 3/3 |

total cost $1.55

- PASS files recall-preference run3 : recorded at s1t1 in core
- PASS files recall-preference run2 : recorded at s1t1 in core
- PASS files recall-preference run1 : recorded at s1t1 in core
- PASS files recall-topic-body run1 : drilled via: read({"path":"memory/topics/discord-setup.md"})
- PASS files recall-topic-body run2 : drilled via: read({"path":"memory/topics/discord-setup.md"})
- PASS files recall-topic-body run3 : drilled via: read({"path":"memory/topics/discord-setup.md"})
- PASS files record-unprompted run2 : recorded at s1t1 in topics/hydra-project
- PASS files record-unprompted run1 : recorded at s1t1 in topics/rogier
- PASS files record-unprompted run3 : recorded at s1t1 in topics/rogier
- PASS files update-supersede run2 : recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror
- PASS files update-supersede run3 : recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror
- PASS files cap-full run1 : facts 3/3; hydra-project 2850 chars (was 11824); stub rejects 0; new topics none
- PASS files update-supersede run1 : recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror
- PASS files cap-full run2 : facts 3/3; hydra-project 2917 chars (was 11824); stub rejects 0; new topics none
- PASS files cap-full run3 : facts 3/3; hydra-project 3527 chars (was 11824); stub rejects 0; new topics none
- PASS files rotation-distill run1 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS files noise run1 : curated untouched, nothing journaled
- PASS files rotation-distill run2 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS files noise run2 : curated untouched, nothing journaled
- PASS files noise run3 : curated untouched, nothing journaled
- PASS files rotation-distill run3 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS files fragmentation run1 : both in hydra-project, no new topics
- PASS files fragmentation run2 : both in hydra-project, no new topics
- PASS files fragmentation run3 : both in hydra-project, no new topics
- PASS hybrid recall-preference run1 : recorded at s1t1 in core
- PASS hybrid recall-preference run2 : recorded at s1t1 in core
- PASS hybrid recall-topic-body run1 : drilled via: read({"path":"memory/topics/discord-setup.md"})
- PASS hybrid recall-topic-body run2 : drilled via: read({"path":"memory/topics/discord-setup.md"})
- PASS hybrid recall-topic-body run3 : drilled via: read({"path":"memory/topics/discord-setup.md"})
- PASS hybrid recall-preference run3 : recorded at s1t1 in core
- PASS hybrid record-unprompted run1 : recorded at s1t1 in topics/rogier
- PASS hybrid record-unprompted run3 : recorded at s1t1 in core
- PASS hybrid record-unprompted run2 : recorded at s1t1 in topics/hydra-project,topics/rogier
- PASS hybrid update-supersede run2 : recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror
- PASS hybrid update-supersede run1 : recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror
- PASS hybrid update-supersede run3 : recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror
- PASS hybrid cap-full run1 : facts 3/3; hydra-project 2962 chars (was 11824); stub rejects 0; new topics none
- PASS hybrid cap-full run2 : facts 3/3; hydra-project 2915 chars (was 11824); stub rejects 0; new topics none
- PASS hybrid cap-full run3 : facts 3/3; hydra-project 2946 chars (was 11824); stub rejects 0; new topics none
- PASS hybrid rotation-distill run1 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS hybrid noise run1 : curated untouched, nothing journaled
- PASS hybrid rotation-distill run3 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS hybrid noise run2 : curated untouched, nothing journaled
- PASS hybrid noise run3 : curated untouched, nothing journaled
- PASS hybrid rotation-distill run2 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS hybrid fragmentation run1 : both in hydra-project, no new topics
- PASS hybrid fragmentation run2 : both in hydra-project, no new topics
- PASS cli recall-preference run1 : recorded at s1t1 in core
- PASS hybrid fragmentation run3 : both in hydra-project, no new topics
- PASS cli recall-topic-body run1 : drilled via: bash({"command":"hydra memory read discord-setup"})
- PASS cli recall-preference run2 : recorded at s1t1 in core
- PASS cli recall-topic-body run2 : drilled via: bash({"command":"hydra memory read discord-setup"})
- PASS cli recall-topic-body run3 : drilled via: bash({"command":"hydra memory read discord-setup"})
- PASS cli recall-preference run3 : recorded at s1t1 in core
- PASS cli record-unprompted run1 : recorded at s1t1 in topics/rogier
- PASS cli record-unprompted run2 : recorded at s1t1 in core
- PASS cli update-supersede run1 : recorded at s1t1 in topics/hydra-project; old url removed
- PASS cli record-unprompted run3 : recorded at s1t1 in core
- PASS cli update-supersede run2 : recorded at s1t1 in topics/hydra-project; old url removed
- PASS cli cap-full run2 : facts 3/3; hydra-project 2391 chars (was 11824); stub rejects 0; new topics none
- PASS cli update-supersede run3 : recorded at s1t1 in topics/hydra-project; old url removed
- PASS cli cap-full run1 : facts 3/3; hydra-project 2834 chars (was 11824); stub rejects 0; new topics none
- PASS cli cap-full run3 : facts 3/3; hydra-project 2929 chars (was 11824); stub rejects 0; new topics none
- PASS cli rotation-distill run1 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS cli noise run1 : curated untouched, nothing journaled
- PASS cli noise run2 : curated untouched, nothing journaled
- PASS cli noise run3 : curated untouched, nothing journaled
- PASS cli rotation-distill run3 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS cli rotation-distill run2 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS cli fragmentation run1 : both in hydra-project, no new topics
- PASS cli fragmentation run2 : both in hydra-project, no new topics
- PASS cli fragmentation run3 : both in hydra-project, no new topics
