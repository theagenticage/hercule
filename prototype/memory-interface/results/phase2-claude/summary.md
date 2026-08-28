| scenario | hybrid |
|---|---|
| recall-preference | 3/3 |
| recall-topic-body | 3/3 |
| record-unprompted | 3/3 |
| update-supersede | 3/3 |
| cap-full | 3/3 |
| rotation-distill | 3/3 |
| noise | 3/3 |
| fragmentation | 3/3 |

total cost $4.56

- PASS hybrid recall-preference run2 : recorded at s1t1 in core
- PASS hybrid recall-preference run1 : recorded at s1t1 in core
- PASS hybrid recall-preference run3 : recorded at s1t1 in core
- PASS hybrid recall-topic-body run1 : drilled via: Bash({"command":"cat memory/topics/discord-setup.md 2>/dev/null || find / -path /proc -prune -o -name \"discord-setup.md\" -p) | Bash({"command":"hydra memory journal-unread"})
- PASS hybrid recall-topic-body run2 : drilled via: Bash({"command":"cat memory/topics/discord-setup.md 2>/dev/null || find / -path /proc -prune -o -name \"discord-setup.md\" -p) | Bash({"command":"hydra memory journal-unread"})
- PASS hybrid recall-topic-body run3 : drilled via: Read({"file_path":"/private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/scra) | Bash({"command":"hydra memory journal-unread"})
- PASS hybrid record-unprompted run1 : recorded at s1t1 in topics/hydra-project
- PASS hybrid record-unprompted run2 : recorded at s1t1 in topics/hydra-project
- PASS hybrid record-unprompted run3 : recorded at s1dream in topics/rogier
- PASS hybrid update-supersede run2 : recorded at s1t1 in topics/hydra-project; old url removed
- PASS hybrid cap-full run1 : facts 3/3; hydra-project 2681 chars (was 11824); stub rejects 0; new topics none
- PASS hybrid cap-full run2 : facts 3/3; hydra-project 9136 chars (was 11824); stub rejects 0; new topics none
- PASS hybrid update-supersede run1 : recorded at s1t1 in topics/hydra-project; old url removed
- PASS hybrid update-supersede run3 : recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror
- PASS hybrid cap-full run3 : facts 3/3; hydra-project 2476 chars (was 11824); stub rejects 0; new topics none
- PASS hybrid rotation-distill run1 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS hybrid rotation-distill run2 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS hybrid noise run1 : curated untouched, nothing journaled
- PASS hybrid noise run2 : curated untouched, nothing journaled
- PASS hybrid rotation-distill run3 : 3/3 recalled; in memory: token,jelle,dentist; at token@s1t1 jelle@s1t3 dentist@s1t5
- PASS hybrid noise run3 : curated untouched, nothing journaled
- PASS hybrid fragmentation run1 : both in hydra-project, no new topics
- PASS hybrid fragmentation run2 : both in hydra-project, no new topics
- PASS hybrid fragmentation run3 : both in hydra-project, no new topics
