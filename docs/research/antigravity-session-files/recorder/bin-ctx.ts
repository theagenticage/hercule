const text = Buffer.from(await Bun.file(process.argv[2]).bytes()).toString("latin1");
const p = process.argv[3]; const before = Number(process.argv[4] ?? 1500), after = Number(process.argv[5] ?? 3000);
let i = text.indexOf(p); let n = Number(process.argv[6] ?? 0); while (n-- > 0 && i !== -1) i = text.indexOf(p, i + 1);
console.log(text.slice(Math.max(0, i - before), i + after).replace(/[^\x09\x0a\x20-\x7e]/g, "."));
