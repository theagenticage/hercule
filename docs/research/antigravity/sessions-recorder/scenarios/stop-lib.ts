import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
export const makeTmp = () => { const d = mkdtempSync("/tmp/stopq-"); process.env.TMPDIR = d; return d; };
export const procs = (tmp: string, root: number) => {
  const all = new Map<number, { ppid: number; pgid: number; cmd: string; env: boolean }>();
  for (const e of readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const st = readFileSync(`/proc/${e}/stat`, "utf8");
      const r = st.slice(st.lastIndexOf(")") + 2).split(" ");
      let env = false; try { env = readFileSync(`/proc/${e}/environ`, "utf8").includes(`TMPDIR=${tmp}`); } catch {}
      let cmd = ""; try { cmd = readFileSync(`/proc/${e}/cmdline`, "utf8").replace(/\0/g, " ").slice(0, 90); } catch {}
      all.set(+e, { ppid: +r[1], pgid: +r[2], cmd, env });
    } catch {}
  }
  const desc = new Set<number>([root]);
  for (let c = true; c;) { c = false; for (const [p, v] of all) if (!desc.has(p) && desc.has(v.ppid)) { desc.add(p); c = true; } }
  return [...all].filter(([p, v]) => desc.has(p) || v.env).map(([p, v]) => `${p} ppid=${v.ppid} pgid=${v.pgid} ${desc.has(p) ? "desc" : "-"}${v.env ? "+env" : ""} ${v.cmd}`);
};
