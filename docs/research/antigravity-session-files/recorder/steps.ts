import { Database } from "bun:sqlite";
const db = new Database(process.argv[2], { readonly: true });
console.log(db.query("select name from sqlite_master where type='table'").all().map((r: any) => r.name).join(","));
for (const r of db.query("select idx, step_type, length(step_payload) as n from steps order by idx").all() as any[]) console.log(r.idx, r.step_type, r.n);
