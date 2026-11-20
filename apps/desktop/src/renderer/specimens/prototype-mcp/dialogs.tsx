/**
 * PROTOTYPE, throwaway. The dialogs of the MCP prototype: adding a server by
 * URL (with the sign-in the server asks for), signing in again, Replace,
 * Remove, and reconnecting a Connection. Every wait is a timer; nothing is
 * sent anywhere.
 */
import { useRef, useState, type JSX, type ReactNode } from "react";
import { ExternalIcon } from "../../icons/external";
import { KeyIcon } from "../../icons/key";
import { LockIcon } from "../../icons/lock";
import { ConfirmDialog } from "../../screens/confirm-dialog";
import { GlassDialog } from "../../screens/glass-dialog";
import {
  DoneMark,
  FormField,
  MarkedRow,
  MarkedRows,
  NumberedStep,
  WaitLine,
} from "../../screens/step";
import "../../screens/settings/connections/connection-setup.css";
import { ToolsIcon } from "./parts";
import {
  addUrlServer,
  deleteServer,
  describeAddress,
  describeConnection,
  describeServerName,
  findConnectionServer,
  finishCheck,
  listServerProjects,
  PLUGIN_ORIGINS,
  readOrigin,
  replaceWithConnection,
  setServer,
  type Conn,
  type Server,
  type Tool,
  type UrlSignIn,
  type World,
} from "./world";

/** The address the controller of this prototype is reached at: plain HTTP on the tailnet. */
const CONTROLLER = "http://studio-mac.tail9a41.ts.net:4937";
/** Where a sign-in returns to: a listener on the machine the browser runs on. MCP allows only that or HTTPS. */
const LOCAL_REDIRECT = "http://127.0.0.1:53682/callback";
/** The controller's address once HTTPS is on: its name in the tailnet. */
const CONTROLLER_HTTPS = "https://studio-mac.tail9a41.ts.net";

/** A strip inside a dialog that is not part of the design: it fills in examples and sets the prototype's knobs. */
function Aid({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="pm-aid">
      <span>Prototype</span>
      {children}
    </div>
  );
}

const EXAMPLES: ReadonlyArray<{
  readonly label: string;
  readonly url: string;
}> = [
  { label: "OAuth", url: "https://mcp.figma.com/mcp" },
  { label: "token", url: "https://docs.acme.example/mcp" },
  { label: "no sign-in", url: "https://mcp.deepwiki.com/mcp" },
  { label: "a plugin's", url: "https://mcp.sentry.dev/mcp" },
  { label: "added before", url: "https://mcp.notion.com/mcp" },
];

const EXAMPLE_TOOLS: Readonly<Record<string, readonly Tool[]>> = {
  figma: [
    { name: "get_design_context", description: "Read the layout and styles of a frame." },
    { name: "get_screenshot", description: "Take a picture of a frame." },
    { name: "get_metadata", description: "List the layers of a page." },
    { name: "get_variable_defs", description: "Read the variables a frame uses." },
  ],
  deepwiki: [
    { name: "read_wiki_structure", description: "List the topics of a repository's wiki." },
    { name: "read_wiki_contents", description: "Read a repository's wiki." },
    { name: "ask_question", description: "Ask a question about a repository." },
  ],
  docs: [
    { name: "search_docs", description: "Search the internal documentation." },
    { name: "read_page", description: "Read one page." },
  ],
};

/** Returns the name a server at `url` gets until the user types one: the host's main word. */
const suggestName = (url: string): string => {
  const origin = readOrigin(url);
  if (origin === null) return "";
  const parts = new URL(origin).hostname
    .split(".")
    .filter((part) => part !== "mcp" && part !== "www");
  return (parts.length > 2 ? parts[0]! : (parts.at(-2) ?? parts[0] ?? "")).replace(
    /[^a-z0-9_-]/g,
    "",
  );
};

type Refusal =
  | { readonly kind: "plugin"; readonly pluginName: string; readonly connections: readonly Conn[] }
  | { readonly kind: "added"; readonly server: Server };

/** Returns why `url` cannot be added by hand, or null when it can. */
const findRefusal = (w: World, url: string): Refusal | null => {
  const origin = readOrigin(url);
  const pluginId = Object.keys(PLUGIN_ORIGINS).find((id) => PLUGIN_ORIGINS[id] === origin);
  if (pluginId !== undefined) {
    return {
      kind: "plugin",
      pluginName: pluginId[0]!.toUpperCase() + pluginId.slice(1),
      connections: w.connections.filter((connection) => connection.pluginId === pluginId),
    };
  }
  const server = w.servers.find(
    (each) => each.source.kind === "user" && readOrigin(each.source.url) === origin,
  );
  return server === undefined ? null : { kind: "added", server };
};

type AddStep = "form" | "probing" | "token" | "oauth" | "browser" | "listing" | "done";

/** Who catches the browser's answer after the user approves. */
type ReturnPath = "app" | "controller" | "relay" | "paste";

const RETURN_PATHS: ReadonlyArray<{ readonly id: ReturnPath; readonly label: string }> = [
  { id: "app", label: "desktop app" },
  { id: "controller", label: "web app, HTTPS on the controller" },
  { id: "relay", label: "web app, a page on hercule.sh" },
  { id: "paste", label: "web app, no HTTPS" },
];

/**
 * Adds a server by URL, or, with `resume`, signs in again to one that needs
 * it. The controller finds out what the server needs: nothing, a token, or
 * OAuth. For OAuth, the browser's answer must reach the controller, and the
 * dialog draws the three ways it can:
 *
 * - the desktop app listens on this machine for the browser's return, and
 *   hands what it gets to the controller. The dialog only waits. This is the
 *   usual case;
 * - the controller has HTTPS, so the browser returns to the controller
 *   itself. The dialog only waits;
 * - a page the project hosts on hercule.sh takes the return and sends the
 *   browser on to the controller. The dialog only waits. Not decided;
 * - none of these, as in the web app with a controller on plain HTTP: the
 *   user pastes the address the browser ended on.
 */
export function AddServerDialog({
  w,
  resume,
  onClose,
  onOpenServer,
  onOpenConnections,
}: {
  readonly w: World;
  readonly resume?: Server | undefined;
  readonly onClose: () => void;
  readonly onOpenServer: (serverId: string) => void;
  readonly onOpenConnections: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const resumeSource = resume?.source.kind === "user" ? resume.source : undefined;
  const [step, setStep] = useState<AddStep>(
    resumeSource === undefined ? "form" : resumeSource.signIn === "token" ? "token" : "oauth",
  );
  const [url, setUrl] = useState(resumeSource?.url ?? "");
  const [name, setName] = useState(resume?.name ?? "");
  const [nameTyped, setNameTyped] = useState(resume !== undefined);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<UrlSignIn>(resumeSource?.signIn ?? "oauth");
  const [token, setToken] = useState("");
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [showsPaste, setShowsPaste] = useState(false);
  const [returnPath, setReturnPath] = useState<ReturnPath>("app");
  const [addedId, setAddedId] = useState<string | null>(resume?.id ?? null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const host = readOrigin(url)?.replace(/^https?:\/\//, "") ?? "the server";
  const close = (): void => dialogRef.current?.close();
  const after = (ms: number, run: () => void): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(run, ms);
  };
  const account = signIn === "oauth" ? "rogier@acme.example" : null;

  /** Lists the tools, then creates the server, or brings the resumed one back. */
  const finish = (how: UrlSignIn): void => {
    setStep("listing");
    after(1300, () => {
      if (resume !== undefined) {
        setServer(resume.id, { status: "ready", statusDetail: null, checkedAt: "now" });
      } else {
        const tools =
          EXAMPLE_TOOLS[Object.keys(EXAMPLE_TOOLS).find((key) => url.includes(key)) ?? "docs"]!;
        setAddedId(addUrlServer(name, url.trim(), how, how === "oauth" ? account : null, tools).id);
      }
      setStep("done");
    });
  };

  const check = (): void => {
    if (readOrigin(url) === null) {
      setUrlError("Enter the server's address, starting with https://.");
      return;
    }
    setUrlError(null);
    const found = findRefusal(w, url);
    setRefusal(found);
    if (found !== null) return;
    setStep("probing");
    after(1100, () => {
      const needs: UrlSignIn = url.includes("deepwiki")
        ? "none"
        : url.includes("acme")
          ? "token"
          : "oauth";
      setSignIn(needs);
      if (needs === "none") finish("none");
      else setStep(needs);
    });
  };

  const openBrowser = (): void => {
    setStep("browser");
    if (returnPath !== "paste") after(2600, () => finish("oauth"));
  };

  const submitPaste = (): void => {
    if (!pasted.includes("code=")) {
      setPasteError(
        "That address has no code in it. Copy the whole address the browser ended on: it starts with http://127.0.0.1 and holds code=.",
      );
      return;
    }
    setPasteError(null);
    finish("oauth");
  };

  const added = addedId === null ? undefined : w.servers.find((each) => each.id === addedId);
  const heading =
    resume !== undefined
      ? resumeSource?.signIn === "token"
        ? `Replace the token of ${resume.name}`
        : `Sign in to ${resume.name} again`
      : "Add an MCP server";

  const pasteField = (
    <>
      <span className="row">
        <span className={pasteError === null ? "field" : "field is-bad"}>
          <input
            className="mono"
            aria-label="The address the browser ended on"
            placeholder={`${LOCAL_REDIRECT}?code=…`}
            spellCheck={false}
            value={pasted}
            onChange={(event) => {
              setPasted(event.target.value);
            }}
          />
        </span>
        <button type="button" className="btn btn--sm btn--accent" onClick={submitPaste}>
          Continue
        </button>
      </span>
      {pasteError !== null && (
        <p className="fl-err" role="alert">
          {pasteError}
        </p>
      )}
    </>
  );

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="setup-dialog pm-add-dialog"
      label={heading}
      onClose={() => {
        clearTimeout(timer.current);
        onClose();
      }}
    >
      <div className="pop-h">
        <b>{heading}</b>
        {step !== "form" && step !== "done" && <span>{host}</span>}
      </div>
      <div className="pop-sec setup-dialog-body">
        {step === "form" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              check();
            }}
          >
            <div className="pm-form">
              <FormField
                label="Address"
                hint="A remote MCP server, reached over HTTPS. The controller calls it, so it must be reachable from there."
                error={urlError}
              >
                <input
                  autoFocus
                  spellCheck={false}
                  placeholder="https://mcp.example.com/mcp"
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setRefusal(null);
                    setUrlError(null);
                    if (!nameTyped) setName(suggestName(event.target.value));
                  }}
                />
              </FormField>
              {refusal !== null && (
                <DuplicateRefusal
                  refusal={refusal}
                  w={w}
                  onOpenConnections={() => {
                    close();
                    onOpenConnections();
                  }}
                  onOpenServer={(id) => {
                    close();
                    onOpenServer(id);
                  }}
                />
              )}
              <FormField
                label="Name"
                hint={
                  <>
                    Agents see its tools as{" "}
                    <code>mcp__{name === "" ? "name" : name}__&lt;tool&gt;</code>.
                  </>
                }
              >
                <input
                  className="mono"
                  spellCheck={false}
                  value={name}
                  onChange={(event) => {
                    setNameTyped(true);
                    setName(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""));
                  }}
                />
              </FormField>
            </div>
            <div className="setup-acts">
              <button type="button" className="btn btn--quiet" onClick={close}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn--accent"
                disabled={url.trim() === "" || name === "" || refusal !== null}
              >
                Check server
              </button>
            </div>
            <Aid>
              {EXAMPLES.map((example) => (
                <button
                  key={example.url}
                  type="button"
                  onClick={() => {
                    setUrl(example.url);
                    setRefusal(null);
                    setUrlError(null);
                    setName(suggestName(example.url));
                    setNameTyped(false);
                  }}
                >
                  {example.label}
                </button>
              ))}
            </Aid>
          </form>
        )}

        {step === "probing" && (
          <div className="pm-wait">
            <WaitLine text={`Asking ${host} what it needs to sign in.`} />
          </div>
        )}

        {step === "token" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (token.trim() !== "") finish("token");
            }}
          >
            <p className="setup-lead">
              {resume === undefined
                ? `${host} asks for a token and offers no sign-in page. The token is kept on the controller and never reaches a runner.`
                : `${host} refused the saved token. Paste a new one. It is kept on the controller and never reaches a runner.`}
            </p>
            <FormField label="Token" hint="Sent as Authorization: Bearer <token>.">
              <input
                type="password"
                autoFocus
                autoComplete="off"
                value={token}
                onChange={(event) => {
                  setToken(event.target.value);
                }}
              />
            </FormField>
            <div className="setup-acts">
              <button type="button" className="btn btn--quiet" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn btn--accent" disabled={token.trim() === ""}>
                Connect
              </button>
            </div>
          </form>
        )}

        {step === "oauth" && (
          <>
            <p className="setup-lead">
              {resume === undefined
                ? `${host} signs in with OAuth. You sign in once, in your browser. The sign-in is kept on the controller, for every runner.`
                : `${host} refused the saved sign-in. Sign in once more, in your browser.`}
            </p>
            <div className="setup-acts">
              <button type="button" className="btn btn--quiet" onClick={close}>
                Cancel
              </button>
              <button type="button" className="btn btn--accent" autoFocus onClick={openBrowser}>
                <ExternalIcon size={14} />
                Sign in with your browser
              </button>
            </div>
            <div className="setup-switches">
              <p className="st-note">
                <KeyIcon size={14} />
                <span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setSignIn("token");
                      setStep("token");
                    }}
                  >
                    Use a token instead
                  </button>
                </span>
              </p>
            </div>
            <Aid>
              {RETURN_PATHS.map((path) => (
                <button
                  key={path.id}
                  type="button"
                  aria-pressed={returnPath === path.id}
                  onClick={() => {
                    setReturnPath(path.id);
                  }}
                >
                  {path.label}
                </button>
              ))}
            </Aid>
          </>
        )}

        {step === "browser" && returnPath !== "paste" && (
          <>
            <MarkedRows>
              <MarkedRow
                mark={<ToolsIcon size={18} />}
                name="Finish in your browser"
                detail={`${host}/authorize`}
                end={
                  <span className="setup-row-acts">
                    <button type="button" className="btn btn--sm">
                      <ExternalIcon size={14} />
                      Open again
                    </button>
                    <button type="button" className="btn btn--sm btn--quiet" onClick={close}>
                      Cancel
                    </button>
                  </span>
                }
              >
                <WaitLine text="Waiting for you to approve Hercule in the browser." />
                <span className="pm-return">
                  {returnPath === "app"
                    ? "The browser comes back to this app, on this Mac. The app hands the answer to the controller."
                    : returnPath === "relay"
                      ? "The browser comes back through hercule.sh, which sends it on to the controller."
                      : `The browser comes back to the controller, at ${CONTROLLER_HTTPS}.`}
                </span>
                {showsPaste && (
                  <div className="pm-paste">
                    <p>
                      Copy the address of the page the browser ended on, from its address bar. It
                      starts with <code>http://127.0.0.1</code>. Paste it here.
                    </p>
                    {pasteField}
                  </div>
                )}
              </MarkedRow>
            </MarkedRows>
            {returnPath === "app" && !showsPaste && (
              <p className="pm-stuck">
                Approved, and the browser did not come back here?
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    clearTimeout(timer.current);
                    setShowsPaste(true);
                  }}
                >
                  Paste the browser's address…
                </button>
              </p>
            )}
          </>
        )}

        {step === "browser" && returnPath === "paste" && (
          <>
            <MarkedRows>
              <MarkedRow
                mark={<ToolsIcon size={18} />}
                name={`Sign in to ${name}`}
                detail={`${host}/authorize`}
                end={
                  <button type="button" className="btn btn--sm btn--quiet" onClick={close}>
                    Cancel
                  </button>
                }
              >
                <NumberedStep number={1}>
                  Sign in on the page that opened, and approve Hercule.
                  <br />
                  <button type="button" className="btn btn--sm">
                    <ExternalIcon size={14} />
                    Open the page again
                  </button>
                </NumberedStep>
                <NumberedStep number={2}>
                  Your browser then goes to an address that starts with{" "}
                  <code>http://127.0.0.1</code>. The page will not load, and that is fine. Copy the
                  address from the address bar and paste it here.
                  {pasteField}
                </NumberedStep>
              </MarkedRow>
            </MarkedRows>
            <p className="st-note pm-why">
              <LockIcon size={14} />
              <span>
                A sign-in may only return to this machine or to HTTPS. A web page cannot listen on
                this machine, and the controller at {CONTROLLER.replace("http://", "")} has no
                HTTPS. The desktop app needs no step 2. Neither does the web app once HTTPS is on
                for the controller, in Settings &gt; System.
              </span>
            </p>
          </>
        )}

        {step === "listing" && (
          <div className="pm-wait">
            <WaitLine
              text={
                account === null
                  ? `Asking ${host} for its tools.`
                  : `Signed in as ${account}. Asking ${host} for its tools.`
              }
            />
          </div>
        )}

        {step === "done" && added !== undefined && (
          <>
            <MarkedRows>
              <MarkedRow
                mark={<ToolsIcon size={18} />}
                name={added.name}
                detail={describeAddress(added)}
                end={<DoneMark>{`ready · ${String(added.tools.length)} tools`}</DoneMark>}
              />
            </MarkedRows>
            {resume === undefined ? (
              <>
                <p className="setup-lead pm-done-lead">
                  No project names it yet, so no thread gets it. Name it in the projects that should
                  use it.
                </p>
                <div className="setup-acts">
                  <button type="button" className="btn btn--quiet" onClick={close}>
                    Done
                  </button>
                  <button
                    type="button"
                    className="btn btn--accent"
                    autoFocus
                    onClick={() => {
                      close();
                      onOpenServer(added.id);
                    }}
                  >
                    Open {added.name}
                  </button>
                </div>
              </>
            ) : (
              <div className="setup-acts">
                <button type="button" className="btn btn--accent" autoFocus onClick={close}>
                  Done
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </GlassDialog>
  );
}

/** Why an address cannot be added by hand, and where to go instead. */
function DuplicateRefusal({
  refusal,
  w,
  onOpenConnections,
  onOpenServer,
}: {
  readonly refusal: Refusal;
  readonly w: World;
  readonly onOpenConnections: () => void;
  readonly onOpenServer: (serverId: string) => void;
}): JSX.Element {
  if (refusal.kind === "added") {
    return (
      <div className="warn pm-refusal">
        <ToolsIcon size={14} />
        <span>
          <b>You added this server before, as {refusal.server.name}.</b> One address and account is
          one server.
          <br />
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              onOpenServer(refusal.server.id);
            }}
          >
            Open {refusal.server.name}
          </button>
        </span>
      </div>
    );
  }
  const on = refusal.connections.filter(
    (connection) => findConnectionServer(w, connection.id) !== undefined,
  );
  const off = refusal.connections.filter(
    (connection) => findConnectionServer(w, connection.id) === undefined,
  );
  return (
    <div className="warn pm-refusal">
      <ToolsIcon size={14} />
      <span>
        <b>The {refusal.pluginName} plugin already offers this server.</b> It is reached with a{" "}
        {refusal.pluginName} Connection, with no second sign-in, so it is not added by hand.{" "}
        {refusal.connections.length === 0
          ? `Add a ${refusal.pluginName} Connection first.`
          : [
              on.length > 0 ? `On: ${on.map(describeConnection).join(", ")}.` : "",
              off.length > 0 ? `Not switched on: ${off.map(describeConnection).join(", ")}.` : "",
            ]
              .filter((part) => part !== "")
              .join(" ")}
        <br />
        <button type="button" className="btn btn--sm" onClick={onOpenConnections}>
          Open Connections
        </button>
      </span>
    </div>
  );
}

/**
 * Asks before a hand-added server is moved to a plugin's Connection. The
 * record keeps its name and the projects that name it.
 */
export function ReplaceDialog({
  w,
  connection,
  server,
  onClose,
}: {
  readonly w: World;
  readonly connection: Conn;
  readonly server: Server;
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const projects = listServerProjects(w, server.id);
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={`Replace the ${server.name} server you added?`}
      actionLabel="Replace"
      actionClass="accent"
      initialFocus="action"
      onConfirm={() => {
        replaceWithConnection(server.id, connection.id);
        dialogRef.current?.close();
      }}
      onClose={onClose}
    >
      <p>
        You added <code>{describeAddress(server)}</code> by hand, with a sign-in of its own.{" "}
        {describeConnection(connection)} reaches the same server, as the same account, and one
        address and account is one server.
      </p>
      <div className="pm-replace">
        <div>
          <span>Stays</span>
          <b>
            The name <code>{server.name}</code>
            {projects.length > 0 &&
              `, and the ${projects.length === 1 ? "project" : "projects"} that ${projects.length === 1 ? "names" : "name"} it: ${projects.map((project) => project.name).join(", ")}`}
          </b>
        </div>
        <div>
          <span>Changes</span>
          <b>It acts through {describeConnection(connection)}</b>
        </div>
        <div>
          <span>Goes</span>
          <b>
            The sign-in you made by hand
            {server.status === "needs-sign-in" && ", which needs a new sign-in anyway"}
          </b>
        </div>
      </div>
    </ConfirmDialog>
  );
}

/** Asks before a server is removed, and names the projects that lose it. */
export function RemoveDialog({
  w,
  server,
  onClose,
  onRemoved,
}: {
  readonly w: World;
  readonly server: Server;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const projects = listServerProjects(w, server.id);
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={`Remove ${describeServerName(w, server)}?`}
      actionLabel="Remove"
      actionClass="danger"
      initialFocus="close"
      onConfirm={() => {
        dialogRef.current?.close();
        deleteServer(server.id);
        onRemoved();
      }}
      onClose={onClose}
    >
      <p>
        {projects.length === 0
          ? "No project names it."
          : `${projects.map((project) => project.name).join(" and ")} ${projects.length === 1 ? "names" : "name"} it. New threads there no longer get its tools.`}{" "}
        A thread that is running keeps its list, and a call it makes to this server fails with the
        reason.
      </p>
    </ConfirmDialog>
  );
}

/**
 * Stands in for the Connection's own Reconnect dialog, which exists: one
 * sign-in brings the Connection and its server back together.
 */
export function ReconnectDialog({
  connection,
  server,
  onClose,
}: {
  readonly connection: Conn;
  readonly server: Server;
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const heading = `Reconnect ${describeConnection(connection)}`;
  return (
    <GlassDialog dialogRef={dialogRef} className="setup-dialog" label={heading} onClose={onClose}>
      <div className="pop-h">
        <b>{heading}</b>
      </div>
      <div className="pop-sec setup-dialog-body">
        <p className="setup-lead">
          {`You sign in to ${connection.typeName} in your browser. The Connection and the ${server.name} server come back together.`}
        </p>
        <div className="setup-acts">
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => dialogRef.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--accent"
            autoFocus
            onClick={() => {
              finishCheck(server.id);
              dialogRef.current?.close();
            }}
          >
            Sign in with {connection.typeName}
          </button>
        </div>
      </div>
    </GlassDialog>
  );
}
