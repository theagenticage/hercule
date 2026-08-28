# hybrid/fragmentation/run3

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash({"command":"cat \"memory/topics/hydra-project.md\""})
Bash({"command":"hydra memory write hydra-project --content \"$(cat <<'EOF'\n# hydra-project\n> Hydra architecture decisions,)

**assistant:** Noted — merged into the existing controller/runner line in `hydra-project`.

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing new; the websocket detail was already merged into hydra-project during this conversation.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash({"command":"cat memory/topics/hydra-project.md"})
Bash({"command":"hydra memory append hydra-project --content \"- Controller ships with an auto-joined local runner, so a sing)

**assistant:** Noted.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing to record, the fact from this conversation was already saved to the `hydra-project` topic during the session.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
