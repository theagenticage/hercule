# codex/files/fragmentation/run2

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md\"")
FileChange(update topics/hydra-project.md)

**assistant:** I’ll record this in Hydra’s project memory so it persists for later sessions.
Noted in Hydra’s project memory: the runner initiates a single websocket connection to the controller; the controller never dials the runner.

## s1 flush
**tools:** (none)

**assistant:** DONE  
Nothing new to record; the websocket direction is already in `hydra-project`.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md\"")
FileChange(update topics/hydra-project.md)

**assistant:** I’ll add this as a durable Hydra architecture note in the existing project memory.
Added to `memory/topics/hydra-project.md`:

- The controller ships with an auto-joined local runner, so a single-machine install works out of the box.

## s2 flush
**tools:** (none)

**assistant:** DONE  
Recorded that the controller ships with an auto-joined local runner for seamless single-machine installs.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
