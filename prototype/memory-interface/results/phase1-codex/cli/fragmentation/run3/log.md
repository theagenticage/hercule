# codex/cli/fragmentation/run3

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash("/bin/zsh -lc 'hydra memory read hydra-project'")
Bash("/bin/zsh -lc 'hydra memory append hydra-project --content $'\"'\\\\n- Runner transport: the runner initiates and mainta)

**assistant:** I’ll add this to Hydra’s project memory so it persists across sessions.
Noted in Hydra memory under `hydra-project`.

## s1 flush
**tools:** (none)

**assistant:** DONE  
Nothing new recorded; the websocket fact is already in `hydra-project`.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash("/bin/zsh -lc 'hydra memory read hydra-project && hydra memory --help'")
Bash("/bin/zsh -lc 'hydra memory append hydra-project --content $'\"'- Controller ships with an auto-joined local runner, so )

**assistant:** I’ll add this to the existing Hydra project note.
Noted in `hydra-project`: the controller auto-joins a local runner, making single-machine installs work out of the box.

## s2 flush
**tools:** (none)

**assistant:** DONE  
Recorded nothing new; the local runner fact was already saved in `hydra-project`.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
