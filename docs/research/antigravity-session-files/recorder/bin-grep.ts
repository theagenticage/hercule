const buf = await Bun.file(process.argv[2]).bytes();
const text = Buffer.from(buf).toString("latin1");
for (const p of process.argv.slice(3)) {
  let i = 0, n = 0; const out: string[] = [];
  while ((i = text.indexOf(p, i)) !== -1 && n < 4) { out.push(JSON.stringify(text.slice(Math.max(0, i - 80), i + 160).replace(/[^\x20-\x7e]/g, "."))); i += p.length; n++; }
  console.log(`== ${p} (${n})\n${out.join("\n")}`);
}
