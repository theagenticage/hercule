# Sends ACP `initialize` (and optional extra requests) to an agent over stdio and prints the replies.
import json, subprocess, sys, time, select, os
cmd = sys.argv[1:]
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=os.environ.get("ACP_CWD"))
def send(o):
    p.stdin.write((json.dumps(o) + "\n").encode()); p.stdin.flush()
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":False,"writeTextFile":False},"terminal":False},"clientInfo":{"name":"acp-probe","version":"0.0.1"}}})
extra = os.environ.get("ACP_EXTRA")
sent_extra = False
end = time.time() + float(os.environ.get("ACP_WAIT", "12"))
while time.time() < end:
    r, _, _ = select.select([p.stdout, p.stderr], [], [], 0.5)
    for f in r:
        line = f.readline()
        if not line: continue
        tag = "OUT" if f is p.stdout else "ERR"
        print(tag, line.decode(errors="replace").rstrip()[:6000])
        if tag == "OUT" and extra and not sent_extra:
            sent_extra = True
            for o in json.loads(extra): send(o)
    if p.poll() is not None: break
p.kill()
