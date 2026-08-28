# codex/files/fragmentation/run1

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md && printf '\\\\n--- core ---\\\\n' && sed -n '1,160p' mem)
FileChange(update topics/hydra-project.md)

**assistant:** I’m recording this in Hydra’s project memory so it persists for later conversations.
Noted in Hydra’s project memory: the runner initiates a single websocket connection to the controller.

## s1 flush
**tools:** (none)

**assistant:** DONE  
Nothing new to record; the websocket direction is already in `hydra-project`.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md\"")
FileChange(update topics/hydra-project.md)

**assistant:** I’ll record that durable Hydra architecture note in the existing project topic.
Recorded in `memory/topics/hydra-project.md`.

## s2 flush
**tools:** (none)

**assistant:** DONE — No new durable information; the local runner note is already recorded.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
