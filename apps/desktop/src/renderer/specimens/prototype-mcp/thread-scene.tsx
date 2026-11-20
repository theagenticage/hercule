/**
 * PROTOTYPE, throwaway. The thread side of MCP servers: a thread's own list
 * of servers, and what the user sees when a call is refused.
 *
 * A thread starts with its project's servers, and the user can change that
 * for this thread alone. The control sits under the composer's plus button,
 * where it takes no room in the composer: the plus opens a menu, and "MCP
 * servers" opens a submenu of switches. The submenu lists the thread's own
 * servers and a few more, one line per server name; "1 more server…" opens
 * the picker with all of them.
 *
 * The page mounts the real Draft Thread screen (`phase=draft`) or the real
 * thread screen with an invented transcript (`phase=running`), so the tool
 * calls, the failed call and the notes are drawn by the app's own code.
 * `in=webshop|none` puts the thread in a project or in none, and
 * `st=ready|left-out|signin|not-named` picks what went wrong in a running
 * thread.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import type { Session } from "@hercule/contract";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { FileIcon } from "../../icons/file";
import { usePopoverMenu } from "../../screens/use-popover-menu";
import { DRAFT_PAGE_RECORDS, WEBSHOP_DRAFT } from "../draft-fixture";
import { mountDraftSpecimen, mountSidebarSpecimen, mountThreadSpecimen } from "../shell-page";
import {
  buildTranscript,
  FIX_SESSION,
  FIX_THREAD,
  runItem,
  runTool,
  THREAD_PAGE_RECORDS,
  type TranscriptStep,
} from "../thread-fixture";
import { AddServerDialog, ReconnectDialog } from "./dialogs";
import {
  describeFix,
  isFailing,
  readParam,
  reloadWithParams,
  ServerMark,
  ServerName,
  Toggle,
  ToolsIcon,
  type Knob,
} from "./parts";
import { AccountChoice, ServerPickerDialog } from "./picker";
import {
  findServerConnection,
  pickNamedServer,
  readWorld,
  setServer,
  useWorld,
  type Server,
  type World,
} from "./world";

type ThreadState = "ready" | "left-out" | "signin" | "not-named";

const place = readParam("in", "webshop") === "none" ? "none" : "webshop";
const phase = readParam("phase", "draft") === "running" ? "running" : "draft";
const state = (
  ["ready", "left-out", "signin", "not-named"].includes(readParam("st", "signin"))
    ? readParam("st", "signin")
    : "signin"
) as ThreadState;
const keepsDefaultList = readParam("np", "default") === "default";

export const THREAD_KNOBS = (): Knob[] => [
  {
    label: "Thread:",
    value: phase,
    options: [
      { value: "draft", label: "a draft, not started" },
      { value: "running", label: "started" },
    ],
    onChange: (value) => {
      reloadWithParams({ phase: value });
    },
  },
  {
    label: "In:",
    value: place,
    options: [
      { value: "webshop", label: "webshop" },
      { value: "none", label: "no project" },
    ],
    onChange: (value) => {
      reloadWithParams({ in: value });
    },
  },
  ...(place === "none" || phase === "draft"
    ? []
    : [
        {
          label: "Happens:",
          value: state,
          options: [
            { value: "ready", label: "every call works" },
            { value: "left-out", label: "linear left out at start" },
            { value: "signin", label: "linear needs sign-in mid-thread" },
            { value: "not-named", label: "a server the thread does not have" },
          ],
          onChange: (value: string) => {
            reloadWithParams({ st: value });
          },
        },
      ]),
];

/** Returns the ids of the servers this thread starts with: its project's, the default list's, or none. */
const listStartIds = (w: World): readonly string[] =>
  place === "webshop"
    ? w.projects.find((project) => project.id === "p-webshop")!.serverIds
    : keepsDefaultList
      ? w.defaultServerIds
      : [];

const listStartServers = (w: World): readonly Server[] => {
  const ids = listStartIds(w);
  return w.servers.filter((server) => ids.includes(server.id));
};

/** The list the thread starts from, as a sentence's subject. */
const START_LIST =
  place === "webshop" ? "webshop's list" : keepsDefaultList ? "the default list" : null;

const TURN_ID = "turn-1";

type ItemDetail = NonNullable<Parameters<typeof runItem>[3]>;

/** Returns the steps of a call to `tool` on the MCP server `server`, as the adapter reports one. */
const runMcpTool = (
  seconds: readonly [number, number],
  itemId: string,
  server: string,
  tool: string,
  input: Record<string, string>,
  refusal?: string,
): TranscriptStep[] => {
  const detail = { name: tool, server, input, kind: "mcp" } as ItemDetail;
  const steps = runItem(seconds, itemId, "tool_call", detail);
  if (refusal === undefined) return steps;
  return steps.map(([at, event]): TranscriptStep =>
    event._tag === "item.completed"
      ? [at, { ...event, status: "failed", detail: { content: refusal } as ItemDetail }]
      : [at, event],
  );
};

/** Builds the thread's transcript for the place and the state the URL asks for. */
const buildSteps = (w: World): TranscriptStep[] => {
  const servers = listStartServers(w);
  const leftOut = servers.filter((server) => isFailing(server.status));
  const startNotes: TranscriptStep[] = [];
  if (state === "left-out" && place === "webshop") {
    for (const server of leftOut) {
      startNotes.push([
        2,
        // An error, not a warning: the user must act, so the app draws the note in its failure colours.
        {
          _tag: "runtime.error",
          turnId: TURN_ID,
          class: "unknown",
          message: `\`${server.name}\` needs sign-in, so it was left out of this thread. Threads started after you sign in get it.`,
        },
      ]);
    }
  }

  if (place === "none") {
    return [
      [0, { _tag: "turn.started", turnId: TURN_ID, model: FIX_SESSION.modelSelection.model }],
      ...runItem([0, 0], "it-ask", "user_message", {
        text: "What changed in Stripe SDK v14 for confirmPayment and 3‑D Secure?",
      }),
      ...startNotes,
      ...(servers.some((server) => server.name === "context7")
        ? [
            ...runMcpTool([5, 7], "it-c1", "context7", "resolve-library-id", {
              libraryName: "stripe-js",
            }),
            ...runMcpTool([8, 14], "it-c2", "context7", "get-library-docs", {
              topic: "confirmPayment requires_action",
            }),
          ]
        : runItem([5, 14], "it-search", "web_search", {
            name: "WebSearch",
            input: { query: "Stripe SDK v14 confirmPayment requires_action" },
          })),
      ...runItem(
        [40, 44],
        "it-answer",
        "assistant_message",
        undefined,
        "Since v14, `confirmPayment` no longer rejects for a card that needs 3‑D Secure. It " +
          "resolves with `status: 'requires_action'`, and the caller must open the challenge " +
          "with the `clientSecret`.",
      ),
      [46, { _tag: "turn.completed", turnId: TURN_ID, state: "completed" }],
    ];
  }

  const followUp: TranscriptStep[] =
    state === "ready"
      ? runMcpTool([302, 306], "it-linear", "linear", "create_issue", {
          title: "Apple Pay path ignores requires_action",
        })
      : state === "signin"
        ? [
            ...runMcpTool(
              [302, 303],
              "it-linear",
              "linear",
              "create_issue",
              { title: "Apple Pay path ignores requires_action" },
              // Each line is 72 characters at most, so the app's output box cuts none of them.
              "The MCP server linear needs sign-in, so the call was not made.\n" +
                "mcp.linear.app refused the saved sign-in at 09:06 (401, token revoked).\n" +
                "A person must sign in again in Settings > MCP servers > linear.\n" +
                "Do not retry before the user says it is back.",
            ),
            [
              304,
              // An error, not a warning: the user must act, so the app draws the note in its failure colours.
              {
                _tag: "runtime.error",
                turnId: TURN_ID,
                class: "unknown",
                message: "`linear` needs sign-in, so `create_issue` was not called.",
              },
            ],
          ]
        : state === "not-named"
          ? [
              ...runMcpTool(
                [302, 303],
                "it-context7",
                "context7",
                "get-library-docs",
                { topic: "confirmPayment requires_action" },
                "context7 is not one of this thread's MCP servers,\n" +
                  "so the call was not made.\n" +
                  "This thread has sentry, github, linear and notion.\n" +
                  "A person can switch it on for this thread,\n" +
                  "under the plus of the composer.",
              ),
              [
                304,
                {
                  _tag: "runtime.warning",
                  turnId: TURN_ID,
                  message:
                    "The agent called `context7`, which this thread does not have. The call was refused.",
                },
              ],
            ]
          : [];

  const lastWords: Readonly<Record<ThreadState, string>> = {
    ready: "Fixed, and the tests pass. I filed **WEB‑812** in Linear for the Apple Pay path.",
    "left-out":
      "Fixed, and the tests pass. This thread has no Linear tools, so I did not file the follow-up for the Apple Pay path. Say the word once Linear is back and I will.",
    signin:
      "Fixed, and the tests pass. I could not file the Linear issue for the Apple Pay path: the `linear` server needs sign-in. Tell me when it is back and I will file it.",
    "not-named":
      "Fixed, and the tests pass. I wanted Stripe's current docs from `context7`, but this thread does not have that server, so I went by the changelog in the repository.",
  };

  return [
    [0, { _tag: "turn.started", turnId: TURN_ID, model: FIX_SESSION.modelSelection.model }],
    ...runItem([0, 0], "it-ask", "user_message", {
      text:
        "Checkout fails for EU cards that need 3‑D Secure since deploy #1289. See what Sentry " +
        "has on it, fix it, and file a Linear issue for the Apple Pay path.",
    }),
    ...startNotes,
    ...runMcpTool([5, 9], "it-s1", "sentry", "search_issues", {
      query: "checkout errors since deploy 1289",
    }),
    ...runMcpTool([12, 16], "it-s2", "sentry", "get_issue_details", { issueId: "WEBSHOP-4F2" }),
    ...runTool([31, 32], "it-read-1", "file_read", "Read", {
      file_path: "src/checkout/payment.ts",
    }),
    ...runTool([45, 46], "it-read-2", "file_read", "Read", { file_path: "src/checkout/stripe.ts" }),
    ...runItem(
      [134, 140],
      "it-cause",
      "assistant_message",
      undefined,
      "Sentry has it as **WEBSHOP‑4F2**: 212 events since Friday 14:10, all `CardDeclinedError` " +
        "from `handlePaymentResult`. Since Stripe SDK v14, `confirmPayment` returns " +
        "`status: 'requires_action'` for cards that need 3‑D Secure, and we treat that as a " +
        "failure. I will write a failing test first, then the fix.",
    ),
    ...runTool([145, 150], "it-test", "file_change", "Write", {
      file_path: "src/checkout/payment.test.ts",
    }),
    ...runTool([170, 176], "it-fix", "file_change", "Edit", {
      file_path: "src/checkout/payment.ts",
    }),
    ...runTool([210, 300], "it-run-tests", "command_execution", "Bash", {
      command: "pnpm test checkout",
    }),
    ...followUp,
    ...runItem([431, 434], "it-ready", "assistant_message", undefined, lastWords[state]),
    [436, { _tag: "turn.completed", turnId: TURN_ID, state: "completed" }],
  ];
};

/** Mounts the real Draft Thread or thread screen for the scene, and opens the stretch that holds a refused call. */
export async function mountThreadScene(): Promise<void> {
  // The thread's world follows the scene: linear needs sign-in only where the scene says so.
  for (const server of readWorld().servers) {
    if (server.status !== "disabled") {
      setServer(server.id, { status: "ready", statusDetail: null });
    }
  }
  if (phase === "draft" || state === "left-out" || state === "signin") {
    setServer("s-linear", {
      status: "needs-sign-in",
      statusDetail: "mcp.linear.app refused the saved sign-in at 09:06 (401, token revoked).",
    });
  }
  if (phase === "draft") {
    if (place === "webshop") await mountDraftSpecimen(DRAFT_PAGE_RECORDS, WEBSHOP_DRAFT);
    else await mountSidebarSpecimen(DRAFT_PAGE_RECORDS, "/");
    return;
  }
  const session: Session = {
    ...FIX_SESSION,
    status: "idle",
    openRequests: [],
    projectId: place === "webshop" ? "p-webshop" : null,
    ...(place === "none" ? { title: "Stripe v14 and 3\u2011D Secure" } : {}),
  };
  await mountThreadSpecimen(
    {
      ...THREAD_PAGE_RECORDS,
      threads: THREAD_PAGE_RECORDS.threads.map((thread) =>
        thread.id === session.id ? session : thread,
      ),
    },
    {
      ...FIX_THREAD,
      session,
      transcript: buildTranscript(buildSteps(readWorld())),
      queuedInputs: [],
    },
  );
  if (place === "webshop" && (state === "signin" || state === "not-named")) {
    // The refused call sits in the second work stretch, which is closed when the thread opens.
    const stretches = document.querySelectorAll<HTMLElement>(".worked");
    stretches[stretches.length - 1]?.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const rows = document.querySelectorAll<HTMLElement>("button.work-row");
    rows[rows.length - 1]?.click();
  }
}

/** How many server names the submenu lists before the rest move behind "1 more server…". */
const SUBMENU_ROWS = 8;

/** The composer's plus button, which the app uses to attach an image. */
const PLUS_SELECTOR = 'button[aria-label="Attach"]';

/** Where the plus menu opens: the left edge of the plus button, and the distance from the window's bottom to its top. */
interface MenuPlace {
  readonly left: number;
  readonly bottom: number;
}

/**
 * Draws one line of the submenu: a server name with its switch. `servers` are
 * the servers of that name the thread can have, and `shown` is the one the
 * line stands for: the thread's own while `on`, and otherwise the one the
 * switch would give it. Two servers of one name are one line with a choice of
 * account, as in the picker, so a thread never gets both. `onChange` is called
 * with the server of this name the thread should have, or null for none.
 */
function ServerSwitchRow({
  w,
  servers,
  shown,
  on,
  onChange,
  onFix,
}: {
  readonly w: World;
  readonly servers: readonly Server[];
  readonly shown: Server;
  readonly on: boolean;
  readonly onChange: (serverId: string | null) => void;
  readonly onFix: () => void;
}): JSX.Element {
  return (
    <div className="pm-plus-row">
      <ServerMark server={shown} size={15} />
      <span className="pm-plus-name">
        {/* A line with a choice of account shows the name alone: the choice beside it names the account. */}
        <ServerName
          name={shown.name}
          account={servers.length > 1 ? undefined : findServerConnection(w, shown)?.label}
        />
        {shown.status === "needs-sign-in" && (
          <small>
            {/* The switch stays on: the thread keeps the server, and gets its tools after the sign-in. */}
            {on ? "on, joins once you sign in" : "needs sign-in"}
            <button type="button" className="link" onClick={onFix}>
              {describeFix(w, shown)?.action}
            </button>
          </small>
        )}
      </span>
      {servers.length > 1 && (
        <AccountChoice
          w={w}
          servers={servers}
          chosenId={shown.id}
          disabled={!on}
          onChoose={onChange}
        />
      )}
      <Toggle
        on={on}
        label={`${shown.name} in this thread`}
        onChange={(next) => {
          onChange(next ? shown.id : null);
        }}
      />
    </div>
  );
}

export function ThreadApp(): JSX.Element {
  const w = useWorld();
  const [startIds] = useState(() => listStartIds(w));
  const [ids, setIds] = useState(startIds);
  const [menuPlace, setMenuPlace] = useState<MenuPlace | null>(null);
  const [showsServers, setShowsServers] = useState(false);
  // The server names in the order the submenu opened with, the thread's own first, so a row never jumps while it is used.
  const [order, setOrder] = useState<readonly string[]>([]);
  // The server each name's line last stood for, which it keeps showing while the name is switched off.
  const [shownIds, setShownIds] = useState<Readonly<Record<string, string>>>({});
  const [picking, setPicking] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { buildItemProps } = usePopoverMenu();

  const own = w.servers.filter((server) => ids.includes(server.id));
  const failing = own.filter((server) => isFailing(server.status));
  const changed = ids.length !== startIds.length || ids.some((id) => !startIds.includes(id));
  const fixingServer = w.servers.find((server) => server.id === fixing);
  const fixingConnection =
    fixingServer === undefined ? undefined : findServerConnection(w, fixingServer);

  // The app's plus button attaches an image. Here a press on it opens the prototype's menu in its place.
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const plus = (event.target as Element | null)?.closest(PLUS_SELECTOR);
      if (plus == null) return;
      event.preventDefault();
      event.stopPropagation();
      const box = plus.getBoundingClientRect();
      setShowsServers(false);
      setMenuPlace({ left: box.left, bottom: window.innerHeight - box.top + 6 });
    };
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menuPlace === null || menu === null) return;
    menu.style.left = `${String(menuPlace.left)}px`;
    menu.style.bottom = `${String(menuPlace.bottom)}px`;
    // The submenu grows upwards from the plus, so it is as tall as the room above it at most.
    menu.style.setProperty(
      "--pm-plus-room",
      `${String(window.innerHeight - menuPlace.bottom - 12)}px`,
    );
    menu.showPopover();
  }, [menuPlace]);

  // The plus button carries a red dot while one of the thread's servers needs sign-in.
  const needsSignIn = failing.length > 0;
  useEffect(() => {
    const plus = document.querySelector<HTMLElement>(PLUS_SELECTOR);
    if (plus === null || !needsSignIn) return;
    const dot = document.createElement("i");
    dot.className = "dot dot--fail pm-plus-dot";
    plus.classList.add("pm-plus-button");
    plus.append(dot);
    return () => {
      dot.remove();
    };
  }, [needsSignIn]);

  // In the transcript, the note about a server that needs sign-in ends in the button that fixes it.
  useEffect(() => {
    const buttons: HTMLElement[] = [];
    for (const note of document.querySelectorAll(".error-note p")) {
      if (!(note.textContent ?? "").includes("needs sign-in")) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn--sm pm-note-button";
      button.textContent = "Sign in again…";
      button.addEventListener("click", () => {
        setFixing("s-linear");
      });
      note.insertBefore(button, note.querySelector(".time"));
      buttons.push(button);
    }
    return () => {
      for (const button of buttons) button.remove();
    };
  }, []);

  /** Returns whether the submenu offers `server`. A server that is switched off in Settings is only in the picker. */
  const canJoin = (server: Server): boolean =>
    ids.includes(server.id) || server.status !== "disabled";

  const closeMenu = (): void => {
    menuRef.current?.hidePopover();
  };
  const openServers = (): void => {
    if (!showsServers) {
      // The names of the thread's own servers, then others up to the submenu's size. The rest are in the picker.
      const names = [
        ...new Set([...own, ...w.servers.filter(canJoin)].map((server) => server.name)),
      ];
      setOrder(names.slice(0, Math.max(SUBMENU_ROWS, own.length)));
    }
    setShowsServers(true);
  };
  const openPicker = (): void => {
    closeMenu();
    setPicking(true);
  };
  const hiddenCount = new Set(
    w.servers.map((server) => server.name).filter((name) => !order.includes(name)),
  ).size;

  const foot =
    phase === "running"
      ? "Changes are for this thread only. They reach the agent the next time it starts."
      : START_LIST === null
        ? "A thread in no project starts with no servers. Switch on what this one needs."
        : `Starts from ${START_LIST}. Changes are for this thread only.`;
  const resetLabel = START_LIST === null ? "Switch all off" : `Back to ${START_LIST}`;

  return (
    <>
      {menuPlace !== null && (
        <div
          ref={menuRef}
          popover="auto"
          className="pm-plus"
          onToggle={(event) => {
            if (event.newState === "closed") setMenuPlace(null);
          }}
        >
          <div className="pop popover-menu pm-plus-main" role="menu" aria-label="Add">
            <button type="button" {...buildItemProps("attach")} onClick={closeMenu}>
              <FileIcon size={15} />
              <span className="pm-plus-label">Attach an image</span>
            </button>
            <button
              type="button"
              {...buildItemProps("servers")}
              aria-expanded={showsServers}
              className={showsServers ? "is-active" : buildItemProps("servers").className}
              onClick={openServers}
              onPointerEnter={(event) => {
                buildItemProps("servers").onPointerEnter(event);
                openServers();
              }}
            >
              <ToolsIcon size={15} />
              <span className="pm-plus-label">MCP servers</span>
              {failing.length > 0 ? (
                <span className="pm-plus-fine is-fail">
                  {failing.length} {failing.length === 1 ? "needs" : "need"} sign-in
                </span>
              ) : (
                <span className="pm-plus-fine">{own.length === 0 ? "none" : own.length}</span>
              )}
              <ChevronRightIcon size={13} />
            </button>
          </div>
          {showsServers && (
            <div className="pop pm-plus-sub" role="menu" aria-label="MCP servers">
              <div className="q-h pm-plus-top">Servers of this thread</div>
              <div className="pm-plus-list">
                {order.map((name) => {
                  const servers = w.servers.filter(
                    (server) => server.name === name && canJoin(server),
                  );
                  const picked = servers.find((server) => ids.includes(server.id));
                  const shown =
                    picked ?? servers.find((server) => server.id === shownIds[name]) ?? servers[0];
                  if (shown === undefined) return null;
                  return (
                    <ServerSwitchRow
                      key={name}
                      w={w}
                      servers={servers}
                      shown={shown}
                      on={picked !== undefined}
                      onChange={(serverId) => {
                        setShownIds({ ...shownIds, [name]: serverId ?? shown.id });
                        setIds(pickNamedServer(w, ids, name, serverId));
                      }}
                      onFix={() => {
                        closeMenu();
                        setFixing(shown.id);
                      }}
                    />
                  );
                })}
              </div>
              {hiddenCount > 0 && (
                <div className="popover-menu pm-plus-more">
                  <button type="button" role="menuitem" onClick={openPicker}>
                    <span className="pm-plus-label">
                      {hiddenCount} more {hiddenCount === 1 ? "server" : "servers"}…
                    </span>
                    <ChevronRightIcon size={13} />
                  </button>
                </div>
              )}
              <div className="pm-plus-foot">
                <p className="menu-note">
                  {foot}
                  {changed && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          setIds(startIds);
                        }}
                      >
                        {resetLabel}
                      </button>
                    </>
                  )}
                </p>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    reloadWithParams({ scene: "servers", page: null, open: null });
                  }}
                >
                  Open MCP settings
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {picking && (
        <ServerPickerDialog
          w={w}
          target={{
            title: "MCP servers of this thread",
            ids,
            onChange: setIds,
            foot,
            reset: { label: resetLabel, ids: startIds },
          }}
          onClose={() => {
            setPicking(false);
          }}
        />
      )}
      {fixingServer !== undefined &&
        (fixingConnection === undefined ? (
          <AddServerDialog
            w={w}
            resume={fixingServer}
            onClose={() => {
              setFixing(null);
            }}
            onOpenServer={() => undefined}
            onOpenConnections={() => undefined}
          />
        ) : (
          <ReconnectDialog
            connection={fixingConnection}
            server={fixingServer}
            onClose={() => {
              setFixing(null);
            }}
          />
        ))}
    </>
  );
}
