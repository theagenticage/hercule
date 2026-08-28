# claude/cli/fragmentation/run1

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash({"command":"hydra memory read hydra-project"})
Edit({"replace_all":false,"file_path":"hydra-project","old_string":"- Controller/runner split: runner dials the controller; c)
Bash({"command":"hydra memory write hydra-project --content \"$(cat <<'EOF'\n# hydra-project\n> Hydra architecture decisions,)

**assistant:** Right, memory isn't a file — it's only reachable through the `hydra` CLI. Let me write the updated topic that way.Got it, noted: the runner always dials the controller over a single websocket, connection never goes the other way. I've added that detail to the `hydra-project` memory topic.

## s1 flush
**tools:** (none)

**assistant:** Everything durable from this session (the websocket directionality fact) was already recorded to `hydra-project` mid-conversation.

DONE — nothing new to record; the runner/controller websocket fact was already written to hydra-project during the session.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash({"command":"hydra memory read hydra-project"})
Bash({"command":"hydra memory write hydra-project --content \"$(cat <<'EOF'\n# hydra-project\n> Hydra architecture decisions,)

**assistant:** Noted in `hydra-project`: the controller ships with an auto-joined local runner, so single-machine installs work out of the box. I also linked it to the open "runner join ceremony" thread, since it resolves the single-machine case but remote joining is still unsettled.

## s2 flush
**tools:** (none)

**assistant:** Already recorded during the conversation.

DONE — recorded that the controller ships with an auto-joined local runner (single-machine install works out of the box) in the `hydra-project` topic, under Facts and linked to the open runner-join-ceremony thread.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
