/**
 * Writes Connections straight into a stopped controller's database, for the
 * desktop end-to-end tests and the perf script.
 *
 * Creating a Connection through the API asks the provider whether the
 * credentials work, which neither can reach, so they write the rows instead.
 * The module runs on plain Node, like the perf script.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Connection } from "../../../packages/contract/src/index";

/** One Connection for `replaceConnections` to write. */
export interface ConnectionFixture {
  /** A UUID, written as the row's 16-byte id. */
  readonly id: string;
  /** The Connection's label, which is also written as its account name. */
  readonly label: string;
  readonly status: Connection["status"];
  readonly statusDetail?: string;
  /** The qualified type, `<pluginId>/<word>`. `github/github` when absent. */
  readonly type?: string;
}

/**
 * Deletes every Connection in the database of the controller whose Hercule
 * Home is `home`, then writes `fixtures`, with no credentials and an empty
 * config. Each is created a millisecond after the one before, so the
 * Connections list in the order given. The controller must be stopped,
 * because it holds its database locked while it runs. Fails when the write
 * fails.
 *
 * A Connection of a type the binary declares, with status `connected` or
 * `error`, does not keep that status: the controller polls it, finds no
 * token, and sets it to `needs-reauth` within seconds. A Connection whose
 * type no plugin in the binary declares is never polled.
 */
export function replaceConnections(home: string, fixtures: ReadonlyArray<ConnectionFixture>): void {
  const database = new DatabaseSync(join(home, "data", "hercule.db"));
  try {
    const insert = database.prepare(
      "INSERT INTO connections (id, plugin_id, type, label, display_name, account_id, status, " +
        "status_detail, labels, config, created_at, updated_at, feed_intervals) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '{}', ?, ?, '{}')",
    );
    const now = Date.now();
    database.exec("BEGIN");
    database.exec("DELETE FROM connections");
    for (const [index, fixture] of fixtures.entries()) {
      const { id, label, status, statusDetail = null, type = "github/github" } = fixture;
      const at = new Date(now + index).toISOString();
      insert.run(
        Buffer.from(id.replaceAll("-", ""), "hex"),
        type.split("/")[0]!,
        type,
        label,
        label,
        label,
        status,
        statusDetail,
        at,
        at,
      );
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}
