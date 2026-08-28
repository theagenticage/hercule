# codex/cli/fragmentation/run2

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash("/bin/zsh -lc 'hydra memory read hydra-project'")
Bash("/bin/zsh -lc 'hydra memory append --help'")
Bash("/bin/zsh -lc 'hydra memory append hydra-project --content $'\"'- Runner-controller transport: the runner dials the cont)

**assistant:** I’ll record this in Hydra’s project memory.
Noted in `hydra-project` memory: the runner initiates a single websocket connection to the controller; the controller never dials the runner.

## s1 flush
**tools:** (none)

**assistant:** DONE  
Recorded Hydra’s single-websocket transport direction in `hydra-project` memory.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash("/bin/zsh -lc 'hydra memory read hydra-project'")
Bash("/bin/zsh -lc \"printf '%s\\\\n' '- Controller ships with an auto-joined local runner, so a single-machine install works)

**assistant:** I’ll add this to the Hydra project notes.
Noted in `hydra-project`: the controller ships with an auto-joined local runner, making single-machine installs work out of the box.

## s2 flush
**tools:** (none)

**assistant:** DONE — No additional durable information; the auto-joined local runner fact was already recorded in `hydra-project`.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
