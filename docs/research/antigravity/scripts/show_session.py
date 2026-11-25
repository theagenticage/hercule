# Prints the parts of an acp_init.py transcript that matter: errors, tier, modes, model and thinking options.
import sys, json, re
for l in open(sys.argv[1]):
    if not l.startswith("OUT "):
        print(re.sub(r"[\w.+-]+@[\w.-]+", "<email>", l[:160].rstrip())); continue
    d = json.loads(l[4:])
    if d.get("id") == 1: continue
    if "error" in d: print("ERROR id", d["id"], d["error"]["message"][:160]); continue
    if d.get("id") == 2: print("authenticate ->", json.dumps(d.get("result"))[:260]); continue
    if d.get("id") == 3:
        r = d["result"]
        print("modes:", [m["id"] for m in r["modes"]["availableModes"]])
        for o in r.get("configOptions", []):
            print("configOption", o.get("id"), "current =", o.get("currentValue"))
            for e in o.get("options", []):
                if "options" in e: print("   GROUP", e.get("name"), [(x.get("value"), x.get("name")) for x in e["options"]])
                elif o.get("id") != "mode": print("   ", e.get("value"), "|", e.get("name"), "|", (e.get("description") or "")[:70])
        print("models.availableModels:", [m["modelId"] for m in (r.get("models") or {}).get("availableModels", [])])
    elif "method" in d:
        u = d.get("params", {}).get("update", {})
        print("NOTIFY", d["method"], u.get("sessionUpdate"), json.dumps({k: v for k, v in u.items() if k not in ("sessionUpdate", "availableCommands")})[:200])
    else: print("OTHER", json.dumps(d)[:300])
