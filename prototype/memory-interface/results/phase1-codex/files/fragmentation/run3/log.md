# codex/files/fragmentation/run3

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md && printf '\\\\n--- core ---\\\\n' && sed -n '1,120p' mem)
FileChange(update topics/hydra-project.md)

**assistant:** I’ll record this in Hydra’s project memory so it remains available in future sessions.
Noted in Hydra’s project memory: the runner initiates a single websocket connection to the controller.

## s1 flush
**tools:** (none)

**assistant:** DONE — Nothing new recorded; the websocket transport fact is already in `hydra-project`.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md && printf '\\\\n--- files ---\\\\n' && rg --files memory\)
FileChange(update topics/hydra-project.md)

**assistant:** I’ll add this as a durable Hydra architecture note in the existing project topic.
Noted in `hydra-project`: the controller includes an auto-joined local runner, making single-machine installs work out of the box.

## s2 flush
**tools:** (none)

**assistant:** DONE  
Recorded Hydra’s auto-joined local runner for single-machine installs.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
