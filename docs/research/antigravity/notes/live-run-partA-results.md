# Part A results (Linux, head 0ebd947b3, agy 1.5.15, Flash unless noted). No quota message in ~70 prompts.
e2e rerun (Antigravity only, 3 files): 3 files passed, 6 tests passed, 24 skipped, 0 failed (215 s).
- 3 PASS denied command: agent said "denied and cancelled by the user", turn completed, next turn worked.
- 4 PASS question: card in approval-required and in full-access; answer used ("blue" / "red").
- 5 PASS MCP call: tool_approval card (mcp_tools_alpha__whoami), after Allow the result in the Thread.
- 6 PASS server added while running: `session update --mcp-server` then next prompt used beta__whoami (card, result).
- 7 PASS names: 52-char longname__a_tool...xxxx kept unchanged; hyphen tool search-pages shown as search_pages_f33805; each call reached its own tool (server log: search-pages, a_tool...).
- 8 PASS model switch neon -> flash: brain transcript steps show gemini-4-neon-high then gemini-3.8-flash-high.
- 9 PASS interrupt `sleep 60`: turn.completed interrupted, no sleep process after 5 s, next message answered.
- 10 PASS (see details): 5 tries, race a (allow vs interrupt at once) happened in 2 of 5 (allow won once, interrupt won once -> allow refused "request-closed"), request-during-interrupt not seen (3 of 5: interrupt landed before the card, turn ended interrupted, no card). Always: interrupted, no open Request, next message worked.
- 11 PASS runner restart (SIGTERM of the throwaway runner; controller restarted it): resumed session remembered "Blue".
- 12 settled on the Mac, not redone.
- 13 DONE see details.
- 14 PASS: approval-required denied with reason, auto-accept-edits ran 3 searches; connections: only agy processes (Google 172.217.x:443); Hercule runner/controller made none to the web.
- 15 PASS: sleep 100 via subagent gone 5 s after session/cancel; reply usage = parent's own model calls only (exact sum match), subagent tokens in no reply.
- 16 DONE: all 11 models answered "red" to a 32x32 PNG; 10 read it directly (0 tool calls); gpt-oss-120b-medium did NOT see it (7 tool calls: convert/python on the file). Flash also fine at 2048 and 6000 px solid PNG. imageInput is null for all 11 in Hercule (the controller refuses images).
- 17 OPEN: AGY_CLI_AUTO_COMPACT_OVERRIDE=2% (5 turns, used 17.7k), 1% (5 turns, 18.1k), 8000 (3 turns, 14.8k): no compaction seen at any (used passed the threshold at 1% and 8000). Value format per the binary: "800000, 800K, 80%".
- 18 DONE: library `release` beat checkout `release` for `/release` (LIBWORD) with a runtime.warning naming $skillrepo:release; `$skillrepo:release` ran the checkout one. `/plan` (checkout skill named like an agy command) ran the checkout skill, no message.
- 19 DONE: config/skills vs skills (Linux): the model's skill list holds only `skills/dup` (2 of 2 asks); config/skills was dropped silently. A `/dup x` run where the model read both files answered with config's word, so only the list is reliable.
- 29 DONE: agy does NOT trim a Path: files `trim-a.txt<space>` and `trim-b.txt<newline>` were created literally (relative paths are refused "path is not absolute").

## Details
Evidence files are in /tmp/hercule-1282/partA/evidence/ (scrubbed; no tokens or emails). Scripts: race.sh, raceb.sh, images.ts, item17.ts, item19.ts, view.py.
Throwaway controller, runner, MCP stand-ins stopped; home, token copies (runner Harness Home and rec-home), scratch removed.
Note: a first `hercule runner list` went to the live controller by mistake (HERCULE_API_URL of this session); read only, nothing written there.
