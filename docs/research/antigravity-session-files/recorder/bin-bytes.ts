const buf = Buffer.from(await Bun.file(process.argv[2]).bytes());
const needle = Buffer.from(process.argv[3], "utf8");
let i = buf.indexOf(needle);
while (i !== -1) { console.log(JSON.stringify(buf.subarray(i - 40, i + 60).toString("utf8"))); i = buf.indexOf(needle, i + 1); }
