# Prints one compact line per recorded ACP message, merging runs of text chunks.
import sys, json
def short(v, n=330):
    s = json.dumps(v, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + "…"
last = None
for line in open(sys.argv[1]):
    r = json.loads(line); m = r["message"]; d = r["direction"]; t = r["t"] / 1000
    if "stderr" in m: print(f"{t:6.1f} STDERR {m['stderr'][:200]!r}"); continue
    if d == "out":
        if "method" in m and m["method"] in ("initialize", "authenticate"): continue
        print(f"{t:6.1f} >> {m.get('method') or ('reply#' + str(m.get('id')))} {short(m.get('params') or m.get('result') or m.get('error') or m, 260)}"); last = None; continue
    if m.get("method") == "session/update":
        u = m["params"]["update"]; k = u["sessionUpdate"]
        if k in ("agent_message_chunk", "agent_thought_chunk", "user_message_chunk"):
            if last == k: continue
            last = k; print(f"{t:6.1f} << {k} {short(u.get('content'), 140)} (… more chunks)"); continue
        last = None
        if k == "available_commands_update": print(f"{t:6.1f} << {k} [{len(u['availableCommands'])} commands]"); continue
        print(f"{t:6.1f} << {k} {short({x: y for x, y in u.items() if x != 'sessionUpdate'})}")
    elif "method" in m:
        last = None; print(f"{t:6.1f} << REQUEST {m['method']} id={m.get('id')} {short(m.get('params'), 600)}")
    else:
        last = None
        if m.get("id") in (1, 2): continue
        res = m.get("result") or m.get("error")
        if isinstance(res, dict) and "configOptions" in res: res = {"sessionId": res.get("sessionId"), "…": "models, modes, configOptions"}
        print(f"{t:6.1f} << reply#{m.get('id')} {short(res, 400)}")
