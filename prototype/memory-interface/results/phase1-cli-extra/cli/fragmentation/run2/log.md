# claude/cli/fragmentation/run2

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash({"command":"hydra memory read hydra-project"})
Edit({"replace_all":false,"file_path":"/dev/stdin","old_string":"placeholder","new_string":"placeholder"})
Bash({"command":"hydra memory write hydra-project --content \"$(cat <<'EOF'\n# hydra-project\n> Hydra architecture decisions,)

**assistant:** Noted: runner→controller is a single websocket, one direction only. Added that detail to the `hydra-project` memory topic.

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; the websocket direction fact was already saved to hydra-project during this session.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash({"command":"hydra memory read hydra-project"})
Bash({"command":"hydra memory write hydra-project --content \"$(cat <<'EOF'\n# hydra-project\n> Hydra architecture decisions,)

**assistant:** Noted — added to `hydra-project`: the controller ships with an auto-joined local runner, so single-machine installs work out of the box.

## s2 flush
**tools:** (none)

**assistant:** Already recorded this turn's content in `hydra-project`. Nothing else durable to add.

DONE — recorded that the controller ships with an auto-joined local runner (single-machine install works out of the box), already saved to the `hydra-project` topic.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
