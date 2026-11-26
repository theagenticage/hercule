import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { readonly: true });
const idx = Number(process.argv[3]);
const row = db.query("select step_payload as p from steps where idx = ?").get(idx) as any;
const text = Buffer.from(row.p).toString("latin1");
const strings = text.match(/[\x20-\x7e\n]{12,}/g) ?? [];
for (const s of strings) console.log(JSON.stringify(s.replace(/[A-Za-z0-9_\-\.]{40,}/g, "<long>")).slice(0, 400));
