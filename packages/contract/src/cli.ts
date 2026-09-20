/**
 * The CLI table.
 *
 * One row per operation: how the `hercule` CLI spells the command, what the
 * command is for, worked examples, and one line of help per field. The CLI
 * derives its whole command tree, its argument parsing and its help from this
 * table plus the operation's schemas, so nothing per-operation lives in the CLI
 * package. `NOUNS` below carries the same for a root noun.
 *
 * Standing rule: an operation added to the contract lands its row here in the
 * same change - spelling, purpose, examples and a line per field, or
 * `hidden: true` with the reason in a comment. The row type is keyed by
 * operation id, so a contract without a row does not compile.
 *
 * The help is written for an agent reading it mid-task, not for a reference
 * manual: what the command does and when to reach for it, what comes back, and
 * what to call next by its exact spelling. A field's line is one line.
 */
import type { ErrorCode } from "./errors";
import type { OperationId } from "./operations";

/** One worked invocation: the tokens after the command words, and what is piped in. */
export interface CliExample {
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
}

/**
 * One field of an operation, as the command line takes it: a positional, a
 * flag, or a value read from stdin. A stdin field still names a flag, because
 * the marker that asks for it is `--<flag>-stdin`.
 */
export type FieldRow =
  | {
      readonly positional: true;
      readonly help: string;
      /**
       * What the placeholder is called in usage, where the field's own name
       * would not say whose id it is: the `id` of `/sessions/:id/inputs` is a
       * session's, so it is spelled `<session-id>`.
       */
      readonly placeholder?: string;
      /**
       * The listing an eight-character-or-longer tail is resolved through. A
       * positional without one takes the full id, and its line says so.
       */
      readonly resolves?: OperationId;
    }
  | {
      readonly flag: string;
      readonly help: string;
      /**
       * The listing that resolves a tail written for this flag, exactly as for
       * a positional. A tail is eight characters or more. Where the field
       * holds an id, the command line takes a tail and the wire takes the
       * full id.
       */
      readonly resolves?: OperationId;
    }
  | { readonly stdin: true; readonly flag: string; readonly help: string };

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
      /** Only where the code's generic meaning does not say enough here. */
      readonly errors?: Partial<Record<ErrorCode, string>>;
    };

/** A root noun, as the root help and the noun help introduce it. */
export interface NounRow {
  readonly summary: string;
  /** The usual order its verbs are called in, when the noun has one. */
  readonly flow?: string;
}

export const CLI = {
  "setup.read": {
    command: "setup read",
    help: "Says whether first-run setup has been completed. Reach for it when a controller may be brand new: until setup is done every other operation answers unauthenticated. Finish setup with `hercule setup complete`.",
    examples: [{ args: [] }],
    fields: {},
  },
  "setup.complete": {
    command: "setup complete",
    help: "Creates the one user and finishes first-run setup. Answers with the bearer token that user is logged in with, and takes the one-time setup token the controller printed at first boot, not a credential.",
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

  // The bearer `hercule login` trades for an API key. It is never shown, and a
  // second way to mint a bearer would be a second credential to look after.
  "auth.login": { hidden: true },
  // Revokes a bearer token, which the CLI never holds: it authenticates with an
  // API key or a session token.
  "auth.logout": { hidden: true },
  // The one-shot ticket the web app trades for a live socket. No terminal use.
  "auth.wsTicket": { hidden: true },

  "apiKey.query": {
    command: "api-key list",
    help: "Lists the user's API keys - references only, never the tokens. Use it to find the id of a key to revoke with `hercule api-key revoke`.",
    examples: [{ args: [] }],
    fields: {},
    errors: { unauthenticated: "user credential only: a session token is refused" },
  },
  "apiKey.create": {
    command: "api-key create",
    help: "Mints a long-lived user credential and prints its token once. The token is shown here and nowhere else, so capture it as you read it; every request it makes is the user's own identity.",
    examples: [{ args: ["--name", "ci-deploy"] }],
    fields: {
      name: { flag: "name", help: "What to call the key, so a later listing says what it is for." },
    },
    errors: { unauthenticated: "user credential only: a session token is refused" },
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
    errors: { unauthenticated: "user credential only: a session token is refused" },
  },

  "user.setPassword": {
    command: "user set-password",
    help: "Changes the user's password, verifying the current one first. A stolen token alone cannot take the account over.",
    examples: [{ args: [], stdin: "the-old-password\nthe-new-password" }],
    fields: {
      current: {
        stdin: true,
        flag: "current",
        help: "The password in force now.",
      },
      next: { stdin: true, flag: "next", help: "The password to set." },
    },
    errors: { unauthenticated: "user credential only: a session token is refused" },
  },

  "settings.read": {
    command: "settings read",
    help: "Reads every setting that is set, in both scopes. `controller` holds the controller's operational settings, `user` the user's own preferences. A key that is not set is absent rather than defaulted. Write with `hercule settings update`.",
    examples: [{ args: [] }],
    fields: {},
    errors: { unauthenticated: "user credential only: a session token is refused" },
  },
  "settings.update": {
    command: "settings update",
    help: "Sets settings in either scope; a key you do not name is left alone. Each flag takes a JSON object keyed by setting name, and an unknown key is refused rather than dropped.",
    examples: [
      { args: ["--user", '{"ui.threadRows":"plain"}'] },
      { args: ["--controller", '{"retention.events":30,"backup.time":"03:30"}'] },
    ],
    fields: {
      controller: {
        flag: "controller",
        help: "The controller's operational settings as a JSON object: retention, backup and session timeouts.",
      },
      user: {
        flag: "user",
        help: "The user's own settings as a JSON object: timezone, thread defaults, topic order, mutes.",
      },
    },
    errors: { unauthenticated: "user credential only: a session token is refused" },
  },

  "profile.query": {
    command: "profile list",
    help: "Lists the Permission Profiles a session can be spawned under, each with the Grants it carries. Use it to find the id `hercule session spawn --profile` names.",
    examples: [{ args: [] }],
    fields: {},
  },
  "profile.read": {
    command: "profile read",
    help: "Reads one Permission Profile in full: its name and its grants. It says too whether it is one of the shipped three.",
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
        help: "A grant the profile carries, written family-dot-verb: task.delete, infra.write. A family is coarser than the operations it covers.",
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
        "that profile is one of the shipped three, which are never deleted; edit its grants instead",
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
    errors: { unauthenticated: "user credential only: a session token is refused" },
  },
  "secret.set": {
    command: "secret set",
    help: "Stores or rotates one secret under an owner. The value can never be read back out. The `core` owner kind is the controller's own key material and is refused here.",
    examples: [{ args: ["plugin", "github", "client_secret"], stdin: "ghp_the_secret_value" }],
    fields: {
      ownerKind: {
        positional: true,
        help: "Which kind of thing owns the secret; it and the owner id together name the owner.",
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
    errors: { unauthenticated: "user credential only: a session token is refused" },
  },
  "secret.delete": {
    command: "secret delete",
    help: "Removes one secret from an owner. Whatever used it fails on its next call, so check with `hercule secret list` first. The `core` owner kind is the controller's own key material and is refused here.",
    examples: [{ args: ["plugin", "github", "client_secret"] }],
    fields: {
      ownerKind: {
        positional: true,
        help: "Which kind of thing owns the secret; it and the owner id together name the owner.",
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
    errors: { unauthenticated: "user credential only: a session token is refused" },
  },

  "task.query": {
    command: "task list",
    help: "Lists tasks. Repeating a flag widens (any of its values); adding another flag narrows (all must hold); there is no negation. This is how to find the id `hercule task read` and `hercule task update` name.",
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
        help: "A label the task carries; several of them find the tasks carrying any one.",
      },
      status: {
        flag: "status",
        help: "Where the work stands; give it twice to watch open and in-progress together.",
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
    help: "Creates a Task: a unit of human intent, never an execution. The description is markdown. Comes back with the task's id, which `hercule task update` and `hercule task read` take.",
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
        help: "How much this matters; leave it off and the server's own default stands.",
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
        help: "A JSON entry saying what created this task - at least one of ref, eventId and runId - so a repeated signal finds it again.",
      },
    },
  },
  "task.update": {
    command: "task update",
    help: "Edits a task; a field you do not name is untouched. Labels move one at a time with --add-label and --remove-label, so a user and an agent writing the same task never undo each other.",
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
        help: "Where the work stands. There is no state machine: every transition is legal.",
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
    help: "Deletes a task. The delete is soft and there is no undelete: the task answers not_found on read and is gone from `hercule task list` and from search.",
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
    help: "Lists projects: the groupings that hold related work and its materials. A project carries no behaviour and no defaults. Use it to find the id `hercule task create --project` names.",
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
    help: "Edits a project; a field you do not name is left as it was.",
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
    help: "Deletes a project. The delete is soft, and a task that names it keeps its project id, so nothing about that task changes.",
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
    help: "Lists the Resources Hercule knows: the repos, folders and mailboxes projects work with. Use it to find the id the other commands name.",
    examples: [{ args: [] }, { args: ["--kind", "repo"] }],
    fields: {
      kind: { flag: "kind", help: "Only resources of this kind: repo, folder or mailbox." },
      projectId: { flag: "project", help: "Only resources filed under this project." },
    },
  },
  "resource.read": {
    command: "resource read",
    help: "Reads one Resource in full. It answers with the remote and the canonical form of it, the Connection it acts through, its setup command and the projects it is filed under.",
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
        help: "The git remote, ssh or https; required for a repo and refused for anything else.",
      },
      label: {
        flag: "label",
        help: "What to call it; required for a folder and a mailbox, which have no remote to name them, and refused on a repo.",
      },
      connectionId: {
        flag: "connection",
        help: "The Connection Hercule acts through for it; a repo takes a github one.",
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
    errors: { conflict: "another resource already names the same repository" },
  },
  "resource.update": {
    command: "resource update",
    help: "Changes a Resource. It takes a new remote, Connection, setup command or include flag, and the project list it is given replaces the one the resource had.",
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
      remote: { flag: "remote", help: "The git remote; it is canonicalised again and re-checked." },
      label: {
        flag: "label",
        help: "What to call it; null takes the label off again. Refused on a repo.",
      },
      connectionId: {
        flag: "connection",
        help: "The Connection to act through; null takes it off again.",
      },
      setupCommand: {
        flag: "setup-command",
        help: "Run in every fresh checkout; null takes it off again. A repo only.",
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
    errors: { conflict: "another resource already names the same repository" },
  },
  "resource.delete": {
    command: "resource delete",
    help: "Removes a Resource and the project links it had. A resource a workspace still stands on is refused; dispose of that workspace first.",
    examples: [{ args: ["1f3a9c2e"] }],
    fields: {
      id: {
        positional: true,
        help: "The resource's id, or a tail of eight or more characters.",
        resolves: "resource.query",
      },
    },
    errors: { invalid_state: "a workspace still stands on it; dispose of that workspace first" },
  },

  "workspace.query": {
    command: "workspace list",
    help: 'Lists the Workspaces on the fleet: what each holds and where it stands. Use it to find one to open a thread in with `hercule session spawn --workspace \'{"kind":"existing","workspaceId":"<id>"}\'`.',
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
      kind: { flag: "kind", help: "Only workspaces of this kind: primary or ephemeral." },
      status: {
        flag: "status",
        help: "Only workspaces in this state: provisioning, ready, failed, deleted or lost.",
      },
    },
  },
  "workspace.read": {
    command: "workspace read",
    help: "Reads one Workspace in full. It answers with its checkouts and their branches, where it stands, and the sessions in it that have not exited; poll it after `hercule workspace provision` until it reads ready.",
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
    help: "Makes a repo's main workspace on one machine, which is the long-lived working copy threads share. Hercule clones it fresh under that machine's own storage; a folder you already have is never taken over. It answers at once with the workspace provisioning, and the machine reports when it stands; read it back with `hercule workspace read`.",
    examples: [{ args: ["--resource", "1f3a9c2e", "--runner", "7b41d0a5"] }],
    fields: {
      resourceId: {
        flag: "resource",
        help: "The repo to check out; a folder or a mailbox is refused.",
      },
      runnerId: { flag: "runner", help: "The machine to make it on." },
    },
    errors: {
      conflict: "that repo already has a main workspace on that machine",
      // Restated rather than imported: the sentence the controller refuses with
      // is the controller's, and this is the gloss beside the flag.
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
        "a main workspace is never torn down, and one already gone has nothing left to tear down",
    },
  },

  "event.query": {
    command: "event list",
    help: "Reads the event log: external events and audit entries under one envelope, told apart by their kind. Reach for it to see what the system saw and what it did about it. Security entries - the secret, auth and user account kinds - need the event.audit grant; without it they are simply absent from the page, and filtering by one of those kinds returns nothing.",
    examples: [{ args: ["--kind", "task.created"] }, { args: ["--since", "2026-09-15T00:00:00Z"] }],
    fields: {
      connectionId: {
        flag: "connection",
        help: "Only events that arrived through this Connection, by its full id.",
      },
      kind: {
        flag: "kind",
        help: "One exact event kind, such as task.created or github.issue.opened.",
      },
      since: { flag: "since", help: "Only events received at or after this RFC 3339 instant." },
      until: { flag: "until", help: "Only events received at or before this RFC 3339 instant." },
    },
  },
  "event.read": {
    command: "event read",
    help: "Reads one event in full, its payload and the vendor original included. Find its id in `hercule event list`. A security entry - the secret, auth and user account kinds - needs the event.audit grant; without it the entry answers not-found.",
    examples: [{ args: ["4217"] }],
    fields: {
      id: {
        positional: true,
        help: "The event's id, which is its position in the log: a whole number counted from one, never a tail.",
      },
    },
    errors: {
      not_found:
        "no entry has that id, or it is a security entry and you do not hold event.audit; the two answer alike on purpose",
    },
  },

  "runner.query": {
    command: "runner list",
    help: "Lists the fleet: every Runner enrolled with this controller, by name. Each row says how reachable the machine is and where it stands with its owner. Use it to find the id the other `hercule runner` commands take.",
    examples: [{ args: [] }, { args: ["--connectivity", "online", "--lifecycle", "active"] }],
    fields: {
      connectivity: {
        flag: "connectivity",
        help: "Whether the controller can reach the machine; written by the socket and by nobody else.",
      },
      lifecycle: {
        flag: "lifecycle",
        help: "Where the machine stands with its owner; it moves independently of reachability.",
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
    help: "Edits what the owner owns about a runner. That is its name, its labels, its session cap, its disk watermark and whether it is reserved; everything else on the row is the machine's own report and is refused rather than ignored.",
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
      name: { flag: "name", help: "What the fleet listing calls this machine." },
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
        help: "true means placement never chooses it; only work that names it lands here.",
      },
    },
  },
  "runner.drain": {
    command: "runner drain",
    help: "Stops new sessions landing on a runner while the ones already there finish. Reach for it before maintenance; `hercule runner undrain` puts the machine back in rotation.",
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
    help: "Probes one Provider Instance on a runner and answers with a fresh Capability Snapshot. The snapshot is its auth state, harness version and model catalog. Reach for it when a spawn was refused for want of a logged-in machine.",
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
    help: "Re-probes a runner's facts now instead of waiting for the hourly refresh. The facts are its OS, architecture, RAM, toolchains and which provider CLIs are on its PATH. Answers with the runner carrying what it just reported.",
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
    help: "Installs a provider's harness binary on a runner. Reach for it when `hercule runner read` shows the provider missing from the machine's facts; the facts come back refreshed.",
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
    help: "Mints the one-time token a new machine enrols with, shown here and nowhere else. Run it before starting the runner daemon on that machine; `hercule runner join-token list` afterwards says whether the invitation is still open.",
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
    help: "Lists every plugin this binary was built with. Each row says what the user decided about the plugin and what this boot made of it. The set is fixed at build time, so this is the whole of it.",
    examples: [{ args: [] }],
    fields: {},
  },
  "plugin.read": {
    command: "plugin read",
    help: "Reads one plugin in full: its capabilities, contributions, stored config and config schema. A settings form is generated from that schema; a refused plugin has none, and its status says why it was refused.",
    examples: [{ args: ["github"] }],
    fields: {
      id: {
        positional: true,
        help: "The plugin's id as its manifest names it, such as github; a name, never a UUID and never a tail.",
      },
    },
  },
  "plugin.enable": {
    command: "plugin enable",
    help: "Enables a plugin and starts it, so its contributions register. The decision is stored and survives a restart; the reply says what this process made of it.",
    examples: [{ args: ["github"] }],
    fields: {
      id: {
        positional: true,
        help: "The plugin's id as its manifest names it, such as github; a name, never a UUID and never a tail.",
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
        help: "The plugin's id as its manifest names it, such as github; a name, never a UUID and never a tail.",
      },
    },
  },
  "plugin.retry": {
    command: "plugin retry",
    help: "Starts an errored plugin over without restarting the controller. Only a plugin whose status is errored has anything to retry; anything else is refused.",
    examples: [{ args: ["github"] }],
    fields: {
      id: {
        positional: true,
        help: "The plugin's id as its manifest names it, such as github; a name, never a UUID and never a tail.",
      },
    },
  },
  "plugin.resetState": {
    command: "plugin reset-state",
    help: "Throws away everything a plugin stored and starts it over. Reach for it when leftover state is the plausible cause of a plugin sitting errored or inactive; what it stored is gone for good.",
    examples: [{ args: ["github"] }],
    fields: {
      id: {
        positional: true,
        help: "The plugin's id as its manifest names it, such as github; a name, never a UUID and never a tail.",
      },
    },
  },
  "plugin.configure": {
    command: "plugin configure",
    help: "Stores a plugin's config and restarts it on the new one. There is no hot reconfigure, so a plugin never sees its config change under it. The config is a JSON object, validated before anything restarts, so a rejected one leaves a running plugin running. Read the shape it must take from `hercule plugin read`.",
    examples: [{ args: ["github"], stdin: '{"appId":"1234","pollSeconds":60}' }],
    fields: {
      id: {
        positional: true,
        help: "The plugin's id as its manifest names it, such as github; a name, never a UUID and never a tail.",
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
    help: "Opens a Provider Instance: one account of one provider, with its own provider home on every runner. The config is a JSON object checked against the provider's own schema. Log the new instance in on a machine with `hercule provider login`.",
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
    help: "Edits a Provider Instance; a field you do not name is left as it was. The config goes inline here as JSON, because it is one value beside the name rather than the whole payload.",
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
        help: "A replacement config as inline JSON, against the provider's own schema.",
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
    help: "Starts the vendor login for a Provider Instance on one machine. Answers with the URL to open, plus the code the harness printed when there is one. A vendor credential belongs to exactly one machine, because two live copies of one login rotate each other out. Finish it with `hercule provider submit-login-code`.",
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
    help: "Hands back the code the browser showed, finishing what `hercule provider login` started. Answers with a fresh Capability Snapshot for that machine, so the reply says whether the instance is usable there.",
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
    help: "Lists Connections: the named links to external accounts Hercule acts through, with the status of each. Use it to find the id an event's connection names.",
    examples: [{ args: [] }, { args: ["--status", "needs-reauth"] }],
    fields: {
      type: {
        flag: "type",
        help: "Only connections of this type, by its Qualified Id such as gmail/gmail.",
      },
      status: {
        flag: "status",
        help: "Where the account stands; needs-reauth is what to look for when events stopped arriving.",
      },
    },
  },
  "connection.read": {
    command: "connection read",
    help: "Reads one Connection in full: the account it names, where it stands, and its topics. The names of the secrets it owns come with it.",
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
        help: "The connection's own config as inline JSON, against the type's declared schema.",
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
    help: "Starts a redirect flow and answers with the authorization URL to open in a browser. The connection exists only once the provider sends the browser back. The redirect URI is built from --origin, so it has to come out byte for byte as what was registered with the provider. Name --connection to reconnect an account that already exists instead of making a second one.",
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
        "the plugin that owns this type holds no OAuth client credentials; set them in settings first",
    },
  },

  "agent.query": {
    command: "agent list",
    help: "Lists the Agents sessions are spawned from. An Agent is a named, reusable configuration for unattended work. Use it to find the id `hercule session spawn --agent` names.",
    examples: [{ args: [] }, { args: ["--profile", "1f3a9c2e"] }],
    fields: {
      permissionProfileId: {
        flag: "profile",
        help: "Only the Agents that spawn their sessions under this Permission Profile, by its id or a tail of eight or more characters; it says which Agents hold a profile a delete was refused for.",
        resolves: "profile.query",
      },
    },
  },
  "agent.read": {
    command: "agent read",
    help: "Reads one Agent in full: its prompt, where it runs and what it may do. It also says which of those fields its provider will not enforce.",
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
        help: "The choices that model opens with, as inline JSON; refused without --model beside it, because a choice belongs to the model that offers it.",
      },
      disallowedTools: {
        flag: "disallowed-tool",
        help: "A tool family to take away: edit, write, shell, web-search or web-fetch; repeatable. A provider that enforces none of them says so in the reply.",
      },
    },
  },
  "agent.update": {
    command: "agent update",
    help: "Edits an Agent; a field you do not name is left as it was. Sessions already spawned keep the values they were given.",
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
        help: "The model its sessions open on instead, by its slug; it replaces the stored choices, so name --options beside it to keep any. `null` puts it back on the instance default.",
      },
      options: {
        flag: "options",
        help: "The choices to open that model with, replacing the ones set now, as inline JSON; refused without --model beside it, because a choice belongs to the model that offers it.",
      },
      disallowedTools: {
        flag: "disallowed-tool",
        help: "The tool families to take away, replacing the ones set now; repeatable.",
      },
    },
  },
  "agent.delete": {
    command: "agent delete",
    help: "Deletes an Agent. It is refused while a session it spawned is still running; sessions that have exited keep its id as the lineage it is.",
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
        "a session spawned from this agent has not exited yet; the message names it, and `hercule session stop` ends it",
    },
  },

  "session.query": {
    command: "session list",
    help: "Lists sessions, newest first: one row per conversation with a provider-backed agent. Use it to find the id every other `hercule session` command takes.",
    examples: [
      { args: [] },
      { args: ["--status", "busy", "--status", "idle"] },
      { args: ["--thread", "true"] },
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
      permissionProfileId: {
        flag: "profile",
        help: "Only the sessions carrying this Permission Profile, by its id or a tail of eight or more characters; it says which sessions hold a profile a delete was refused for.",
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
    help: "Reads one session: where it stands, what it runs under, and whether it can be resumed. The Request it is parked on comes with it, if there is one; answer that Request with `hercule session respond`.",
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
    help: "Starts a session, from an Agent or as a Thread the user drives by hand. With `--agent` every value comes from that Agent; without one it is a Thread and the values come from the user's thread settings. Either way a flag given here wins. Comes back with the session's id; watch what it does with `hercule transcript read` and send the next turn with `hercule session input`.",
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
        help: "The Agent to spawn from, by its id or a tail of eight or more characters; --instance and --profile are refused beside it, because those come from the Agent.",
        resolves: "agent.query",
      },
      outputSchema: {
        flag: "output-schema",
        help: "What every turn must answer with, as an inline JSON Schema; a keyword outside the subset every harness agrees on is refused, saying which.",
      },
      instanceId: {
        flag: "instance",
        help: "The Provider Instance to run on, in place of the thread default, by its id or a tail of eight or more characters.",
        resolves: "provider.query",
      },
      model: { flag: "model", help: "The model to open with, in place of the thread default." },
      options: {
        flag: "options",
        help: "The per-model choices as inline JSON; a choice the model does not offer is refused.",
      },
      accessMode: {
        flag: "access-mode",
        help: "What the provider adapter enforces for this session. A mode the provider lacks is substituted downward, never upward, and the reply says which mode the session actually got.",
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
        help: "The project the thread belongs to, by its id or a tail of eight or more characters; every repo it names has to be filed under it.",
        resolves: "project.query",
      },
      workspace: {
        flag: "workspace",
        help: 'Where it works, as JSON: {"kind":"primary","resourceId":"<id>","branch":"<branch>"} for the repo\'s main workspace, {"kind":"ephemeral","checkouts":[{"resourceId":"<id>","baseBranch":"<branch>"}]} for an ephemeral workspace with a checkout of its own (an empty list is a scratch workspace), or {"kind":"existing","workspaceId":"<id>"} to join one that stands. Leave it off for a thread with no checkout.',
      },
    },
    errors: {
      unauthenticated: "user credential only: a session token is refused",
      invalid_state:
        "nothing can host it: no connected runner is logged in to that provider instance, or the runner named is draining or retired; check with `hercule runner list` and `hercule provider login`",
    },
  },
  "session.update": {
    command: "session update",
    help: "Changes what a session runs under from here on: its model and the per-model options. Options merge over the ones it already runs with, unless --model names a different model, in which case the choices start empty, because they belong to the model that offered them.",
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
        help: "The per-model choices as inline JSON; they merge over what is already set.",
      },
    },
    errors: { invalid_state: "that session has exited; there is nothing left to configure" },
  },
  "session.input": {
    command: "session input",
    help: "Sends one turn's input to a session. It opens a turn on an idle session and is queued on any other, and a session whose process is gone but whose transcript is still on its runner is resumed in place by it. Comes back with the input's id and what became of it; while the row is still queued, `hercule input update` and `hercule input cancel` change it and `hercule input steer` folds it into the turn already running.",
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
    help: "Answers the Request a session is parked on with one of the four decisions. That is the only way an approval is resolved; free text never is. Read the open request first with `hercule session read`.",
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
        help: "How the Request is answered: allow_always persists a rule for the rest of the session, and cancel denies and ends the turn with it.",
      },
    },
    errors: {
      invalid_state:
        "the session is not waiting on a decision, or the harness has moved on and this is not the request it is waiting on now; read it again with `hercule session read`",
    },
  },
  "session.stop": {
    command: "session stop",
    help: "Ends a session: the turn stops and the process goes away. It is not the end of the conversation - a session whose transcript is still on its runner is resumed in place by the next `hercule session input`.",
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
    help: "Forks a session: opens a second provider-native session off the one the parent left behind. The parent's own transcript is untouched. It lands on the parent's runner and Provider Instance, because that is where the native state is, and comes back as a new session with its own id. To carry the parent itself on instead, send it `hercule session input`.",
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
      unauthenticated: "user credential only: a session token is refused",
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
    help: "Rewrites a Queued Input before the controller delivers it. An input already sent or delivered is refused, so read `hercule input list` if it fails.",
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
      invalid_state: "that input has already gone to the machine, or was delivered or cancelled",
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
      invalid_state: "that input has already gone to the machine, or was delivered or cancelled",
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
    help: "Reads what a session actually did: the normalized stream it left behind, one row per event. The rows are in order and carry their position. It is append-only and walked by position, so there is no filter and no search - the only choice is which end to start from.",
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
    errors: { unauthenticated: "user credential only: a session token is refused" },
  },
  "controller.update": {
    command: "controller update",
    help: "Sets the Runner a placement lands on when nothing names one. Find the id with `hercule runner list`; `null` takes the default off again, leaving placement with no fallback.",
    examples: [{ args: ["--default-runner", "1f3a9c2e"] }, { args: ["--default-runner", "null"] }],
    fields: {
      defaultRunnerId: {
        flag: "default-runner",
        help: "The runner to fall back to, by its full id; `null` clears it.",
      },
    },
    errors: { unauthenticated: "user credential only: a session token is refused" },
  },
} as const satisfies Record<OperationId, CliRow>;

/**
 * The root nouns, as the root help introduces them and the noun help opens.
 * One entry per root noun of a visible command.
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
    flow: "hercule profile list to see what exists, hercule profile create for a new bundle, then name it at hercule session spawn.",
  },
  secret: {
    summary:
      "Secret references owned by connections, plugins, runners and provider instances. Values never read back.",
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
    flow: "hercule resource create records one, hercule resource list finds it again, then name it at hercule workspace provision or hercule session spawn.",
  },
  workspace: {
    summary: "Workspaces: the working areas on a machine that sessions do their work in.",
    flow: "hercule workspace provision makes a repo's main workspace, hercule workspace list shows what stands, hercule workspace dispose tears an ephemeral one down.",
  },
  event: {
    summary: "The event log: external events and audit entries, under one envelope.",
    flow: "hercule event list to see what came in, hercule event read for one entry in full.",
  },
  runner: {
    summary: "The fleet: the machines that host sessions on the controller's behalf.",
    flow: "hercule runner join-token create mints the invitation, hercule runner list shows the machine once it dials in, hercule runner drain and hercule runner retire take it out again.",
  },
  plugin: {
    summary:
      "The plugins this binary was built with: what is enabled, and what this boot made of each.",
  },
  provider: {
    summary: "Provider Instances: the accounts of the coding harnesses sessions run on.",
    flow: "hercule provider create opens an account, hercule provider login and hercule provider submit-login-code log it in on a machine, hercule runner probe says whether it is usable there.",
  },
  connection: {
    summary: "Connections: the named links to external accounts Hercule acts through.",
    flow: "hercule connection create for a pasted credential or hercule connection start-oauth for a browser flow, then hercule connection list to watch its status and hercule connection set-credentials to rotate.",
  },
  agent: {
    summary: "Agents: the named configurations sessions are spawned from, to work unattended.",
    flow: "hercule agent create records one, hercule agent list finds it again, then hercule session spawn --agent runs it.",
  },
  session: {
    summary: "Sessions: conversations with provider-backed agents, resumable and forkable.",
    flow: "hercule session spawn starts one, hercule transcript read watches it, hercule session input sends the next turn, hercule session respond answers what it is parked on, hercule session stop ends it.",
  },
  input: {
    summary: "The inputs a session was given, and the queued ones that can still be changed.",
    flow: "hercule input list to see them, then hercule input update, hercule input cancel or hercule input steer while a row is still queued.",
  },
  transcript: { summary: "What a session did: its normalized stream, read back in order." },
  controller: {
    summary: "The controller's own identity, and the default runner placement falls back to.",
  },
} as const satisfies Record<string, NounRow>;
