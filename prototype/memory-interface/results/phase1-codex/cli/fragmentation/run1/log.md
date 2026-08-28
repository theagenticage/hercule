# codex/cli/fragmentation/run1

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash("/bin/zsh -lc 'hydra memory read hydra-project'")
Bash("/bin/zsh -lc \"hydra memory append hydra-project --content '- Transport: the runner initiates a single websocket connec)

**assistant:** I’ll record this in Hydra’s project memory.
Noted in `hydra-project`: the runner initiates a single websocket connection to the controller; the controller never dials the runner.

## s1 flush
**tools:** (none)

**assistant:** DONE  
Recorded Hydra’s websocket direction: the runner dials the controller over a single websocket.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash("/bin/zsh -lc 'hydra memory read hydra-project'")
Bash("/bin/zsh -lc 'hydra memory append hydra-project --content $'\"'\\\\n- The controller ships with an auto-joined local ru)

**assistant:** I’ll add this durable Hydra architecture note to the existing `hydra-project` memory topic.
Noted in `hydra-project`: the controller ships with an auto-joined local runner, so single-machine installs work out of the box.

## s2 flush
**tools:** (none)

**assistant:** DONE  
Nothing new; the durable note was already recorded in `hydra-project`.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
