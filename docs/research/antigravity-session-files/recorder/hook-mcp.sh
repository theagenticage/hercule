#!/bin/sh
# Logs the raw hook input (epoch ms + JSON) and answers nothing (no decision).
printf '%s ' "$(date +%s%3N)" >> /tmp/hercule-1283/rec/subagent-mcp-accept-edits.hook.log
cat >> /tmp/hercule-1283/rec/subagent-mcp-accept-edits.hook.log
printf '\n' >> /tmp/hercule-1283/rec/subagent-mcp-accept-edits.hook.log
