/**
 * The CLI table.
 *
 * One row per operation: how the `hercule` CLI spells the command, what the
 * command is for, worked examples, and one line of help per field. The CLI
 * derives its whole command tree, its argument parsing and its help from this
 * table and the operation's schemas, so no per-operation code lives in the CLI
 * package. `NOUNS` below does the same for each root noun.
 *
 * Rule: an operation added to the contract gets its row here in the same
 * change - spelling, purpose, examples and a line per field, or
 * `hidden: true` with the reason in a comment. The row type is keyed by
 * operation id, so a contract without a row does not compile.
 *
 * The help is written for an agent reading it mid-task, not for a reference
 * manual: what the command does and when to use it, what it returns, and
 * what to call next, by its exact spelling. A field's line is one line.
 */
import type { ErrorCode } from "./errors";
import type { OperationId } from "./operations";

/** One example invocation: the arguments after the command words, and what is piped to stdin. */
export interface CliExample {
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
}

/**
 * One field of an operation, as the command line takes it: a positional, a
 * flag, or a value read from stdin. A stdin field still has a flag, because
 * the switch that asks for it is `--<flag>-stdin`.
 */
export type FieldRow =
  | {
      readonly positional: true;
      readonly help: string;
      /**
       * The placeholder shown in usage, for when the field's own name does not
       * make clear whose id it is: the `id` of `/sessions/:id/inputs` is a
       * session's, so it is shown as `<session-id>`.
       */
      readonly placeholder?: string;
      /**
       * The list operation that resolves an id tail of eight or more
       * characters to a full id. A positional without one takes only the full
       * id, and its help line must say so.
       */
      readonly resolves?: OperationId;
    }
  | {
      readonly flag: string;
      readonly help: string;
      /**
       * The list operation that resolves an id tail given for this flag, as
       * for a positional. A tail is eight characters or more. The command
       * line accepts a tail, and the request sent to the API carries the
       * full id.
       */
      readonly resolves?: OperationId;
    }
  | {
      readonly stdin: true;
      readonly flag: string;
      readonly help: string;
      /**
       * Makes the command always read this field from stdin, even though the
       * operation lets it be absent. Use it when the operation's alternative
       * to this field is hidden from the command line, so this field is the
       * only way to pass the value.
       */
      readonly required?: true;
    }
  /**
   * Leaves the field off the command line. Give the reason in a comment, as
   * for a hidden operation.
   */
  | { readonly hidden: true };

/**
 * An operation with no command at all, or the command with everything the help
 * renderer cannot derive from the schemas.
 */
export type CliRow =
  | { readonly hidden: true }
  | {
      /** The words after `hercule`, in tree order: "runner join-token create". */
      readonly command: string;
      readonly help: string;
      /** At least one, most common first. */
      readonly examples: ReadonlyArray<CliExample>;
      readonly fields: Record<string, FieldRow>;
      /** Set only where the error code's generic meaning is not specific enough for this command. */
      readonly errors?: Partial<Record<ErrorCode, string>>;
    };

/** A root noun, as the root help and the noun's own help describe it. */
export interface NounRow {
  readonly summary: string;
  /** The usual order its verbs are called in, when the noun has one. */
  readonly flow?: string;
}

export const CLI = {
  "setup.read": {
    command: "setup read",
    help: "Shows whether first-run setup has been completed. Use it when a controller may be brand new: until setup is done, every other operation fails with unauthenticated. Finish setup with `hercule setup complete`.",
    examples: [{ args: [] }],
    fields: {},
  },
  "setup.complete": {
    command: "setup complete",
    help: "Creates the user and finishes first-run setup. Takes the one-time setup token the controller printed at first boot, not a credential, and returns a bearer token for the new user.",
    examples: [
      {
        args: [
          "--setup-token",
          "st_9c2e4f181f3a9c2e",
          "--username",
          "rogier",
          "--timezone",
          "Europe/Amsterdam",
        ],
        stdin: "correct horse battery staple",
      },
    ],
    fields: {
      username: { flag: "username", help: "The user name to create." },
      password: {
        stdin: true,
        flag: "password",
        help: "The password to set; it never reaches the process list or the shell history.",
      },
      timezone: {
        flag: "timezone",
        help: "The IANA zone the user reads times in, such as Europe/Amsterdam.",
      },
    },
  },

  // Returns a bearer token, which `hercule login` exchanges for an API key. It
  // has no command, because a second way to create a bearer token would be a
  // second credential to look after.
  "auth.login": { hidden: true },
  // Revokes a bearer token, which the CLI never holds: it authenticates with an
  // API key or a session token.
  "auth.logout": { hidden: true },
  // Returns the one-time ticket the web app exchanges for a live socket. A
  // terminal has no use for it.
  "auth.wsTicket": { hidden: true },

  "apiKey.query": {
    command: "api-key list",
    help: "Lists the user's API keys - references only, never the tokens. Use it to find the id of a key to revoke with `hercule api-key revoke`.",
    examples: [{ args: [] }],
    fields: {},
    errors: { unauthenticated: "user credential only: a session token is not allowed" },
  },
  "apiKey.create": {
    command: "api-key create",
    help: "Creates a long-lived user credential and prints its token once. The token is shown here and nowhere else, so save it now; every request made with it acts as the user.",
    examples: [{ args: ["--name", "ci-deploy"] }],
    fields: {
      name: {
        flag: "name",
        help: "What to call the key, so `hercule api-key list` shows what it is for.",
      },
    },
    errors: { unauthenticated: "user credential only: a session token is not allowed" },
  },
  "apiKey.revoke": {
    command: "api-key revoke",
    help: "Revokes an API key; the next request presenting it fails. Find the id with `hercule api-key list`.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The key's id, or a tail of eight or more characters.",
        resolves: "apiKey.query",
      },
    },
    errors: { unauthenticated: "user credential only: a session token is not allowed" },
  },

  "user.setPassword": {
    command: "user set-password",
    help: "Changes the user's password, verifying the current one first. A stolen token alone cannot take the account over.",
    examples: [{ args: [], stdin: "the-old-password\nthe-new-password" }],
    fields: {
      current: {
        stdin: true,
        flag: "current",
        help: "The current password.",
      },
      next: { stdin: true, flag: "next", help: "The password to set." },
    },
    errors: { unauthenticated: "user credential only: a session token is not allowed" },
  },

  "settings.read": {
    command: "settings read",
    help: "Reads every setting that is set, in both scopes. `controller` holds the controller's operational settings, `user` the user's own preferences. A key that is not set is absent rather than defaulted. Write with `hercule settings update`.",
    examples: [{ args: [] }],
    fields: {},
    errors: { unauthenticated: "user credential only: a session token is not allowed" },
  },
  "settings.update": {
    command: "settings update",
    help: "Sets settings in either scope; a key you do not name is left alone. Each flag takes a JSON object keyed by setting name, and an unknown key is rejected rather than ignored.",
    examples: [
      { args: ["--user", '{"ui.threadRows":"plain"}'] },
      { args: ["--controller", '{"retention.events":30,"backup.time":"03:30"}'] },
    ],
    fields: {
      controller: {
        flag: "controller",
        help: "The controller's operational settings as a JSON object: retention, backup, session timeouts, workspace expiry and how deep runs may nest (run.nestingLimit).",
      },
      user: {
        flag: "user",
        help: "The user's own settings as a JSON object: timezone, thread defaults, topic order, mutes.",
      },
    },
    errors: { unauthenticated: "user credential only: a session token is not allowed" },
  },

  "profile.query": {
    command: "profile list",
    help: "Lists the Permission Profiles a session can be spawned under, each with the Grants it carries. Use it to find the id that `hercule session spawn --profile` takes.",
    examples: [{ args: [] }],
    fields: {},
  },
  "profile.read": {
    command: "profile read",
    help: "Reads one Permission Profile in full: its name and its grants. It also shows whether it is one of the three shipped profiles.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The profile's id, or a tail of eight or more characters.",
        resolves: "profile.query",
      },
    },
  },
  "profile.create": {
    command: "profile create",
    help: "Creates a Permission Profile: a named bundle of grants a session's token carries. It bounds what that session may do through the API; parity with the user is the ceiling, not the starting point.",
    examples: [
      {
        args: [
          "--name",
          "triage",
          "--grant",
          "task.read",
          "--grant",
          "task.update",
          "--grant",
          "event.read",
        ],
      },
    ],
    fields: {
      name: { flag: "name", help: "What to call the profile." },
      grants: {
        flag: "grant",
        help: "A grant the profile carries, written <family>.<verb>: task.delete, infra.write. A family covers several operations.",
      },
    },
  },
  "profile.update": {
    command: "profile update",
    help: "Edits a Permission Profile. The grant list is replaced whole, not merged, so send every grant the profile is to keep. A session already running keeps the grants it was spawned with.",
    examples: [{ args: ["1f3a9c2e", "--grant", "task.read", "--grant", "task.create"] }],
    fields: {
      id: {
        positional: true,
        help: "The profile's id, or a tail of eight or more characters.",
        resolves: "profile.query",
      },
      name: { flag: "name", help: "A new name for the profile." },
      grants: {
        flag: "grant",
        help: "A grant of the replacement list: send every grant the profile is to keep, not only the new ones.",
      },
    },
  },
  "profile.delete": {
    command: "profile delete",
    help: "Deletes a Permission Profile. The three shipped profiles are seeded at first run and cannot be deleted.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The profile's id, or a tail of eight or more characters.",
        resolves: "profile.query",
      },
    },
    errors: {
      invalid_state:
        "that profile is one of the three shipped profiles, which cannot be deleted; edit its grants instead",
    },
  },

  "secret.query": {
    command: "secret list",
    help: "Lists secret references: owner, name and when each was last rotated. Never values - nothing in the API reads a secret back.",
    examples: [{ args: [] }, { args: ["--owner-kind", "plugin", "--owner-id", "github"] }],
    fields: {
      ownerKind: {
        flag: "owner-kind",
        help: "Which kind of thing owns them; pair it with --owner-id to see one owner's secrets.",
      },
      ownerId: { flag: "owner-id", help: "Only secrets of this one owner, by its full id." },
    },
    errors: { unauthenticated: "user credential only: a session token is not allowed" },
  },
  "secret.set": {
    command: "secret set",
    help: "Stores or rotates one secret under an owner. The value can never be read back out. The `core` owner kind is the controller's own key material and is not allowed here.",
    examples: [{ args: ["plugin", "github", "client_secret"], stdin: "ghp_the_secret_value" }],
    fields: {
      ownerKind: {
        positional: true,
        help: "Which kind of thing owns the secret; together with the owner id, it identifies the owner.",
      },
      ownerId: {
        positional: true,
        help: "The owner's own id in full - a plugin's name, a connection's or runner's id - never a tail and never containing `|`.",
      },
      name: {
        positional: true,
        help: "What the secret is called under that owner; it may not contain `|` either.",
      },
      value: { stdin: true, flag: "value", help: "The secret value." },
    },
    errors: { unauthenticated: "user credential only: a session token is not allowed" },
  },
  "secret.delete": {
    command: "secret delete",
    help: "Removes one secret from an owner. Whatever used it fails on its next call, so check with `hercule secret list` first. The `core` owner kind is the controller's own key material and is not allowed here.",
    examples: [{ args: ["plugin", "github", "client_secret"] }],
    fields: {
      ownerKind: {
        positional: true,
        help: "Which kind of thing owns the secret; together with the owner id, it identifies the owner.",
      },
      ownerId: {
        positional: true,
        help: "The owner's own id in full, never a tail and never containing `|`.",
      },
      name: {
        positional: true,
        help: "What the secret is called under that owner; it may not contain `|` either.",
      },
    },
    errors: { unauthenticated: "user credential only: a session token is not allowed" },
  },

  "task.query": {
    command: "task list",
    help: "Lists tasks. Repeating a flag widens (any of its values); adding another flag narrows (all must hold); there is no negation. Use it to find the id that `hercule task read` and `hercule task update` take.",
    examples: [
      { args: ["--status", "open"] },
      { args: ["--status", "open", "--status", "in-progress", "--label", "triage"] },
      { args: ["--text", "flaky login"] },
    ],
    fields: {
      refs: {
        flag: "ref",
        help: "An External Ref the task carries, written fully qualified: github:issue:owner/repo#42.",
      },
      labels: {
        flag: "label",
        help: "A label the task carries; repeat the flag to find tasks with any of the labels.",
      },
      status: {
        flag: "status",
        help: "The task's status; repeat the flag to list open and in-progress tasks together.",
      },
      projectId: {
        flag: "project",
        help: "Only tasks in this project, by its full id.",
      },
      text: {
        flag: "text",
        help: "Full-text search over title and description; a label or a ref is never found this way.",
      },
    },
  },
  "task.read": {
    command: "task read",
    help: "Reads one task in full, its Provenance included. Provenance is the append-only record of what created or touched it.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The task's id, or a tail of eight or more characters.",
        resolves: "task.query",
      },
    },
  },
  "task.create": {
    command: "task create",
    help: "Creates a Task: a unit of human intent, never an execution. The description is markdown. Returns the task's id, which `hercule task update` and `hercule task read` take.",
    examples: [
      {
        args: ["--title", "Fix the flaky login test", "--label", "triage", "--priority", "high"],
        stdin: "It fails about one run in five on CI, always at the redirect step.",
      },
      { args: ["--title", "Write the release notes"], stdin: "" },
    ],
    fields: {
      title: { flag: "title", help: "One line saying what the work is; not a paragraph." },
      description: {
        stdin: true,
        flag: "description",
        help: "The task's markdown body. Pipe an empty string for none.",
      },
      priority: {
        flag: "priority",
        help: "How much this matters; leave it off to use the server's default.",
      },
      labels: {
        flag: "label",
        help: "A label to put on the task. Labels are one flat namespace; nothing registers them.",
      },
      projectId: {
        flag: "project",
        help: "The project this task belongs to, by its full id.",
      },
      provenance: {
        flag: "provenance",
        help: "A JSON entry that records what created this task - at least one of ref, eventId and runId - so a repeated signal finds it again.",
      },
    },
  },
  "task.update": {
    command: "task update",
    help: "Edits a task; a field you leave out is not changed. Labels move one at a time with --add-label and --remove-label, so a user and an agent writing the same task never undo each other.",
    examples: [
      { args: ["1f3a9c2e", "--status", "in-progress"] },
      { args: ["1f3a9c2e", "--add-label", "triaged", "--remove-label", "needs-triage"] },
      {
        args: ["1f3a9c2e", "--description-stdin"],
        stdin: "Reproduced: the redirect races the session cookie.",
      },
    ],
    fields: {
      id: {
        positional: true,
        help: "The task's id, or a tail of eight or more characters.",
        resolves: "task.query",
      },
      title: { flag: "title", help: "A new title." },
      description: {
        stdin: true,
        flag: "description",
        help: "A replacement markdown body.",
      },
      status: {
        flag: "status",
        help: "The task's status. There is no state machine: every transition is allowed.",
      },
      priority: { flag: "priority", help: "How much this matters now." },
      projectId: {
        flag: "project",
        help: "Move the task to this project; `null` detaches it from the one it has.",
      },
      addLabels: {
        flag: "add-label",
        help: "A label to add, leaving the ones already on the task alone.",
      },
      removeLabels: { flag: "remove-label", help: "A label to take off, leaving the rest alone." },
      provenance: {
        flag: "provenance",
        help: "A JSON entry to append to the record of what has touched this task; provenance is never edited and never removed.",
      },
    },
  },
  "task.delete": {
    command: "task delete",
    help: "Deletes a task. The delete is soft and cannot be undone: reading the task fails with not_found, and it no longer appears in `hercule task list` or in search.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The task's id, or a tail of eight or more characters.",
        resolves: "task.query",
      },
    },
  },

  "project.query": {
    command: "project list",
    help: "Lists projects: the groupings that hold related work and its materials. A project carries no behaviour and no defaults. Use it to find the id that `hercule task create --project` takes.",
    examples: [{ args: [] }],
    fields: {},
  },
  "project.read": {
    command: "project read",
    help: "Reads one project: its name and its description.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The project's id, or a tail of eight or more characters.",
        resolves: "project.query",
      },
    },
  },
  "project.create": {
    command: "project create",
    help: "Creates a Project to group related work. It is organisation only: nothing about a task changes because it joins one. The description is markdown.",
    examples: [
      { args: ["--name", "Hercule v1"] },
      {
        args: ["--name", "Hercule v1", "--description-stdin"],
        stdin: "Everything for the first release.",
      },
    ],
    fields: {
      name: { flag: "name", help: "What to call the project." },
      description: {
        stdin: true,
        flag: "description",
        help: "The project's markdown body.",
      },
    },
  },
  "project.update": {
    command: "project update",
    help: "Edits a project; a field you leave out is not changed.",
    examples: [
      { args: ["1f3a9c2e", "--name", "Hercule v1.1"] },
      {
        args: ["1f3a9c2e", "--description-stdin"],
        stdin: "Shipped; keeping it for the follow-ups.",
      },
    ],
    fields: {
      id: {
        positional: true,
        help: "The project's id, or a tail of eight or more characters.",
        resolves: "project.query",
      },
      name: { flag: "name", help: "A new name for the project." },
      description: {
        stdin: true,
        flag: "description",
        help: "A replacement markdown body; pipe `null` to take the description off again.",
      },
    },
  },
  "project.delete": {
    command: "project delete",
    help: "Deletes a project. The delete is soft, and a task in the project keeps its project id, so nothing about that task changes.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The project's id, or a tail of eight or more characters.",
        resolves: "project.query",
      },
    },
  },

  "resource.query": {
    command: "resource list",
    help: "Lists the Resources Hercule knows: the repos, folders and mailboxes projects work with. Use it to find the id the other `hercule resource` commands take.",
    examples: [{ args: [] }, { args: ["--kind", "repo"] }],
    fields: {
      kind: { flag: "kind", help: "Only resources of this kind: repo, folder or mailbox." },
      projectId: { flag: "project", help: "Only resources filed under this project." },
    },
  },
  "resource.read": {
    command: "resource read",
    help: "Reads one Resource in full. It shows the remote and its canonical form, the Connection it acts through, its setup command and the projects it is filed under.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The resource's id, or a tail of eight or more characters.",
        resolves: "resource.query",
      },
    },
  },
  "resource.create": {
    command: "resource create",
    help: "Records a Resource: a git repo Hercule checks out, or a folder or mailbox it works with. A repo is identified by its remote however you spell it, so the same repository is added only once.",
    examples: [
      { args: ["--kind", "repo", "--remote", "https://github.com/acme/web"] },
      {
        args: [
          "--kind",
          "repo",
          "--remote",
          "git@github.com:acme/api.git",
          "--connection",
          "7b41d0a5",
          "--setup-command",
          "pnpm install",
          "--project",
          "1f3a9c2e",
        ],
      },
      { args: ["--kind", "folder", "--label", "Notes"] },
    ],
    fields: {
      kind: { flag: "kind", help: "What it is: repo, folder or mailbox." },
      remote: {
        flag: "remote",
        help: "The git remote, ssh or https; required for a repo and not allowed for anything else.",
      },
      label: {
        flag: "label",
        help: "What to call it; required for a folder and a mailbox, which have no remote to identify them, and not allowed on a repo.",
      },
      connectionId: {
        flag: "connection",
        help: "The Connection Hercule acts through for it; a repo's connection must be a GitHub connection.",
      },
      setupCommand: {
        flag: "setup-command",
        help: "Run once in every fresh checkout of this repo, before the agent starts; a repo only.",
      },
      workspaceInclude: {
        flag: "workspace-include",
        help: "Whether a fresh workspace takes the files the main workspace's .workspaceinclude lists; on unless set to false; a repo only.",
      },
      projectIds: { flag: "project", help: "A project to file it under; repeat for several." },
    },
    errors: { conflict: "another resource already points to the same repository" },
  },
  "resource.update": {
    command: "resource update",
    help: "Changes a Resource: its remote, Connection, setup command or include flag. A project list given here replaces the one the resource had.",
    examples: [
      { args: ["1f3a9c2e", "--setup-command", "pnpm install"] },
      { args: ["1f3a9c2e", "--connection", "null"] },
    ],
    fields: {
      id: {
        positional: true,
        help: "The resource's id, or a tail of eight or more characters.",
        resolves: "resource.query",
      },
      remote: {
        flag: "remote",
        help: "The git remote; it is converted to canonical form and validated again.",
      },
      label: {
        flag: "label",
        help: "What to call it; null removes the label. Not allowed on a repo.",
      },
      connectionId: {
        flag: "connection",
        help: "The Connection to act through; null removes it.",
      },
      setupCommand: {
        flag: "setup-command",
        help: "Run in every fresh checkout; null removes it. A repo only.",
      },
      workspaceInclude: {
        flag: "workspace-include",
        help: "Whether a fresh workspace takes what .workspaceinclude lists. A repo only.",
      },
      projectIds: {
        flag: "project",
        help: "The projects to file it under, replacing the ones it has; repeat for several.",
      },
    },
    errors: { conflict: "another resource already points to the same repository" },
  },
  "resource.delete": {
    command: "resource delete",
    help: "Removes a Resource and the project links it had. It fails while a workspace still uses the resource; dispose of the workspace before deleting the resource, or retire its runner if it is a main workspace.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The resource's id, or a tail of eight or more characters.",
        resolves: "resource.query",
      },
    },
    errors: {
      invalid_state:
        "a workspace still uses that resource; dispose of the workspace before deleting the resource, or retire its runner if it is a main workspace",
    },
  },

  "workspace.query": {
    command: "workspace list",
    help: 'Lists the Workspaces on the fleet: what each holds and its status. Use it to find one to open a thread in with `hercule session spawn --workspace \'{"kind":"existing","workspaceId":"<id>"}\'`.',
    examples: [{ args: [] }, { args: ["--runner", "7b41d0a5", "--status", "ready"] }],
    fields: {
      runnerId: { flag: "runner", help: "Only workspaces on this machine." },
      resourceId: {
        flag: "resource",
        help: "Only workspaces holding a checkout of this resource.",
      },
      projectId: {
        flag: "project",
        help: "Only workspaces holding a checkout of this project's repos.",
      },
      kind: {
        flag: "kind",
        help: "Only workspaces of this kind: primary (a repo's main workspace) or ephemeral.",
      },
      status: {
        flag: "status",
        help: "Only workspaces in this state: provisioning, ready, failed, deleted or lost.",
      },
    },
  },
  "workspace.read": {
    command: "workspace read",
    help: "Reads one Workspace in full. It shows its checkouts and their branches, its status, and the sessions in it that have not exited. Poll it after `hercule workspace provision` until its status is ready.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The workspace's id, or a tail of eight or more characters.",
        resolves: "workspace.query",
      },
    },
  },
  "workspace.provision": {
    command: "workspace provision",
    help: "Makes a repo's main workspace on one machine, which is the long-lived working copy threads share. Hercule clones it fresh under that machine's own storage; a folder you already have is never taken over. It returns at once with the workspace in provisioning, and the machine reports when it is ready; read it with `hercule workspace read`.",
    examples: [{ args: ["--resource", "1f3a9c2e", "--runner", "7b41d0a5"] }],
    fields: {
      resourceId: {
        flag: "resource",
        help: "The repo to check out; a folder or a mailbox is not allowed.",
      },
      runnerId: { flag: "runner", help: "The machine to make it on." },
    },
    errors: {
      conflict: "that repo already has a main workspace on that machine",
      // Written here rather than imported: the controller owns its error
      // message, and this is the short explanation shown beside the flag.
      invalid_state: "only a repo is checked out; a folder and a mailbox are records",
    },
  },
  "workspace.dispose": {
    command: "workspace dispose",
    help: "Tears down an ephemeral workspace. The machine removes its worktrees and its directory, the branches stay in the repo's cache, and a main workspace is never torn down.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The workspace's id, or a tail of eight or more characters.",
        resolves: "workspace.query",
      },
    },
    errors: {
      invalid_state:
        "a main workspace is never torn down, and a workspace that is already gone has nothing left to tear down",
    },
  },

  "event.query": {
    command: "event list",
    help: "Reads the event log: external events and audit entries in one format, told apart by their kind. Use it to see what the system received and what it did about it. Security entries - the secret, auth and user account kinds - need the event.audit grant; without it they are simply absent from the page, and filtering by one of those kinds returns nothing.",
    examples: [
      { args: ["--kind", "task.created"] },
      { args: ["--since", "2026-09-15T00:00:00.000Z"] },
    ],
    fields: {
      connectionId: {
        flag: "connection",
        help: "Only events that arrived through this Connection, by its full id.",
      },
      kind: {
        flag: "kind",
        help: "One exact event kind, such as task.created or github.issue.opened.",
      },
      since: {
        flag: "since",
        help: "Only events received at or after this UTC instant, with milliseconds: 2026-09-15T00:00:00.000Z.",
      },
      until: {
        flag: "until",
        help: "Only events received at or before this UTC instant, with milliseconds.",
      },
    },
  },
  "event.read": {
    command: "event read",
    help: "Reads one event in full, its payload and the vendor original included. Find its id in `hercule event list`. A security entry - the secret, auth and user account kinds - needs the event.audit grant; without it, reading the entry fails with not_found.",
    examples: [{ args: ["4217"] }],
    fields: {
      id: {
        positional: true,
        help: "The event's id, which is its position in the log: a whole number counted from one, never a tail.",
      },
    },
    errors: {
      not_found:
        "no entry has that id, or it is a security entry and you do not hold event.audit; the two cases fail the same way on purpose",
    },
  },
  "event.emit": {
    command: "event emit",
    help: "Posts one event into the pipeline by hand. Use it to test a subscription or a filter without waiting for the real thing to happen, or to tell Hercule about something no source watches. The kind must be one a plugin declared, and the payload must match that kind's schema; the core fills in the rest and returns the new event's id.",
    examples: [
      {
        args: [
          "--kind",
          "github.issue.opened",
          "--payload",
          '{"subject":{"repo":"octo/repo","number":42,"url":"https://github.com/octo/repo/issues/42"}}',
          "--ref",
          "github:issue:octo/repo#42",
        ],
      },
      {
        args: [
          "--kind",
          "github.pr.merged",
          "--payload",
          '{"subject":{"repo":"octo/repo","number":87,"url":"https://github.com/octo/repo/pull/87"}}',
          "--dedup-key",
          "pr-87-merged",
        ],
      },
    ],
    fields: {
      kind: {
        flag: "kind",
        help: "The declared event kind, such as github.issue.opened; an unregistered kind is rejected, and the error includes it.",
      },
      payload: {
        flag: "payload",
        help: "The event's payload as one JSON object, validated against the kind's declared schema.",
      },
      connectionId: {
        flag: "connection",
        help: "The Connection the event is to be stamped with, by its full id; omit it for an event that came through none.",
      },
      refs: {
        flag: "ref",
        help: "An External Ref the event is about, written <system>:<kind>:<identity>; repeat the flag for several.",
      },
      dedupKey: {
        flag: "dedup-key",
        help: "The emitter's idempotency key: a second emit with the same key and Connection returns the first event's id instead of writing a second event.",
      },
    },
    errors: {
      not_found: "no Connection has that id",
      validation:
        "no plugin declares that kind, or the payload does not fit the kind's schema, or a ref is not written <system>:<kind>:<identity>",
    },
  },
  "event.enrich": {
    command: "event enrich",
    help: "Amends one event that is already in the log. What may be amended is the system it is about, where a person opens it, and the External Refs it carries. Use it after reading an event that arrived through one system and is really about another. A field you give is overwritten, a field you leave out is not changed, and refs are only ever added, never removed; the payload and the original are never changed.",
    examples: [
      {
        args: [
          "4217",
          "--system",
          "sentry",
          "--url",
          "https://sentry.io/issues/123",
          "--ref",
          "sentry:issue:123",
        ],
      },
      { args: ["4217", "--ref", "github:pr:octo/repo#87"] },
    ],
    fields: {
      id: {
        positional: true,
        help: "The event's id, which is its position in the log: a whole number counted from one, never a tail.",
      },
      system: {
        flag: "system",
        help: "The external system the event is really about, such as sentry; it replaces what the emitter stamped.",
      },
      url: {
        flag: "url",
        help: "Where a person opens this event in that system; it replaces the one the emitter stamped.",
      },
      refs: {
        flag: "ref",
        help: "An External Ref to add, written <system>:<kind>:<identity>; repeat the flag for several. A ref the event already has is not added twice.",
      },
    },
    errors: {
      not_found:
        "no entry has that id, or it is an audit entry: the log's record of what Hercule itself did is never amended, so it is treated as missing here",
    },
  },

  "subscription.query": {
    command: "subscription list",
    help: "Lists what a session is waiting on. Each row shows the target, the condition that target expanded into, its health - ok, or the error while its condition cannot be evaluated - and the last wake-up a restart cancelled, with the event that will not be delivered again. With a session token and no --holder, it lists that session's own. Only live subscriptions are listed; a cancelled one no longer appears.",
    examples: [
      { args: [] },
      { args: ["--holder", "session:0192f0a1-3c4b-7d2e-8f01-2a3b4c5d6e7f"] },
    ],
    fields: {
      holder: {
        flag: "holder",
        help: "Whose subscriptions to list, written session:<session id> with the full id. Without it, a session token lists its own; a user credential must give one.",
      },
    },
  },
  "subscription.create": {
    command: "subscription create",
    help: "Waits on something that has not happened yet. The event that satisfies the target is delivered to this session as its next input. Use it instead of polling - start the thing, subscribe to it, end the turn - and end the wait with `hercule subscription cancel`. Only a session can hold a subscription, and the calling session becomes the holder.",
    examples: [{ args: ["github:pr:o/r#87"] }, { args: ["gmail:thread:19b2c"] }],
    fields: {
      target: {
        positional: true,
        placeholder: "target",
        help: "What to wait on, as one word: an External Ref written <system>:<kind>:<identity>, or run:<run id>, session:<session id>, request:<permission request id>.",
      },
    },
    errors: {
      invalid_state:
        "this version has no runs, no session platform events and no Permission Requests, so only a ref target can be waited on",
      validation: "a user credential holds no subscription; call this on a session token",
    },
  },
  "subscription.cancel": {
    command: "subscription cancel",
    help: "Ends one subscription, so the event router stops evaluating it and nothing more arrives through it. Find the id with `hercule subscription list`.",
    examples: [{ args: ["0192f0a1-3c4b-7d2e-8f01-2a3b4c5d6e7f"] }],
    fields: {
      id: {
        positional: true,
        help: "The subscription's full id, as `hercule subscription create` returned it; a tail is not resolved here.",
      },
    },
    errors: {
      not_found:
        "nothing to end: no subscription has that id, or it has ended already, or another session holds it; the three cases fail the same way",
    },
  },

  "workflow.query": {
    command: "workflow list",
    help: "Lists the workflows, most recently changed first, and shows whether each one is enabled. Each workflow's name and description come from its source. Use it to find the id that `hercule workflow read` and `hercule workflow update` take.",
    examples: [{ args: [] }, { args: ["--enabled", "true"] }],
    fields: {
      enabled: {
        flag: "enabled",
        help: "Only enabled workflows (true) or only disabled ones (false).",
      },
    },
  },
  "workflow.read": {
    command: "workflow read",
    help: "Prints a workflow's YAML source exactly as it was saved, and nothing else. Comments and blank lines are kept. Save it to a file, edit it, and send it back with `hercule workflow update`. With --json the output also shows whether the workflow is enabled, and when it was created and last updated.",
    examples: [{ args: ["1f3a9c2e"] }, { args: ["1f3a9c2e", "--json"] }],
    fields: {
      id: {
        positional: true,
        help: "The workflow's id, or a tail of eight or more characters.",
        resolves: "workflow.query",
      },
    },
  },
  "workflow.create": {
    command: "workflow create",
    help: "Creates a workflow from the YAML read from stdin, and stores the YAML byte for byte. An invalid source is rejected with one line per error, each giving its path in the definition, and nothing is stored. A new workflow is disabled: its triggers match no events until you enable it with `hercule workflow update <id> --enabled true`.",
    examples: [
      {
        args: [],
        stdin: [
          "# Files a task every weekday morning.",
          "name: Morning failures",
          "triggers:",
          "  - id: weekday_morning",
          "    kind: start",
          "    source:",
          "      kind: cron.tick",
          '    schedule: "0 9 * * 1-5"',
          "steps:",
          "  - id: file_task",
          "    kind: action",
          "    action: task.create",
          "    params:",
          "      title: Look at the overnight failures",
          "      description: Filed by a workflow.",
        ].join("\n"),
      },
    ],
    fields: {
      source: {
        stdin: true,
        flag: "source",
        help: "The workflow's YAML source. It is stored exactly as sent, including comments and blank lines.",
        required: true,
      },
      // The `definition` object is for programs that build a workflow in code.
      // On the command line a workflow is always YAML text read from stdin.
      definition: { hidden: true },
    },
    errors: {
      validation:
        "the source is not a valid workflow: each printed line gives a path in the definition and the problem there, and a YAML syntax error gives its line and column; nothing was stored",
    },
  },
  "workflow.update": {
    command: "workflow update",
    help: "Replaces a workflow's YAML source, or enables or disables the workflow. Enabling or disabling leaves the source unchanged. An invalid new source is rejected and the stored workflow does not change. When the source changes, each trigger that keeps its id also keeps its status.",
    examples: [
      { args: ["1f3a9c2e", "--enabled", "true"] },
      {
        args: ["1f3a9c2e", "--source-stdin"],
        stdin: [
          "name: Morning failures",
          "steps:",
          "  - id: file_task",
          "    kind: action",
          "    action: task.create",
          "    params:",
          "      title: Look at the overnight failures",
          "      description: Filed by a workflow.",
        ].join("\n"),
      },
    ],
    fields: {
      id: {
        positional: true,
        help: "The workflow's id, or a tail of eight or more characters.",
        resolves: "workflow.query",
      },
      source: {
        stdin: true,
        flag: "source",
        help: "The new YAML source, stored exactly as sent.",
      },
      // The `definition` object is for programs that build a workflow in code.
      // On the command line a workflow is always YAML text read from stdin.
      definition: { hidden: true },
      enabled: {
        flag: "enabled",
        help: "true enables the workflow's triggers, false disables them; the source does not change.",
      },
    },
    errors: {
      validation:
        "the new source is not a valid workflow: each printed line gives a path in the definition and the problem there; the stored workflow did not change",
    },
  },
  "workflow.delete": {
    command: "workflow delete",
    help: "Deletes a workflow and its triggers. Its source is deleted too, so save it first with `hercule workflow read` if you might need it again. Its finished runs are kept, each with its own copy of the workflow.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The workflow's id, or a tail of eight or more characters.",
        resolves: "workflow.query",
      },
    },
    errors: {
      invalid_state:
        "a run of the workflow is still pending or running; wait for it to finish, or cancel it with `hercule run cancel`",
    },
  },
  "workflow.validate": {
    command: "workflow validate",
    help: "Validates the YAML read from stdin the same way `hercule workflow create` does, but stores nothing. Prints one line per error and per warning, each giving its path in the definition. If there are none it prints valid, and saving the same source will succeed with no warnings. Exits with 1 if there are errors, like a rejected save, and with 0 if there are only warnings or none. List the actions a step can call with `hercule workflow-action list`, and the event kinds a trigger can listen for with `hercule event-kind list`.",
    examples: [
      {
        args: [],
        stdin: [
          "name: Morning failures",
          "triggers:",
          "  - id: weekday_morning",
          "    kind: start",
          "    source:",
          "      kind: cron.tick",
          '    schedule: "0 9 * * 1-5"',
          "steps:",
          "  - id: file_task",
          "    kind: action",
          "    action: task.create",
          "    params:",
          "      title: Look at the overnight failures",
          "      description: Filed by a workflow.",
        ].join("\n"),
      },
    ],
    fields: {
      source: {
        stdin: true,
        flag: "source",
        help: "The workflow's YAML source, validated exactly as sent.",
        required: true,
      },
      // The `definition` object is for programs that build a workflow in code.
      // On the command line a workflow is always YAML text read from stdin.
      definition: { hidden: true },
    },
  },

  "trigger.query": {
    command: "trigger list",
    help: "Lists the triggers of every workflow, newest first. Each row shows the event kind the trigger listens for, and whether a start trigger is active or paused. Triggers are defined in their workflow's source, so change one with `hercule workflow update`.",
    examples: [
      { args: [] },
      { args: ["--workflow", "1f3a9c2e"] },
      { args: ["--kind", "start", "--event-kind", "cron.tick"] },
      { args: ["--status", "paused"] },
    ],
    fields: {
      workflowId: {
        flag: "workflow",
        help: "Only the triggers of this workflow, by its id or a tail of eight or more characters.",
        resolves: "workflow.query",
      },
      kind: {
        flag: "kind",
        help: "start for triggers that start runs, signal for triggers that resume a live run.",
      },
      eventKind: {
        flag: "event-kind",
        help: "Only the triggers on this event kind, such as cron.tick or github.pr.labeled.",
      },
      status: {
        flag: "status",
        help: "Only start triggers that are active or paused; signal triggers have no status.",
      },
    },
  },

  "workflowAction.query": {
    command: "workflow-action list",
    help: "Lists every action a workflow step can call right now, with the params each one takes. An optional param ends in ?, and --json prints the params as JSON Schema. A built-in action has the id of the operation it calls. A plugin's action is named <plugin>/<word>, and is listed only while the plugin is running.",
    examples: [{ args: [] }, { args: ["--json"] }],
    fields: {},
  },

  "eventKind.query": {
    command: "event-kind list",
    help: "Lists every event kind a workflow trigger can listen for right now. A kind that needs a Connection comes from a plugin, and a trigger on it sets a Connection id or any; a trigger on a core kind sets no Connection. A plugin's kinds are listed only while the plugin is running.",
    examples: [{ args: [] }],
    fields: {},
  },

  "run.start": {
    command: "run start",
    help: "Starts a run and prints its id at once, without waiting for any step. Name a stored workflow with --workflow, or pipe a workflow's YAML with --source-stdin to run it once without storing it, for example to try it before saving it. The workflow is checked first, and so are the inputs: a problem is printed one line per error, each giving its path, and no run is started. A disabled workflow can still be run by hand. Follow the run with `hercule run read <id>`.",
    examples: [
      { args: ["--workflow", "1f3a9c2e"] },
      { args: ["--workflow", "1f3a9c2e", "--inputs", '{"title":"Fix login"}'] },
      {
        args: ["--source-stdin", "--inputs", '{"title":"Fix login"}'],
        stdin: [
          "name: File a task",
          "inputs:",
          "  - name: title",
          "    schema: { type: string }",
          "    required: true",
          "steps:",
          "  - id: file_task",
          "    kind: action",
          "    action: task.create",
          "    params:",
          '      title: "{{ inputs.title }}"',
          "      description: Filed by a workflow that was never stored.",
        ].join("\n"),
      },
    ],
    fields: {
      workflowId: {
        flag: "workflow",
        help: "The stored workflow to run, by its id or a tail of eight or more characters. Give this or --source-stdin, not both.",
        resolves: "workflow.query",
      },
      source: {
        stdin: true,
        flag: "source",
        help: "A workflow's YAML source to run once. It is validated like a save and never stored.",
      },
      // The `definition` object is for programs that build a workflow in code.
      // On the command line a workflow is always YAML text read from stdin.
      definition: { hidden: true },
      inputs: {
        flag: "inputs",
        help: "A JSON object with a value for each input the workflow declares, by name; an input left out takes its default.",
      },
    },
    errors: {
      validation:
        "the workflow is not valid, or an input is unknown, missing or has the wrong value: each printed line gives the path and the problem; no run was started",
      cap_exceeded:
        "the run would be nested deeper than the controller's run.nestingLimit setting; no run was started",
    },
  },
  "run.query": {
    command: "run list",
    help: "Lists runs, newest first. Each row shows the run's status, its workflow, who started it, and its age. Use it to find the id that `hercule run read` and `hercule run cancel` take.",
    examples: [
      { args: [] },
      { args: ["--status", "failed"] },
      { args: ["--workflow", "1f3a9c2e", "--since", "2026-09-24T00:00:00.000Z"] },
    ],
    fields: {
      workflowId: {
        flag: "workflow",
        help: "Only the runs of this workflow, by its id or a tail of eight or more characters.",
        resolves: "workflow.query",
      },
      status: {
        flag: "status",
        help: "Only runs with this status: pending, running, completed, failed or cancelled.",
      },
      since: {
        flag: "since",
        help: "Only runs created at or after this UTC instant, with milliseconds: 2026-09-24T00:00:00.000Z.",
      },
      until: {
        flag: "until",
        help: "Only runs created at or before this UTC instant, with milliseconds.",
      },
      actor: {
        flag: "actor",
        help: "Only runs started by this actor: user, session:<id>, or run:<id> for the runs a run started.",
      },
    },
  },
  "run.read": {
    command: "run read",
    help: "Shows one run: its status, why it failed if it did, and what each step did. A run that failed at an edge names the edge. The output lists the inputs the run started with, the run's output when a terminal step ended it, and one line per step record with its status, how long it took and its error; when a step ran more than once, each line also shows its iteration. --json prints the whole record, including the frozen workflow definition and every step's output.",
    examples: [{ args: ["1f3a9c2e"] }, { args: ["1f3a9c2e", "--json"] }],
    fields: {
      id: {
        positional: true,
        help: "The run's id, or a tail of eight or more characters.",
        resolves: "run.query",
      },
    },
  },
  "run.cancel": {
    command: "run cancel",
    help: "Cancels a run that is pending or running. The step running now is cancelled with it, and no later step starts. What a finished step did stays done. Check the result with `hercule run read`.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The run's id, or a tail of eight or more characters.",
        resolves: "run.query",
      },
    },
    errors: {
      invalid_state: "the run has already completed, failed or been cancelled",
    },
  },

  "runner.query": {
    command: "runner list",
    help: "Lists the fleet: every Runner enrolled with this controller, by name. Each row shows whether the controller can reach the machine, and its lifecycle state. Use it to find the id the other `hercule runner` commands take.",
    examples: [{ args: [] }, { args: ["--connectivity", "online", "--lifecycle", "active"] }],
    fields: {
      connectivity: {
        flag: "connectivity",
        help: "Whether the controller can reach the machine; only the runner's connection sets it.",
      },
      lifecycle: {
        flag: "lifecycle",
        help: "The machine's lifecycle state, set by its owner; it changes independently of connectivity.",
      },
      label: { flag: "label", help: "Only runners carrying this placement label." },
    },
  },
  "runner.read": {
    command: "runner read",
    help: "Reads one runner in full: its Runner Facts and the capabilities it negotiated. Its disk watermark and its session cap come with it.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The runner's id, or a tail of eight or more characters.",
        resolves: "runner.query",
      },
    },
  },
  "runner.update": {
    command: "runner update",
    help: "Edits the parts of a runner its owner controls. These are its name, its labels, its session cap, its disk watermark and whether it is reserved. Everything else on the row is reported by the machine itself, and trying to set it is rejected rather than ignored.",
    examples: [
      { args: ["1f3a9c2e", "--max-sessions", "4"] },
      { args: ["1f3a9c2e", "--label", "macos", "--label", "gpu", "--reserved", "true"] },
    ],
    fields: {
      id: {
        positional: true,
        help: "The runner's id, or a tail of eight or more characters.",
        resolves: "runner.query",
      },
      name: { flag: "name", help: "The name `hercule runner list` shows for this machine." },
      labels: {
        flag: "label",
        help: "A placement label. The list is replaced whole, so send every label the machine is to keep.",
      },
      maxConcurrentSessions: {
        flag: "max-sessions",
        help: "How many sessions this machine hosts at once, overriding the cap derived from its facts.",
      },
      diskWatermarkBytes: {
        flag: "disk-watermark-bytes",
        help: "The free-disk floor in whole bytes, overriding the shipped ten gibibytes.",
      },
      reserved: {
        flag: "reserved",
        help: "true means placement never chooses it; only work that asks for this runner by id runs here.",
      },
    },
  },
  "runner.drain": {
    command: "runner drain",
    help: "Stops new sessions landing on a runner while the ones already there finish. Use it before maintenance; `hercule runner undrain` puts the machine back in rotation.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The runner's id, or a tail of eight or more characters.",
        resolves: "runner.query",
      },
    },
  },
  "runner.undrain": {
    command: "runner undrain",
    help: "Puts a draining runner back in rotation, so placement may choose it again.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The runner's id, or a tail of eight or more characters.",
        resolves: "runner.query",
      },
    },
  },
  "runner.retire": {
    command: "runner retire",
    help: "Takes a runner out of the fleet for good; nothing is ever placed on it again. Drain it first with `hercule runner drain` so its sessions finish.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The runner's id, or a tail of eight or more characters.",
        resolves: "runner.query",
      },
      force: {
        flag: "force",
        help: "true retires a machine the controller cannot account for, whose sessions nobody can see the end of.",
      },
    },
  },
  "runner.probe": {
    command: "runner probe",
    help: "Probes one Provider Instance on a runner and returns a fresh Capability Snapshot. The snapshot holds its auth state, harness version and model catalog. Use it when a spawn failed because no machine was logged in.",
    examples: [{ args: ["1f3a9c2e", "--instance", "7b41d0a5"] }],
    fields: {
      id: {
        positional: true,
        help: "The runner's id, or a tail of eight or more characters.",
        resolves: "runner.query",
      },
      instanceId: {
        flag: "instance",
        help: "The Provider Instance to probe, by full id; find it with `hercule provider list`.",
      },
    },
  },
  "runner.refreshFacts": {
    command: "runner refresh-facts",
    help: "Re-probes a runner's facts now instead of waiting for the hourly refresh. The facts are its OS, architecture, RAM, toolchains and which provider CLIs are on its PATH. Returns the runner with the facts it just reported.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The runner's id, or a tail of eight or more characters.",
        resolves: "runner.query",
      },
    },
  },
  "runner.installHarness": {
    command: "runner install-harness",
    help: "Installs a provider's harness binary on a runner. Use it when `hercule runner read` shows the provider missing from the machine's facts; the returned facts are refreshed.",
    examples: [{ args: ["1f3a9c2e", "--provider", "claude-code"] }],
    fields: {
      id: {
        positional: true,
        help: "The runner's id, or a tail of eight or more characters.",
        resolves: "runner.query",
      },
      providerId: {
        flag: "provider",
        help: "Which harness to install, by provider id such as claude-code or codex; not an instance id.",
      },
    },
  },
  "runner.createJoinToken": {
    command: "runner join-token create",
    help: "Creates the one-time token a new machine enrols with, shown here and nowhere else. Run it before starting the runner daemon on that machine; `hercule runner join-token list` afterwards shows whether the invitation is still open.",
    examples: [{ args: [] }],
    fields: {},
  },
  "runner.queryJoinTokens": {
    command: "runner join-token list",
    help: "Lists the join tokens still outstanding: which invitations are open and when each runs out. Neither the token nor its hash is here.",
    examples: [{ args: [] }],
    fields: {},
  },
  "runner.revokeJoinToken": {
    command: "runner join-token revoke",
    help: "Revokes an outstanding join token, so the invitation can no longer be spent. Find the id with `hercule runner join-token list`.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The join token's id, or a tail of eight or more characters.",
        resolves: "runner.queryJoinTokens",
      },
    },
  },

  "plugin.query": {
    command: "plugin list",
    help: "Lists every plugin this binary was built with. Each row shows whether the user enabled the plugin, and what happened to it when this controller started. The set is fixed at build time, so this is the whole of it.",
    examples: [{ args: [] }],
    fields: {},
  },
  "plugin.read": {
    command: "plugin read",
    help: "Reads one plugin in full: its capabilities, contributions, stored config and config schema. A settings form is generated from that schema; a refused plugin has none, and its status gives the reason.",
    examples: [{ args: ["github"] }],
    fields: {
      id: {
        positional: true,
        help: "The plugin's id as its manifest declares it, such as github; a name, never a UUID and never a tail.",
      },
    },
  },
  "plugin.enable": {
    command: "plugin enable",
    help: "Enables a plugin and starts it, so its contributions register. The decision is stored and survives a restart; the reply shows whether the plugin started.",
    examples: [{ args: ["github"] }],
    fields: {
      id: {
        positional: true,
        help: "The plugin's id as its manifest declares it, such as github; a name, never a UUID and never a tail.",
      },
    },
  },
  "plugin.disable": {
    command: "plugin disable",
    help: "Stops a plugin and marks it disabled, so its contributions are gone until it is enabled again. Connections and events of its types stop with it, so check `hercule connection list` first.",
    examples: [{ args: ["github"] }],
    fields: {
      id: {
        positional: true,
        help: "The plugin's id as its manifest declares it, such as github; a name, never a UUID and never a tail.",
      },
    },
  },
  "plugin.retry": {
    command: "plugin retry",
    help: "Starts an errored plugin over without restarting the controller. Only a plugin whose status is errored can be retried; any other status is rejected.",
    examples: [{ args: ["github"] }],
    fields: {
      id: {
        positional: true,
        help: "The plugin's id as its manifest declares it, such as github; a name, never a UUID and never a tail.",
      },
    },
  },
  "plugin.resetState": {
    command: "plugin reset-state",
    help: "Throws away everything a plugin stored and starts it over. Use it when leftover state is the likely cause of a plugin stuck in errored or inactive; what it stored is deleted for good.",
    examples: [{ args: ["github"] }],
    fields: {
      id: {
        positional: true,
        help: "The plugin's id as its manifest declares it, such as github; a name, never a UUID and never a tail.",
      },
    },
  },
  "plugin.configure": {
    command: "plugin configure",
    help: "Stores a plugin's config and restarts it on the new one. There is no hot reconfigure, so a plugin never sees its config change under it. The config is a JSON object, validated before anything restarts, so a rejected one leaves a running plugin running. `hercule plugin read` shows the schema it must match.",
    examples: [{ args: ["github"], stdin: '{"appId":"1234","pollSeconds":60}' }],
    fields: {
      id: {
        positional: true,
        help: "The plugin's id as its manifest declares it, such as github; a name, never a UUID and never a tail.",
      },
      config: {
        stdin: true,
        flag: "config",
        help: "The whole config as a JSON object, validated against the plugin's own schema.",
      },
    },
  },

  "provider.query": {
    command: "provider list",
    help: "Lists the Provider Instances: one row per account of a provider. Each has its own config and its own vendor login. Placement and spawning route on the instance id, never on the provider id.",
    examples: [{ args: [] }],
    fields: {},
  },
  "provider.read": {
    command: "provider read",
    help: "Reads one Provider Instance in full, with the Capability Snapshot each runner reported for it. A snapshot is auth state, harness version and model catalog.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The instance's id, or a tail of eight or more characters.",
        resolves: "provider.query",
      },
    },
  },
  "provider.create": {
    command: "provider create",
    help: "Opens a Provider Instance: one account of one provider, with its own provider home on every runner. The config is a JSON object validated against the provider's own schema. Log the new instance in on a machine with `hercule provider login`.",
    examples: [{ args: ["--provider", "claude-code", "--name", "work"], stdin: "{}" }],
    fields: {
      providerId: {
        flag: "provider",
        help: "Which provider to open an account of, by provider id such as claude-code or codex.",
      },
      name: {
        flag: "name",
        help: "What to call this account, so a chooser can tell two of them apart.",
      },
      config: {
        stdin: true,
        flag: "config",
        help: "The instance's config as a JSON object; send {} for none.",
      },
    },
  },
  "provider.update": {
    command: "provider update",
    help: "Edits a Provider Instance; a field you leave out is not changed. The config goes inline here as JSON, because it is one value beside the name rather than the whole payload.",
    examples: [{ args: ["1f3a9c2e", "--name", "personal"] }],
    fields: {
      id: {
        positional: true,
        help: "The instance's id, or a tail of eight or more characters.",
        resolves: "provider.query",
      },
      name: { flag: "name", help: "A new name for the instance." },
      config: {
        flag: "config",
        help: "A replacement config as inline JSON, validated against the provider's own schema.",
      },
    },
  },
  "provider.delete": {
    command: "provider delete",
    help: "Deletes a Provider Instance. Nothing can be spawned on it afterwards, so open its replacement with `hercule provider create` before deleting the last account of a provider.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The instance's id, or a tail of eight or more characters.",
        resolves: "provider.query",
      },
    },
  },
  "provider.login": {
    command: "provider login",
    help: "Starts the vendor login for a Provider Instance on one machine. Returns the URL to open, and the code the harness printed if there is one. A vendor credential belongs to exactly one machine, because two live copies of one login rotate each other out. Finish it with `hercule provider submit-login-code`.",
    examples: [{ args: ["1f3a9c2e", "--runner", "7b41d0a5"] }],
    fields: {
      id: {
        positional: true,
        help: "The instance's id, or a tail of eight or more characters.",
        resolves: "provider.query",
      },
      runnerId: {
        flag: "runner",
        help: "Which machine the login runs on, by its full id.",
      },
    },
  },
  "provider.submitLoginCode": {
    command: "provider submit-login-code",
    help: "Sends the code the browser showed, finishing what `hercule provider login` started. Returns a fresh Capability Snapshot for that machine, which shows whether the instance is usable there.",
    examples: [{ args: ["1f3a9c2e", "--runner", "7b41d0a5", "--code", "ABCD-1234"] }],
    fields: {
      id: {
        positional: true,
        help: "The instance's id, or a tail of eight or more characters.",
        resolves: "provider.query",
      },
      runnerId: { flag: "runner", help: "The same machine the login was started on." },
      code: { flag: "code", help: "The code the browser showed; one line, no newlines." },
    },
  },

  "connection.query": {
    command: "connection list",
    help: "Lists external-account connections Hercule acts through, with each status. Use it to find the id that an event's connection refers to.",
    examples: [{ args: [] }, { args: ["--status", "needs-reauth"] }],
    fields: {
      type: {
        flag: "type",
        help: "Only connections of this type, by its Qualified Id such as gmail/gmail.",
      },
      status: {
        flag: "status",
        help: "The account's status; look for needs-reauth when events stopped arriving.",
      },
    },
  },
  "connection.read": {
    command: "connection read",
    help: "Reads one Connection in full: its account, its status and its topics. The names of the secrets it owns come with it.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The connection's id, or a tail of eight or more characters.",
        resolves: "connection.query",
      },
    },
  },
  "connection.create": {
    command: "connection create",
    help: "Creates a Connection from credentials you already hold. The credentials are a JSON object keyed by the field names the type declares, and are never readable again. For an account reached through a browser, use `hercule connection start-oauth` instead.",
    examples: [
      {
        args: ["--type", "github/github", "--label", "work", "--topic", "engineering"],
        stdin: '{"pat":"ghp_xxx"}',
      },
    ],
    fields: {
      type: {
        flag: "type",
        help: "The connection type as a Qualified Id, such as github/github; take it from the plugin catalog and never parse it.",
      },
      label: { flag: "label", help: "What to call this account: work, personal." },
      labels: {
        flag: "topic",
        help: "A Topic this connection's events file into. The first one given is its default, and at least one is required.",
      },
      config: {
        flag: "config",
        help: "The connection's own config as inline JSON, validated against the type's declared schema.",
      },
      credentials: {
        stdin: true,
        flag: "credentials",
        help: "The credential values as a JSON object keyed by the type's field names.",
      },
    },
  },
  "connection.update": {
    command: "connection update",
    help: "Edits what the user chose about a Connection: its label, its topics, its config. Never the account behind it. Rotate credentials with `hercule connection set-credentials`.",
    examples: [{ args: ["1f3a9c2e", "--label", "personal"] }],
    fields: {
      id: {
        positional: true,
        help: "The connection's id, or a tail of eight or more characters.",
        resolves: "connection.query",
      },
      label: { flag: "label", help: "A new name for this account." },
      labels: {
        flag: "topic",
        help: "A Topic to file its events into. The list is replaced whole, so send every topic it is to keep.",
      },
      config: { flag: "config", help: "A replacement config as inline JSON." },
    },
  },
  "connection.delete": {
    command: "connection delete",
    help: "Deletes a Connection and the secrets it owns. Event ingest for that account stops, and nothing can act as it afterwards.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The connection's id, or a tail of eight or more characters.",
        resolves: "connection.query",
      },
    },
  },
  "connection.setCredentials": {
    command: "connection set-credentials",
    help: "Rotates a Connection's credentials in place, leaving everything else about it alone. Reach for it when `hercule connection list` shows the account needs reauth. The new values are a JSON object keyed by the type's field names.",
    examples: [{ args: ["1f3a9c2e"], stdin: '{"token":"ghp_yyy"}' }],
    fields: {
      id: {
        positional: true,
        help: "The connection's id, or a tail of eight or more characters.",
        resolves: "connection.query",
      },
      credentials: {
        stdin: true,
        flag: "credentials",
        help: "The replacement values as a JSON object keyed by the type's field names.",
      },
    },
  },
  "connection.startOAuth": {
    command: "connection start-oauth",
    help: "Starts a redirect flow and returns the authorization URL to open in a browser. The connection exists only once the provider sends the browser back. The redirect URI is built from --origin, so it must match the one registered with the provider byte for byte. Give --connection to reconnect an existing account instead of creating a second one.",
    examples: [
      {
        args: [
          "--type",
          "gmail/gmail",
          "--origin",
          "https://hercule.example",
          "--label",
          "work",
          "--topic",
          "inbox",
        ],
      },
      {
        args: [
          "--type",
          "gmail/gmail",
          "--origin",
          "https://hercule.example",
          "--connection",
          "1f3a9c2e",
        ],
      },
    ],
    fields: {
      type: { flag: "type", help: "The connection type as a Qualified Id, such as gmail/gmail." },
      origin: {
        flag: "origin",
        help: "Where the browser is: scheme and host with no path, like https://hercule.example.",
      },
      label: { flag: "label", help: "What to call the new account; a reconnect already has one." },
      labels: {
        flag: "topic",
        help: "A Topic the new account's events file into. A reconnect already has its own and needs none.",
      },
      config: { flag: "config", help: "The new account's config as inline JSON." },
      connectionId: {
        flag: "connection",
        help: "The Connection whose tokens this flow replaces; leave it off to create one.",
      },
    },
    errors: {
      invalid_state:
        "the plugin that owns this type has no OAuth client credentials; set them in settings first",
    },
  },

  "agent.query": {
    command: "agent list",
    help: "Lists the Agents sessions are spawned from. An Agent is a named, reusable configuration for unattended work. Use it to find the id that `hercule session spawn --agent` takes.",
    examples: [{ args: [] }, { args: ["--profile", "1f3a9c2e"] }],
    fields: {
      permissionProfileId: {
        flag: "profile",
        help: "Only the Agents that spawn their sessions under this Permission Profile, by its id or a tail of eight or more characters; use it to find which Agents stop a profile from being deleted.",
        resolves: "profile.query",
      },
    },
  },
  "agent.read": {
    command: "agent read",
    help: "Reads one Agent in full: its prompt, where it runs and what it may do. It also shows which of those fields its provider does not enforce.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The agent's id, or a tail of eight or more characters.",
        resolves: "agent.query",
      },
    },
  },
  "agent.create": {
    command: "agent create",
    help: "Creates an Agent: a named configuration sessions are spawned from. Its values are copied onto each session at spawn, so editing it later changes nothing that is already running. The system prompt is read from stdin.",
    examples: [
      {
        args: ["--name", "assessor", "--instance", "7b41d0a5", "--profile", "1f3a9c2e"],
        stdin: "You assess incoming tasks and decide whether to accept them.",
      },
      {
        args: [
          "--name",
          "assessor",
          "--instance",
          "7b41d0a5",
          "--profile",
          "1f3a9c2e",
          "--access-mode",
          "auto-accept-edits",
          "--model",
          "opus",
          "--options",
          '{"effort":"high"}',
          "--disallowed-tool",
          "edit",
          "--disallowed-tool",
          "shell",
        ],
        stdin: "You assess incoming tasks and decide whether to accept them.",
      },
    ],
    fields: {
      name: { flag: "name", help: "What to call the agent; it is how a person finds it again." },
      systemPrompt: {
        stdin: true,
        flag: "system-prompt",
        help: "The instructions every session spawned from this agent starts with; appended to the harness's own.",
      },
      instanceId: {
        flag: "instance",
        help: "The Provider Instance its sessions run on, by its id or a tail of eight or more characters.",
        resolves: "provider.query",
      },
      permissionProfileId: {
        flag: "profile",
        help: "The Permission Profile its sessions' tokens carry, by its id or a tail of eight or more characters.",
        resolves: "profile.query",
      },
      accessMode: {
        flag: "access-mode",
        help: "What its sessions may do unasked; leave it off for full access, which is what unattended work needs.",
      },
      model: {
        flag: "model",
        help: "The model its sessions open on, by its slug; leave it off to run on whatever the instance offers by default.",
      },
      options: {
        flag: "options",
        help: "The choices that model opens with, as inline JSON; not allowed without --model, because a choice belongs to the model that offers it.",
      },
      disallowedTools: {
        flag: "disallowed-tool",
        help: "A tool family to take away: edit, write, shell, web-search or web-fetch; repeatable. If the provider enforces none of them, the reply shows that.",
      },
    },
  },
  "agent.update": {
    command: "agent update",
    help: "Edits an Agent; a field you leave out is not changed. Sessions already spawned keep the values they were given.",
    examples: [
      { args: ["1f3a9c2e", "--access-mode", "auto"] },
      { args: ["1f3a9c2e", "--model", "sonnet", "--options", '{"effort":"high"}'] },
      { args: ["1f3a9c2e", "--disallowed-tool", "shell"] },
      {
        args: ["1f3a9c2e", "--system-prompt-stdin"],
        stdin: "You assess incoming tasks, and you are strict about it.",
      },
    ],
    fields: {
      id: {
        positional: true,
        help: "The agent's id, or a tail of eight or more characters.",
        resolves: "agent.query",
      },
      name: { flag: "name", help: "A new name for the agent." },
      systemPrompt: {
        stdin: true,
        flag: "system-prompt",
        help: "Replacement instructions, read from stdin only when --system-prompt-stdin asks for them.",
      },
      instanceId: {
        flag: "instance",
        help: "Run its sessions on this Provider Instance instead, by its id or a tail of eight or more characters.",
        resolves: "provider.query",
      },
      permissionProfileId: {
        flag: "profile",
        help: "Bind its sessions to this Permission Profile instead, by its id or a tail of eight or more characters; sessions already running keep theirs.",
        resolves: "profile.query",
      },
      accessMode: { flag: "access-mode", help: "What its sessions may do unasked." },
      model: {
        flag: "model",
        help: "The model its sessions open on instead, by its slug; it replaces the stored choices, so give --options with it to keep any. `null` puts it back on the instance default.",
      },
      options: {
        flag: "options",
        help: "The choices to open that model with, replacing the ones set now, as inline JSON; not allowed without --model, because a choice belongs to the model that offers it.",
      },
      disallowedTools: {
        flag: "disallowed-tool",
        help: "The tool families to take away, replacing the ones set now; repeatable.",
      },
    },
  },
  "agent.delete": {
    command: "agent delete",
    help: "Deletes an Agent. It fails while a session spawned from the agent is still running; sessions that have exited keep the agent's id as a record of where they came from.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The agent's id, or a tail of eight or more characters.",
        resolves: "agent.query",
      },
    },
    errors: {
      invalid_state:
        "a session spawned from this agent has not exited yet; the message includes its id, and `hercule session stop` ends it",
    },
  },

  "assistant.query": {
    command: "assistant list",
    help: "Lists the assistants, oldest first. An assistant is an Agent you talk to through a conversation, and it keeps one conversation per channel. Use it to find the id every other `hercule assistant` command takes.",
    examples: [{ args: [] }],
    fields: {},
  },
  "assistant.read": {
    command: "assistant read",
    help: "Reads one assistant in full: its prompt, where it runs, and how it wakes, rotates and replies.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        placeholder: "assistant-id",
        help: "The assistant's id, or a tail of eight or more characters.",
        resolves: "assistant.query",
      },
    },
  },
  "assistant.create": {
    command: "assistant create",
    help: "Creates an assistant and its web conversation. Only --name is required; every other field left out takes the default the reply shows.",
    examples: [
      { args: ["--name", "Ada"] },
      {
        args: [
          "--name",
          "Ada",
          "--instance",
          "7b41d0a5",
          "--reply",
          "segments",
          "--heartbeat",
          '{"enabled":true,"schedule":"0 9 * * 1-5","prompt":"Check in.","target":"web"}',
        ],
        stdin: "You are Ada, a patient helper.",
      },
    ],
    fields: {
      name: {
        flag: "name",
        help: "What to call the assistant; it is how a person finds it again.",
      },
      systemPrompt: {
        stdin: true,
        flag: "system-prompt",
        help: "The assistant's system prompt, read from stdin only when --system-prompt-stdin asks for it; leave it off for the default system prompt.",
      },
      instanceId: {
        flag: "instance",
        help: "The Provider Instance its sessions run on, by its id or a tail of eight or more characters; leave it off for the oldest instance of a provider this build carries.",
        resolves: "provider.query",
      },
      permissionProfileId: {
        flag: "profile",
        help: "The Permission Profile its sessions' tokens carry, by its id or a tail of eight or more characters; leave it off for the shipped assistant profile.",
        resolves: "profile.query",
      },
      accessMode: {
        flag: "access-mode",
        help: "What its sessions may do unasked; leave it off for full access.",
      },
      model: {
        flag: "model",
        help: "The model its sessions open on, by its slug; leave it off to run on whatever the instance offers by default.",
      },
      options: {
        flag: "options",
        help: "The choices that model opens with, as inline JSON; not allowed without --model, because a choice belongs to the model that offers it.",
      },
      disallowedTools: {
        flag: "disallowed-tool",
        help: "A tool family to take away: edit, write, shell, web-search or web-fetch; repeatable. Leave it off to take away edit only.",
      },
      heartbeat: {
        flag: "heartbeat",
        help: "When it wakes by itself and what it is told then, as inline JSON with enabled, schedule, prompt and target; leave it off to wake every hour from 07:00 to 23:00 (0 7-23 * * *) in your timezone, in the web chat.",
      },
      rotation: {
        flag: "rotation",
        help: "When its conversation moves to a fresh session, as inline JSON with contextFraction, maxContextTokens and dailyAt; leave it off to move at 70% of the context window, at 200000 tokens, or daily at 04:00, whichever comes first.",
      },
      reply: {
        flag: "reply",
        help: "Which of its words reach the conversation: turn-end for the last text of each turn, or segments for every text as it goes; leave it off for turn-end.",
      },
    },
    errors: {
      invalid_state:
        "there is no provider instance to run the assistant on, so add one with `hercule provider create`; or the shipped assistant profile was renamed, so name a profile with --profile",
    },
  },
  "assistant.update": {
    command: "assistant update",
    help: "Edits an assistant; a field you leave out is not changed. The next session it starts uses the new values.",
    examples: [
      { args: ["1f3a9c2e", "--reply", "segments"] },
      {
        args: ["1f3a9c2e", "--system-prompt-stdin"],
        stdin: "You are Ada, a patient helper who answers briefly.",
      },
    ],
    fields: {
      id: {
        positional: true,
        placeholder: "assistant-id",
        help: "The assistant's id, or a tail of eight or more characters.",
        resolves: "assistant.query",
      },
      name: { flag: "name", help: "A new name for the assistant." },
      systemPrompt: {
        stdin: true,
        flag: "system-prompt",
        help: "A replacement system prompt, read from stdin only when --system-prompt-stdin asks for it.",
      },
      instanceId: {
        flag: "instance",
        help: "Run its sessions on this Provider Instance instead, by its id or a tail of eight or more characters.",
        resolves: "provider.query",
      },
      permissionProfileId: {
        flag: "profile",
        help: "Bind its sessions to this Permission Profile instead, by its id or a tail of eight or more characters.",
        resolves: "profile.query",
      },
      accessMode: { flag: "access-mode", help: "What its sessions may do unasked." },
      model: {
        flag: "model",
        help: "The model its sessions open on instead, by its slug; it replaces the stored choices, so give --options with it to keep any. `null` puts it back on the instance default.",
      },
      options: {
        flag: "options",
        help: "The choices to open that model with, replacing the ones set now, as inline JSON; not allowed without --model, because a choice belongs to the model that offers it.",
      },
      disallowedTools: {
        flag: "disallowed-tool",
        help: "The tool families to take away, replacing the ones set now; repeatable.",
      },
      heartbeat: {
        flag: "heartbeat",
        help: "A replacement heartbeat, as inline JSON with enabled, schedule, prompt and target.",
      },
      rotation: {
        flag: "rotation",
        help: "A replacement rotation, as inline JSON with contextFraction, maxContextTokens and dailyAt.",
      },
      reply: {
        flag: "reply",
        help: "Which of its words reach the conversation: turn-end or segments.",
      },
    },
  },

  "assistant.delete": {
    command: "assistant delete",
    help: "Deletes an assistant, its conversations and their messages. A session still running for it is stopped first. Its sessions and their transcripts stay, and keep the assistant's id as a record of where they came from.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        placeholder: "assistant-id",
        help: "The assistant's id, or a tail of eight or more characters.",
        resolves: "assistant.query",
      },
    },
    errors: {
      invalid_state:
        "the assistant's session did not stop in time, so nothing was deleted; the message names its runner, and the delete can be tried again once that runner is reachable",
    },
  },

  "conversation.query": {
    command: "conversation list",
    help: "Lists conversations, oldest first. Each is one assistant's exchange in one channel; the web chat is the only channel so far.",
    examples: [{ args: [] }, { args: ["--assistant", "1f3a9c2e"] }],
    fields: {
      assistantId: {
        flag: "assistant",
        help: "Only the conversations of this assistant, by its id or a tail of eight or more characters.",
        resolves: "assistant.query",
      },
    },
  },
  "conversation.read": {
    command: "conversation read",
    help: "Reads one conversation: which assistant answers it, and in which channel.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        placeholder: "conversation-id",
        help: "The conversation's id, or a tail of eight or more characters.",
        resolves: "conversation.query",
      },
    },
  },
  "conversation.queryMessages": {
    command: "conversation message list",
    help: "Lists a conversation's messages, newest first. They are what the owner said, what the assistant answered, and any notice that it could not answer.",
    examples: [{ args: ["7b41d0a5"] }, { args: ["7b41d0a5", "--sort", "position:asc"] }],
    fields: {
      id: {
        positional: true,
        placeholder: "conversation-id",
        help: "The conversation's id, or a tail of eight or more characters.",
        resolves: "conversation.query",
      },
    },
  },
  "conversation.send": {
    command: "conversation send",
    help: "Sends a message to a conversation as its owner. The assistant answers in its session: one is started if none is running, and one that went idle is resumed. Prints the stored message; the answer arrives later, and `hercule conversation message list` shows it.",
    examples: [{ args: ["7b41d0a5"], stdin: "What is on my list for today?" }],
    fields: {
      id: {
        positional: true,
        placeholder: "conversation-id",
        help: "The conversation's id, or a tail of eight or more characters.",
        resolves: "conversation.query",
      },
      text: { stdin: true, flag: "text", help: "The message to send." },
    },
    errors: {
      forbidden:
        "only a user credential may send: the message is recorded as the owner's, so an agent's session token is refused",
      invalid_state:
        "no runner can start the assistant's session; the error message gives the reason, such as no connected runner being logged in to its provider instance",
    },
  },

  "session.query": {
    command: "session list",
    help: "Lists sessions, newest first: each is a provider-backed agent at work, or one that has ended. Use it to find the id every other `hercule session` command takes.",
    examples: [
      { args: [] },
      { args: ["--status", "busy", "--status", "idle"] },
      { args: ["--thread", "true"] },
      { args: ["--conversation", "7b41d0a5", "--limit", "1"] },
    ],
    fields: {
      status: { flag: "status", help: "queued, starting, idle, busy or exited; repeatable." },
      runnerId: {
        flag: "runner",
        help: "Only sessions on this Runner, by its id or a tail of eight or more characters.",
        resolves: "runner.query",
      },
      agentId: {
        flag: "agent",
        help: "Only the sessions spawned from this Agent, by its id or a tail of eight or more characters; find it with `hercule agent list`.",
        resolves: "agent.query",
      },
      conversationId: {
        flag: "conversation",
        help: "Only the sessions of this conversation, by its id or a tail of eight or more characters; find it with `hercule conversation list`.",
        resolves: "conversation.query",
      },
      permissionProfileId: {
        flag: "profile",
        help: "Only the sessions carrying this Permission Profile, by its id or a tail of eight or more characters; use it to find which sessions stop a profile from being deleted.",
        resolves: "profile.query",
      },
      thread: {
        flag: "thread",
        help: "true for the sessions with no Agent behind them - the ones a person drives by hand - and false for the rest.",
      },
    },
  },
  "session.read": {
    command: "session read",
    help: "Reads one session: its status, what it runs under, and whether it can be resumed. The Request it is parked on comes with it, if there is one; answer that Request with `hercule session respond`.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
    },
  },
  "session.spawn": {
    command: "session spawn",
    help: "Starts a session, from an Agent or as a Thread the user drives by hand. With `--agent` every value comes from that Agent; without one it is a Thread and the values come from the user's thread settings. Either way, a flag given here takes precedence. Returns the session's id; read what it has done so far with `hercule transcript read <id>` and send the next turn with `hercule session input`.",
    examples: [
      { args: [], stdin: "Look at the failing login test and tell me what you find." },
      {
        args: [
          "--agent",
          "1f3a9c2e-0000-7000-8000-000000000001",
          "--output-schema",
          '{"type":"object","additionalProperties":false,"required":["verdict"],"properties":{"verdict":{"type":"string","enum":["accept","dismiss"]}}}',
        ],
        stdin: "Assess this task: 'Fix a typo in the README'.",
      },
      {
        args: ["--instance", "7b41d0a5", "--access-mode", "auto-accept-edits"],
        stdin: "Bring the changelog up to date.",
      },
      {
        args: [
          "--project",
          "1f3a9c2e",
          "--workspace",
          '{"kind":"primary","resourceId":"7b41d0a5-0000-7000-8000-000000000001","branch":"main"}',
        ],
        stdin: "Bring the changelog up to date in the repo I work in.",
      },
      {
        args: [
          "--workspace",
          '{"kind":"ephemeral","checkouts":[{"resourceId":"7b41d0a5-0000-7000-8000-000000000001","baseBranch":"main"},{"resourceId":"7b41d0a5-0000-7000-8000-000000000002"}]}',
        ],
        stdin: "Move the shared type into the api repo and update the web one.",
      },
      {
        args: [
          "--workspace",
          '{"kind":"existing","workspaceId":"7b41d0a5-0000-7000-8000-000000000003"}',
        ],
        stdin: "Carry on where the other thread left off.",
      },
    ],
    fields: {
      prompt: { stdin: true, flag: "prompt", help: "The opening prompt." },
      agentId: {
        flag: "agent",
        help: "The Agent to spawn from, by its id or a tail of eight or more characters; --instance and --profile are not allowed with it, because those come from the Agent.",
        resolves: "agent.query",
      },
      outputSchema: {
        flag: "output-schema",
        help: "What every turn must return, as an inline JSON Schema; a keyword outside the subset every harness supports is rejected, and the error names the keyword.",
      },
      instanceId: {
        flag: "instance",
        help: "The Provider Instance to run on, in place of the thread default, by its id or a tail of eight or more characters.",
        resolves: "provider.query",
      },
      model: { flag: "model", help: "The model to open with, in place of the thread default." },
      options: {
        flag: "options",
        help: "The per-model choices as inline JSON; a choice the model does not offer is rejected.",
      },
      accessMode: {
        flag: "access-mode",
        help: "What the provider adapter enforces for this session. A mode the provider does not support falls back to a less permissive one, never a more permissive one, and the reply shows which mode the session actually got.",
      },
      runnerId: {
        flag: "runner",
        help: "Run on this Runner, a reserved one included, by its id or a tail of eight or more characters; placement is skipped.",
        resolves: "runner.query",
      },
      permissionProfileId: {
        flag: "profile",
        help: "The Permission Profile the session's token carries, in place of the thread default, by its id or a tail of eight or more characters.",
        resolves: "profile.query",
      },
      projectId: {
        flag: "project",
        help: "The project the thread belongs to, by its id or a tail of eight or more characters; every repo in --workspace must be filed under it.",
        resolves: "project.query",
      },
      workspace: {
        flag: "workspace",
        help: 'Where it works, as JSON: {"kind":"primary","resourceId":"<id>","branch":"<branch>"} for the repo\'s main workspace, {"kind":"ephemeral","checkouts":[{"resourceId":"<id>","baseBranch":"<branch>"}]} for an ephemeral workspace with a checkout of its own (an empty list is a scratch workspace), or {"kind":"existing","workspaceId":"<id>"} to join one that already exists. Leave it off for a thread with no checkout.',
      },
    },
    errors: {
      unauthenticated: "user credential only: a session token is not allowed",
      invalid_state:
        "nothing can host it: no connected runner is logged in to that provider instance, or the runner you chose is draining or retired; check with `hercule runner list` and `hercule provider login`",
    },
  },
  "session.update": {
    command: "session update",
    help: "Changes what a session runs under from here on: its model and the per-model options. Options are merged into the ones it already runs with, unless --model changes the model: then the choices start empty, because they belong to the model that offered them.",
    examples: [{ args: ["1f3a9c2e", "--model", "claude-opus-4"] }],
    fields: {
      id: {
        positional: true,
        help: "The session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
      model: { flag: "model", help: "The model the session runs under from here on." },
      options: {
        flag: "options",
        help: "The per-model choices as inline JSON; they are merged into what is already set.",
      },
    },
    errors: { invalid_state: "that session has exited; there is nothing left to configure" },
  },
  "session.input": {
    command: "session input",
    help: "Sends one turn's input to a session. On an idle session it starts a turn; on any other it is queued. A session whose process is gone, but whose transcript is still on its runner, is resumed in place. Returns the input's id and what happened to it; while the row is still queued, `hercule input update` and `hercule input cancel` change it and `hercule input steer` folds it into the turn already running.",
    examples: [
      { args: ["1f3a9c2e"], stdin: "Carry on, and run the tests when you are done." },
      { args: ["1f3a9c2e", "--model", "claude-opus-4"], stdin: "Try that again with more care." },
    ],
    fields: {
      id: {
        positional: true,
        help: "The session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
      text: { stdin: true, flag: "text", help: "What to say to the session." },
      model: { flag: "model", help: "Switch the session to this model from this turn on." },
      options: {
        flag: "options",
        help: "The per-model choices as inline JSON, applied before the input is stored.",
      },
    },
    errors: {
      invalid_state:
        "the session cannot take it: it left no provider-native session to resume, or its runner is retired, draining or no longer connected",
    },
  },
  "session.interrupt": {
    command: "session interrupt",
    help: "Stops the turn a session is running and leaves the session alive. This is not steering: what was being done is abandoned. Nothing is waited for - what became of the turn arrives in the session's own stream.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
    },
    errors: { invalid_state: "that session has exited, or its runner is no longer connected" },
  },
  "session.respond": {
    command: "session respond",
    help: "Answers the Request a session is parked on with one of the four decisions. This is the only way to resolve an approval; free text never does. Read the open request first with `hercule session read`.",
    examples: [{ args: ["1f3a9c2e", "--request", "req_9c2e4f18", "--decision", "allow"] }],
    fields: {
      id: {
        positional: true,
        help: "The session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
      requestId: {
        flag: "request",
        help: "The open request's own id, as `hercule session read` reports it.",
      },
      decision: {
        flag: "decision",
        help: "The answer to the Request: allow_always keeps a rule for the rest of the session, and cancel denies the request and ends the turn.",
      },
    },
    errors: {
      invalid_state:
        "the session is not waiting on a decision, or the harness has moved on and this is not the request it is waiting on now; read it again with `hercule session read`",
    },
  },
  "session.stop": {
    command: "session stop",
    help: "Ends a session: the turn stops and the process goes away. Ending it is not final - a session whose transcript is still on its runner is resumed in place by the next `hercule session input`.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
    },
  },
  "session.continue": {
    command: "session continue",
    help: "Forks a session: opens a second provider-native session off the one the parent left behind. The parent's own transcript is untouched. It runs on the parent's runner and Provider Instance, because that is where the native state is, and returns a new session with its own id. To continue the parent itself instead, send it `hercule session input`.",
    examples: [
      {
        args: ["1f3a9c2e", "--mode", "fork"],
        stdin: "Take the same diagnosis and write the fix instead.",
      },
    ],
    fields: {
      id: {
        positional: true,
        help: "The parent session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
      mode: { flag: "mode", help: "The only mode is fork: the parent is left exactly as it is." },
      prompt: {
        stdin: true,
        flag: "prompt",
        help: "The opening prompt of the forked session.",
      },
    },
    errors: {
      unauthenticated: "user credential only: a session token is not allowed",
      invalid_state:
        "the parent is still live, or it left no provider-native session to fork from, or its runner is retired or draining; stop it first with `hercule session stop`",
    },
  },

  "input.query": {
    command: "input list",
    help: "Lists every input a session was given, oldest first, whatever became of each. The rows still queued are the ones `hercule input update`, `hercule input cancel` and `hercule input steer` can act on.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        placeholder: "session-id",
        help: "The session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
    },
  },
  "input.update": {
    command: "input update",
    help: "Rewrites a Queued Input before the controller delivers it. An input already sent or delivered cannot be rewritten; if the command fails, check its status with `hercule input list`.",
    examples: [
      {
        args: ["1f3a9c2e", "0193f3a9-2e5c-7b41-9a6d-1f3a9c2e77b0"],
        stdin: "Actually, start with the test that fails least often.",
      },
    ],
    fields: {
      id: {
        positional: true,
        placeholder: "session-id",
        help: "The session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
      inputId: {
        positional: true,
        help: "The input's full id, as `hercule input list` reports it; no tail is resolved here.",
      },
      text: { stdin: true, flag: "text", help: "The replacement text." },
    },
    errors: {
      invalid_state:
        "that input has already been sent to the runner, or was delivered or cancelled",
    },
  },
  "input.cancel": {
    command: "input cancel",
    help: "Cancels a Queued Input so it is never delivered. Only a row still waiting can be cancelled.",
    examples: [{ args: ["1f3a9c2e", "0193f3a9-2e5c-7b41-9a6d-1f3a9c2e77b0"] }],
    fields: {
      id: {
        positional: true,
        placeholder: "session-id",
        help: "The session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
      inputId: {
        positional: true,
        help: "The input's full id, as `hercule input list` reports it; no tail is resolved here.",
      },
    },
    errors: {
      invalid_state:
        "that input has already been sent to the runner, or was delivered or cancelled",
    },
  },
  "input.steer": {
    command: "input steer",
    help: "Delivers a Queued Input into the session's running turn now. It is folded into that turn instead of waiting for the turn to end. Only a busy session can be steered, and only where the provider supports it.",
    examples: [{ args: ["1f3a9c2e", "0193f3a9-2e5c-7b41-9a6d-1f3a9c2e77b0"] }],
    fields: {
      id: {
        positional: true,
        placeholder: "session-id",
        help: "The session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
      inputId: {
        positional: true,
        help: "The input's full id, as `hercule input list` reports it; no tail is resolved here.",
      },
    },
    errors: {
      invalid_state:
        "the session is not busy, its provider does not steer into a running turn, or the input is no longer waiting",
    },
  },

  "transcript.read": {
    command: "transcript read",
    help: "Reads what a session actually did: the normalized stream it left behind, one row per event. The rows are in order, each with its position. The transcript is append-only and read by position, so there is no filter and no search - the only choice is which end to start from.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        placeholder: "session-id",
        help: "The session's id, or a tail of eight or more characters.",
        resolves: "session.query",
      },
    },
  },

  "controller.read": {
    command: "controller read",
    help: "Reads the controller's own identity: its id, its version and the public key runners verify against. The Runner a placement falls back to comes with it.",
    examples: [{ args: [] }],
    fields: {},
    errors: { unauthenticated: "user credential only: a session token is not allowed" },
  },
  "controller.update": {
    command: "controller update",
    help: "Sets the Runner that placement falls back to when no runner is chosen. Find the id with `hercule runner list`; `null` removes the default, leaving placement with no fallback.",
    examples: [{ args: ["--default-runner", "1f3a9c2e"] }, { args: ["--default-runner", "null"] }],
    fields: {
      defaultRunnerId: {
        flag: "default-runner",
        help: "The runner to fall back to, by its full id; `null` clears it.",
      },
    },
    errors: { unauthenticated: "user credential only: a session token is not allowed" },
  },
} as const satisfies Record<OperationId, CliRow>;

/**
 * The root nouns, as the root help lists them and each noun's own help
 * starts. One entry per root noun of a visible command.
 */
export const NOUNS = {
  setup: { summary: "First-run setup: whether it is done, and finishing it." },
  "api-key": {
    summary: "Long-lived user credentials for scripts and operators.",
    flow: "hercule api-key create prints the token once; hercule api-key list finds a key later; hercule api-key revoke ends it.",
  },
  user: { summary: "The user's own credentials." },
  settings: { summary: "The controller's operational settings and the user's own preferences." },
  profile: {
    summary: "Permission Profiles: the named grant bundles a session's token carries.",
    flow: "hercule profile list to see what exists, hercule profile create for a new bundle, then pass it to hercule session spawn.",
  },
  secret: {
    summary:
      "Secret references owned by connections, plugins, runners and provider instances. Values can never be read back.",
  },
  task: {
    summary: "Tasks: units of human intent, work-type-agnostic and never executions themselves.",
    flow: "hercule task list to find work, hercule task read for the whole of one, hercule task create to record new intent, hercule task update as it moves.",
  },
  project: {
    summary: "Projects: groupings of related work and its materials. No behaviour, no defaults.",
  },
  resource: {
    summary: "Resources: the repos, folders and mailboxes projects work with.",
    flow: "hercule resource create records one, hercule resource list finds it again, then pass it to hercule workspace provision or hercule session spawn.",
  },
  workspace: {
    summary: "Workspaces: the working areas on a machine that sessions do their work in.",
    flow: "hercule workspace provision makes a repo's main workspace, hercule workspace list shows what exists, hercule workspace dispose tears an ephemeral one down.",
  },
  event: {
    summary: "The event log: external events and audit entries, in one format.",
    flow: "hercule event list to see what came in, hercule event read for one entry in full, hercule event emit to post one by hand, hercule event enrich to record what an entry is really about.",
  },
  subscription: {
    summary:
      "Subscriptions: the standing claims sessions hold on events that have not happened yet.",
    flow: "hercule subscription create starts a wait, hercule subscription list shows what a session waits on, hercule subscription cancel ends one.",
  },
  workflow: {
    summary:
      "Workflows: automations written as YAML - what starts them, the steps they run, and where those steps run.",
    flow: "hercule workflow validate checks a source from stdin, hercule workflow create stores one, hercule workflow read prints its source, hercule workflow update replaces the source or enables the workflow, hercule run start runs it, hercule workflow delete removes it.",
  },
  trigger: {
    summary:
      "Triggers: the parts of a workflow's source that decide which events start a run or resume one.",
  },
  "workflow-action": {
    summary: "Workflow actions: what an action step in a workflow can call.",
  },
  "event-kind": {
    summary: "Event kinds: the events a workflow trigger can listen for.",
  },
  run: {
    summary:
      "Runs: a workflow's steps carried out once, each run with a frozen copy of the workflow.",
    flow: "hercule run start starts one, hercule run list shows the latest, hercule run read shows how far one got, hercule run cancel stops one.",
  },
  runner: {
    summary: "The fleet: the machines that host sessions on the controller's behalf.",
    flow: "hercule runner join-token create creates the invitation, hercule runner list shows the machine once it dials in, hercule runner drain and hercule runner retire take it out again.",
  },
  plugin: {
    summary:
      "The plugins this binary was built with: which are enabled, and what happened to each when the controller started.",
  },
  provider: {
    summary: "Provider Instances: the accounts of the coding harnesses sessions run on.",
    flow: "hercule provider create opens an account, hercule provider login and hercule provider submit-login-code log it in on a machine, hercule runner probe shows whether it is usable there.",
  },
  connection: {
    summary: "Connections: the named links to external accounts Hercule acts through.",
    flow: "hercule connection create for a pasted credential or hercule connection start-oauth for a browser flow, then hercule connection list to check its status and hercule connection set-credentials to rotate.",
  },
  agent: {
    summary: "Agents: the named configurations sessions are spawned from, to work unattended.",
    flow: "hercule agent create records one, hercule agent list finds it again, then hercule session spawn --agent runs it.",
  },
  assistant: {
    summary:
      "Assistants: Agents you talk to through conversations, each with a heartbeat, a rotation and a reply mode.",
    flow: "hercule assistant list to find one, hercule assistant read for the whole of it, hercule assistant create for a new one, hercule assistant update to change it.",
  },
  conversation: {
    summary: "Conversations: an assistant's exchange in one channel.",
  },
  session: {
    summary: "Sessions: provider-backed agents at work, resumable and forkable.",
    flow: "hercule session spawn starts one, hercule transcript read shows what it has done so far, hercule session input sends the next turn, hercule session respond answers what it is parked on, hercule session stop ends it.",
  },
  input: {
    summary: "The inputs a session was given, and the queued ones that can still be changed.",
    flow: "hercule input list to see them, then hercule input update, hercule input cancel or hercule input steer while a row is still queued.",
  },
  transcript: { summary: "What a session did: its normalized stream, read back in order." },
  controller: {
    summary: "The controller's own identity, and the default runner that placement falls back to.",
  },
} as const satisfies Record<string, NounRow>;
