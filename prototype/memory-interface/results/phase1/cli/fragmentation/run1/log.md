# cli/fragmentation/run1

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash({"command":"hydra memory read hydra-project"})
Edit({"replace_all":false,"file_path":"/dev/stdin","old_string":"x","new_string":"y"})
Bash({"command":"hydra memory write hydra-project --content \"$(cat <<'EOF'\n# hydra-project\n> Hydra architecture decisions,)

**assistant:** Noted — updated the `hydra-project` memory to specify the runner-controller connection is a single websocket, one direction only (runner → controller).

## s1 flush
**tools:** (none)

**assistant:** Already recorded in the prior turn — nothing further to add.

DONE — no new durable info; the websocket detail was already written to `hydra-project` memory.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash({"command":"hydra memory read hydra-project"})
Bash({"command":"hydra memory write hydra-project --content \"$(cat <<'EOF'\n# hydra-project\n> Hydra architecture decisions,)

**assistant:** Noted: controller ships with an auto-joined local runner, so single-machine installs just work. Added to `hydra-project` memory.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; the only durable fact from this session (auto-joined local runner) was already written to `hydra-project` memory during the conversation.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
