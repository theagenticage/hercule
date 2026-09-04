# FTS5 availability check

Run against the Bun version in `.bun-version` (1.4.0): `bun run fts5check.ts`.

```ts
import { Database } from "bun:sqlite";

const db = new Database(":memory:");
console.log("sqlite_version", db.query("select sqlite_version() as v").get());
db.run("CREATE VIRTUAL TABLE t USING fts5(a, b, tokenize='unicode61 remove_diacritics 2')");
db.run("INSERT INTO t(a,b) VALUES ('Café Naïve', 'hello world')");
console.log("match cafe:", db.query("SELECT a FROM t WHERE t MATCH 'cafe'").all());
console.log("bm25:", db.query("SELECT a, bm25(t) as r FROM t WHERE t MATCH 'hello'").all());
console.log(
  "compile opts:",
  db
    .query(
      "select group_concat(compile_options) as o from pragma_compile_options where compile_options like '%FTS%'",
    )
    .get(),
);
```

Output, 2026-09-04:

```
sqlite_version { v: "3.43.2" }
match cafe: [ { a: "Café Naïve" } ]
bm25: [ { a: "Café Naïve", r: -0.000001 } ]
compile opts: { o: "ENABLE_FTS3,ENABLE_FTS3_PARENTHESIS,ENABLE_FTS3_TOKENIZER,ENABLE_FTS4,ENABLE_FTS5" }
```

`unicode61 remove_diacritics 2` is accepted, `MATCH 'cafe'` finds `Café`, and
`bm25()` is available for relevance ordering.
