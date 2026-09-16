/**
 * Resources, the working areas they are checked out into, and the checkouts
 * themselves.
 *
 * A repo is identified by its canonical remote, so that column carries the
 * unique index: two spellings of one repository are one row, and the check is
 * the database's rather than a read the service could race.
 *
 * No path is stored anywhere here, and none is taken: where a working copy sits
 * is the machine's own business, and a primary is always a Hydra-managed clone
 * under that machine's storage.
 *
 * `project_resources` is rebuilt rather than altered: SQLite cannot add a
 * foreign key to a table that already exists, and the table it replaces could
 * hold no rows, because nothing could create a resource for it to point at.
 *
 * `session_tokens` holds hashes and nothing else, like every other credential
 * Hydra issues: the token itself exists in the frame that carries it to the
 * machine and nowhere else.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE resources (
      id BLOB PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('repo', 'folder', 'mailbox')),
      -- As the user wrote it, and the identity every spelling of it shares.
      remote TEXT,
      canonical_remote TEXT,
      label TEXT,
      connection_id BLOB REFERENCES connections (id),
      setup_command TEXT,
      workspace_include INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- A repo is its remote: nothing can check one out without it, so the
      -- database refuses a repo row that has none rather than leaving every
      -- reader to stand in for it.
      CHECK (kind <> 'repo' OR (remote IS NOT NULL AND canonical_remote IS NOT NULL)),
      -- And the other way round: a repo is named by its remote, so a label on
      -- one is a second name nothing reads, and a setup command or an include
      -- flag off a repo is a rule for a checkout that can never exist.
      CHECK (kind <> 'repo' OR label IS NULL),
      CHECK (kind = 'repo'
             OR (remote IS NULL AND canonical_remote IS NULL
                 AND setup_command IS NULL AND workspace_include = 0))
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX resources_canonical_remote ON resources (canonical_remote)
    WHERE canonical_remote IS NOT NULL
  `;
  // What `connection.delete` reads to find out whether anything still acts
  // through the connection it was asked to remove.
  yield* sql`CREATE INDEX resources_connection ON resources (connection_id)`;

  yield* sql`DROP TABLE project_resources`;
  yield* sql`
    CREATE TABLE project_resources (
      project_id BLOB NOT NULL REFERENCES projects (id),
      resource_id BLOB NOT NULL REFERENCES resources (id),
      PRIMARY KEY (project_id, resource_id)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX project_resources_resource ON project_resources (resource_id)`;

  yield* sql`
    CREATE TABLE workspaces (
      id BLOB PRIMARY KEY NOT NULL,
      -- Pinned where it was made: a workspace never moves, and a session in it
      -- is placed on this machine and no other.
      runner_id BLOB NOT NULL REFERENCES runners (id),
      kind TEXT NOT NULL CHECK (kind IN ('primary', 'ephemeral')),
      status TEXT NOT NULL
        CHECK (status IN ('provisioning', 'ready', 'failed', 'deleted', 'lost')),
      -- What the machine said when it could not make it.
      message TEXT,
      -- The Connection the work in this workspace acts through, settled when it
      -- was opened rather than re-derived from its first checkout's resource
      -- every time it is read: a resource that changes hands later does not
      -- change what a workspace already standing was opened against.
      designated_connection_id BLOB REFERENCES connections (id),
      created_at TEXT NOT NULL,
      provisioned_at TEXT,
      -- Written at provisioning and at every session start and exit in it; the
      -- expiry sweep reads it.
      last_used_at TEXT,
      disposed_at TEXT
    )
  `;
  yield* sql`CREATE INDEX workspaces_runner ON workspaces (runner_id, status)`;

  yield* sql`
    CREATE TABLE checkouts (
      id BLOB PRIMARY KEY NOT NULL,
      workspace_id BLOB NOT NULL REFERENCES workspaces (id),
      resource_id BLOB NOT NULL REFERENCES resources (id),
      form TEXT NOT NULL CHECK (form IN ('clone', 'worktree')),
      subdirectory TEXT,
      branch TEXT,
      branches TEXT NOT NULL CHECK (json_valid(branches)),
      default_branch TEXT,
      -- The order they were asked for: the first one's Connection is the
      -- workspace's designated one.
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX checkouts_workspace ON checkouts (workspace_id, position)`;
  yield* sql`CREATE INDEX checkouts_resource ON checkouts (resource_id)`;

  // Not foreign keys, for the reason the sessions table has none: a session is
  // history and outlives the project it was filed under and the connection it
  // acted through.
  yield* sql`ALTER TABLE sessions ADD COLUMN project_id BLOB`;
  // What the machine switches the main workspace to before the harness starts,
  // and the GitHub account this session pushes as. Both are settled when the
  // session is spawned and read again when it is dispatched, which can be a
  // controller restart later.
  yield* sql`ALTER TABLE sessions ADD COLUMN checkout_branch TEXT`;
  yield* sql`ALTER TABLE sessions ADD COLUMN github_connection_id BLOB`;

  yield* sql`
    CREATE TABLE session_tokens (
      token_hash TEXT PRIMARY KEY NOT NULL,
      session_id BLOB NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    ) WITHOUT ROWID
  `;
  // A session's token is revoked by its exit, which knows the session and not
  // the hash.
  yield* sql`CREATE INDEX session_tokens_session ON session_tokens (session_id)`;
});
