# pi/cli/recall-topic-body/run2

## s1 t1
**user:** What's the Discord channel id for #ops? I need it for a webhook. Just the number.

**tools:** bash({"command":"hydra memory read discord-setup"})

**assistant:** 1188429077315

## s1 flush
**tools:** (none)

**assistant:** DONE
Nothing to record; the only fact used (the #ops channel id) was already in the `discord-setup` topic.

## verdict
{"pass":true,"notes":"drilled via: bash({\"command\":\"hydra memory read discord-setup\"})"}
