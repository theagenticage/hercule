<!--
Produced by driving the compiled `./hydra` binary. Every console block below is
the command's own output, unedited; only the temporary home, the loopback URL
the one-time setup token and the bearer it returned are replaced by
placeholders.
-->

# A CLI session against the compiled binary

`pnpm build:binary` first; the controller and the CLI below are both `./hydra`,
serving a temporary Hydra Home over loopback.

## Setting up and logging in

```console
$ printf %s "correct horse battery staple" | \
  hydra setup complete --setup-token <setup-token> --username rogier --password-stdin --timezone Europe/Amsterdam
token  <bearer>
```

```console
$ printf %s "correct horse battery staple" | \
  hydra login <url> --username rogier --password-stdin --name session
Wrote the API key "session" for <url> to <home>/credentials.json.
```

## A project, and two tasks with provenance

```console
$ hydra project create --name hydra --json
{
  "id": "01a06d02-beca-760b-a6b2-83af536c3c20",
  "name": "hydra",
  "createdAt": "2026-09-04T15:21:31.594Z",
  "updatedAt": "2026-09-04T15:21:31.594Z"
}
```

```console
$ hydra task create --title "Wire the runner socket up" --description "The controller accepts a runner over one WebSocket and hosts sessions on it." --priority high --labels runner --labels protocol --projectId 01a06d02-beca-760b-a6b2-83af536c3c20 --provenance "{\"ref\":\"github:issue:rogierpennink/hydra#61\"}"
id               22015952
title            Wire the runner socket up
description      The controller accepts a runner over one WebSocket and hosts sessions on it.
status           open
priority         high
labels           runner,protocol
projectId        536c3c20
provenance       {"ref":"github:issue:rogierpennink/hydra#61","at":"2026-09-04T15:21:31.646Z","actor":"user"}
createdAt        2026-09-04T15:21:31.646Z
updatedAt        2026-09-04T15:21:31.646Z
statusChangedAt  2026-09-04T15:21:31.646Z
```

```console
$ hydra task create --title "Prune the event log after 90 days" --description "The retention job walks the log by arrival time and drops what is older." --labels events --projectId 01a06d02-beca-760b-a6b2-83af536c3c20 --provenance "{\"ref\":\"github:issue:rogierpennink/hydra#62\"}" --json
{
  "id": "01a06d02-bf35-73be-8c1f-7c82ebeb9203",
  "title": "Prune the event log after 90 days",
  "description": "The retention job walks the log by arrival time and drops what is older.",
  "status": "open",
  "priority": "normal",
  "labels": [
    "events"
  ],
  "projectId": "01a06d02-beca-760b-a6b2-83af536c3c20",
  "provenance": [
    {
      "ref": "github:issue:rogierpennink/hydra#62",
      "at": "2026-09-04T15:21:31.701Z",
      "actor": "user"
    }
  ],
  "createdAt": "2026-09-04T15:21:31.701Z",
  "updatedAt": "2026-09-04T15:21:31.701Z",
  "statusChangedAt": "2026-09-04T15:21:31.701Z"
}
```

## Moving one along, and searching for the other

```console
$ hydra task update 01a06d02-bf35-73be-8c1f-7c82ebeb9203 --status in-progress --addLabels retention
id               ebeb9203
title            Prune the event log after 90 days
description      The retention job walks the log by arrival time and drops what is older.
status           in-progress
priority         normal
labels           events,retention
projectId        536c3c20
provenance       {"ref":"github:issue:rogierpennink/hydra#62","at":"2026-09-04T15:21:31.701Z","actor":"user"}
createdAt        2026-09-04T15:21:31.701Z
updatedAt        2026-09-04T15:21:31.755Z
statusChangedAt  2026-09-04T15:21:31.755Z
```

```console
$ hydra task query --status in-progress
id        title                              description                                                               status       priority  labels            projectId  provenance                                                                                    createdAt                 updatedAt                 statusChangedAt
ebeb9203  Prune the event log after 90 days  The retention job walks the log by arrival time and drops what is older.  in-progress  normal    events,retention  536c3c20   {"ref":"github:issue:rogierpennink/hydra#62","at":"2026-09-04T15:21:31.701Z","actor":"user"}  2026-09-04T15:21:31.701Z  2026-09-04T15:21:31.755Z  2026-09-04T15:21:31.755Z
```

```console
$ hydra task query --text "retention log"
id        title                              description                                                               status       priority  labels            projectId  provenance                                                                                    createdAt                 updatedAt                 statusChangedAt
ebeb9203  Prune the event log after 90 days  The retention job walks the log by arrival time and drops what is older.  in-progress  normal    events,retention  536c3c20   {"ref":"github:issue:rogierpennink/hydra#62","at":"2026-09-04T15:21:31.701Z","actor":"user"}  2026-09-04T15:21:31.701Z  2026-09-04T15:21:31.755Z  2026-09-04T15:21:31.755Z
```

```console
$ hydra task read ebeb9203 --json
{
  "id": "01a06d02-bf35-73be-8c1f-7c82ebeb9203",
  "title": "Prune the event log after 90 days",
  "description": "The retention job walks the log by arrival time and drops what is older.",
  "status": "in-progress",
  "priority": "normal",
  "labels": [
    "events",
    "retention"
  ],
  "projectId": "01a06d02-beca-760b-a6b2-83af536c3c20",
  "provenance": [
    {
      "ref": "github:issue:rogierpennink/hydra#62",
      "at": "2026-09-04T15:21:31.701Z",
      "actor": "user"
    }
  ],
  "createdAt": "2026-09-04T15:21:31.701Z",
  "updatedAt": "2026-09-04T15:21:31.755Z",
  "statusChangedAt": "2026-09-04T15:21:31.755Z"
}
```

## The log those commands wrote

```console
$ hydra event query --kind task.created
id  source    connectionId  system    kind          occurredAt                receivedAt                dedupKey                              refs  url  payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             raw  actor
7   platform                platform  task.created  2026-09-04T15:21:31.701Z  2026-09-04T15:21:31.701Z  f60eea1a-9c2f-46ec-b112-6319353107c6             {"task":{"id":"01a06d02-bf35-73be-8c1f-7c82ebeb9203","title":"Prune the event log after 90 days","description":"The retention job walks the log by arrival time and drops what is older.","status":"open","priority":"normal","labels":["events"],"projectId":"01a06d02-beca-760b-a6b2-83af536c3c20","provenance":[{"ref":"github:issue:rogierpennink/hydra#62","at":"2026-09-04T15:21:31.701Z","actor":"user"}],"createdAt":"2026-09-04T15:21:31.701Z","updatedAt":"2026-09-04T15:21:31.701Z","statusChangedAt":"2026-09-04T15:21:31.701Z"}}            user
6   platform                platform  task.created  2026-09-04T15:21:31.647Z  2026-09-04T15:21:31.647Z  9baff9ac-04a2-4470-a0df-0ac840f80173             {"task":{"id":"01a06d02-beff-7037-9f5b-042822015952","title":"Wire the runner socket up","description":"The controller accepts a runner over one WebSocket and hosts sessions on it.","status":"open","priority":"high","labels":["runner","protocol"],"projectId":"01a06d02-beca-760b-a6b2-83af536c3c20","provenance":[{"ref":"github:issue:rogierpennink/hydra#61","at":"2026-09-04T15:21:31.646Z","actor":"user"}],"createdAt":"2026-09-04T15:21:31.646Z","updatedAt":"2026-09-04T15:21:31.646Z","statusChangedAt":"2026-09-04T15:21:31.646Z"}}       user
```

```console
$ hydra event query --kind task.updated --json
{
  "items": [
    {
      "id": 8,
      "source": "platform",
      "connectionId": null,
      "system": "platform",
      "kind": "task.updated",
      "occurredAt": "2026-09-04T15:21:31.756Z",
      "receivedAt": "2026-09-04T15:21:31.756Z",
      "dedupKey": "38922ef6-1633-451c-bd94-12e5cb634051",
      "refs": [],
      "url": null,
      "payload": {
        "taskId": "01a06d02-bf35-73be-8c1f-7c82ebeb9203",
        "changes": {
          "status": {
            "old": "open",
            "new": "in-progress"
          },
          "labels": {
            "added": [
              "retention"
            ],
            "removed": []
          }
        }
      },
      "raw": null,
      "actor": "user"
    }
  ]
}
```

## A failed login, stamped with no actor

```console
$ printf %s "not the password" | \
  hydra auth login --username rogier --password-stdin
hydra: the username or password is incorrect
# exit 1
```

```console
$ hydra event query --kind auth.login.failed --json
{
  "items": [
    {
      "id": 9,
      "source": "platform",
      "connectionId": null,
      "system": "platform",
      "kind": "auth.login.failed",
      "occurredAt": "2026-09-04T15:21:32.146Z",
      "receivedAt": "2026-09-04T15:21:32.146Z",
      "dedupKey": "acce082e-1b06-456b-8a45-d96ad89deab1",
      "refs": [],
      "url": null,
      "payload": {
        "username": "rogier"
      },
      "raw": null,
      "actor": null
    }
  ]
}
```

## Deleting a task

```console
$ hydra task delete 01a06d02-bf35-73be-8c1f-7c82ebeb9203
ok
```

```console
$ hydra task read 01a06d02-bf35-73be-8c1f-7c82ebeb9203
hydra: no such task
# exit 1
```

```console
$ hydra task query
id        title                      description                                                                   status  priority  labels           projectId  provenance                                                                                    createdAt                 updatedAt                 statusChangedAt
22015952  Wire the runner socket up  The controller accepts a runner over one WebSocket and hosts sessions on it.  open    high      runner,protocol  536c3c20   {"ref":"github:issue:rogierpennink/hydra#61","at":"2026-09-04T15:21:31.646Z","actor":"user"}  2026-09-04T15:21:31.646Z  2026-09-04T15:21:31.646Z  2026-09-04T15:21:31.646Z
```
