package dev.hercule.android.ui.fixtures

import dev.hercule.android.controller.LiveConnectionState
import dev.hercule.android.faces.Pose
import dev.hercule.android.office.OfficeFace
import dev.hercule.android.office.OfficeLaneKind
import dev.hercule.android.office.buildOffice
import dev.hercule.android.ui.assistant.AssistantUiState
import dev.hercule.android.ui.assistant.ReminderCard
import dev.hercule.android.ui.you.YouUiState
import dev.hercule.android.ui.you.FontLicence
import dev.hercule.android.ui.office.OfficeUiState
import dev.hercule.android.ui.thread.ThreadUiState
import dev.hercule.android.ui.thread.buildThreadBlocks
import dev.hercule.android.wire.AccessMode
import dev.hercule.android.wire.ApprovalDecision
import dev.hercule.android.wire.Assistant
import dev.hercule.android.wire.AssistantReply
import dev.hercule.android.wire.CommandApproval
import dev.hercule.android.wire.ConversationMessage
import dev.hercule.android.wire.ConversationSenderRole
import dev.hercule.android.wire.ItemKind
import dev.hercule.android.wire.ItemStatus
import dev.hercule.android.wire.ModelSelection
import dev.hercule.android.wire.Project
import dev.hercule.android.wire.ProviderEvent
import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionOption
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.Runner
import dev.hercule.android.wire.RunnerConnectivity
import dev.hercule.android.wire.RunnerLifecycle
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionRequest
import dev.hercule.android.wire.SessionStatus
import dev.hercule.android.wire.StreamKind
import dev.hercule.android.wire.TranscriptRow
import java.time.ZoneId
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.Instant
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * The records of the Bureau book's phone pages (docs/design/crew-bureau-2/mobile), as the
 * controller would return them, so the screens can be drawn and compared with the book before
 * the app reads a real controller. The threads' and assistants' ids are the ones
 * apps/desktop/scripts/find-look-seeds.ts finds for the looks the book casts them in, so each
 * colleague has the book's face. The one exception is "Investigate backup timeouts": the book
 * gives it a tache and a homburg, which no id can produce, so its id gives the homburg alone.
 */

/** The moment the book's pages are drawn at: Tuesday 29 September 2026, 09:41 UTC. */
val BOOK_NOW: Instant = Instant.parse("2026-09-29T09:41:00Z")

private val UTC: ZoneId = ZoneId.of("UTC")

private const val SEED_PREFIX = "01a0ec64-6e80-7000-8000-000000000"
private const val FIX_ID = "${SEED_PREFIX}024"
private const val ADA_ID = "${SEED_PREFIX}170"
private const val ADA_CONVERSATION_ID = "01a1342e-4f01-73c8-8216-1254c937bdd9"
private const val MILO_ID = "${SEED_PREFIX}0a1"
private const val JUNO_ID = "${SEED_PREFIX}30b"

private val WEBSHOP = buildProject("p-webshop", "webshop")
private val PAYMENTS = buildProject("p-payments", "payments-api")
private val OPS = buildProject("p-ops", "ops")
private val PROJECTS = listOf(WEBSHOP, PAYMENTS, OPS)

private val BUILD_BOX_1 = buildRunner("r-build-box-1", "build-box-1", maxConcurrentSessions = 8)
private val STUDIO_MAC = buildRunner("r-studio-mac", "studio-mac", maxConcurrentSessions = 6)
private val BUILD_BOX_2 = buildRunner("r-build-box-2", "build-box-2", maxConcurrentSessions = 8)

/** The Request the Fix thread waits on: may the agent push its branch. */
private val PUSH_REQUEST = CommandApproval(
    requestId = "rq-fix-push",
    itemId = "it-push",
    detail = CommandApproval.Detail("git push -u origin fix/3ds-eu-cards"),
    decisions = listOf(ApprovalDecision.Allow, ApprovalDecision.AllowAlways, ApprovalDecision.Deny),
)

private val GRAFANA_QUESTION = QuestionRequest(
    requestId = "rq-migrate-grafana",
    itemId = "it-grafana",
    detail = QuestionRequest.Detail(
        listOf(
            Question(
                question = "Keep the old Grafana folder?",
                header = "Old folder",
                options = listOf(
                    QuestionOption("Keep it", "Leave the old dashboards beside the new ones"),
                    QuestionOption("Delete it", "Remove the old folder once the new one loads"),
                ),
                multiSelect = false,
            ),
        ),
    ),
)

private val PUBLISH_QUESTION = QuestionRequest(
    requestId = "rq-ship-publish",
    itemId = "it-publish",
    detail = QuestionRequest.Detail(
        listOf(
            Question(
                question = "Publish payments-api 2.15.0 to npm?",
                header = "Publish",
                options = listOf(
                    QuestionOption("Publish", "Release 2.15.0 to npm now"),
                    QuestionOption("Wait", "Keep the release as a draft"),
                ),
                multiSelect = false,
            ),
        ),
    ),
)

/** The threads of office.html, and the paused run, which holds a slot on build-box-1. */
private val SESSIONS: List<Session> = listOf(
    buildSession(FIX_ID, "Fix 3‑D Secure checkout for EU cards", WEBSHOP, STUDIO_MAC, SessionStatus.Busy, 10, PUSH_REQUEST),
    buildSession("${SEED_PREFIX}203", "Read the Stripe v14 changelog", WEBSHOP, STUDIO_MAC, SessionStatus.Idle, 20),
    buildSession("${SEED_PREFIX}019", "Migrate ops dashboards", OPS, STUDIO_MAC, SessionStatus.Busy, 6, GRAFANA_QUESTION),
    buildSession("${SEED_PREFIX}03b", "Investigate backup timeouts", OPS, BUILD_BOX_1, SessionStatus.Busy, 6),
    buildSession("${SEED_PREFIX}00c", "Refactor cart totals", WEBSHOP, BUILD_BOX_1, SessionStatus.Busy, 22),
    buildSession("${SEED_PREFIX}0f7", "Webhook retry backoff", PAYMENTS, BUILD_BOX_1, SessionStatus.Busy, 3),
    buildSession("${SEED_PREFIX}1ae", "Cart total rounding on discounts", WEBSHOP, BUILD_BOX_1, SessionStatus.Busy, 9),
    buildSession("${SEED_PREFIX}02d", "Payout report for September", PAYMENTS, BUILD_BOX_1, SessionStatus.Busy, 14),
    buildSession("${SEED_PREFIX}06f", "Rotate staging secrets", OPS, BUILD_BOX_1, SessionStatus.Busy, 17),
    buildSession("${SEED_PREFIX}01e", "Tidy checkout CSS", WEBSHOP, BUILD_BOX_1, SessionStatus.Idle, 120),
    buildSession("${SEED_PREFIX}043", "Ship release v2.15", PAYMENTS, BUILD_BOX_2, SessionStatus.Busy, 2, PUBLISH_QUESTION),
    buildSession("${SEED_PREFIX}0d5", "Add iDEAL research", PAYMENTS, BUILD_BOX_2, SessionStatus.Idle, 60),
    buildSession("${SEED_PREFIX}002", "Draft reply to Jonas at Kiteworks", null, BUILD_BOX_2, SessionStatus.Busy, 11),
    buildSession("${SEED_PREFIX}00b", "Label new issues", WEBSHOP, BUILD_BOX_1, SessionStatus.Busy, 87).copy(runId = "run-label"),
)

private val ADA = buildAssistant(ADA_ID, "Ada", ADA_CONVERSATION_ID)
private val MILO = buildAssistant(MILO_ID, "Milo", "c-milo")
private val JUNO = buildAssistant(JUNO_ID, "Juno", "c-juno")

/** The current session of each assistant's main conversation: Ada answers, Milo idles, Juno sleeps. */
private val ASSISTANT_SESSIONS: Map<String, Session> = mapOf(
    ADA_ID to buildSession("s-ada", "Ada", null, STUDIO_MAC, SessionStatus.Busy, 0).copy(agentId = ADA_ID, conversationId = ADA_CONVERSATION_ID),
    MILO_ID to buildSession("s-milo", "Milo", null, STUDIO_MAC, SessionStatus.Idle, 40).copy(agentId = MILO_ID, conversationId = "c-milo"),
    JUNO_ID to buildSession("s-juno", "Juno", null, BUILD_BOX_2, SessionStatus.Exited, 300)
        .copy(agentId = JUNO_ID, conversationId = "c-juno", resumable = true),
)

/** Returns the Office of office.html, built by `buildOffice` from the book's records. */
fun buildBookOfficeState(): OfficeUiState = OfficeUiState(
    office = buildOffice(
        sessions = SESSIONS,
        assistants = listOf(ADA, MILO, JUNO),
        currentSessions = ASSISTANT_SESSIONS,
        runners = listOf(BUILD_BOX_1, STUDIO_MAC, BUILD_BOX_2),
        projects = PROJECTS,
        now = BOOK_NOW,
    ),
    projects = PROJECTS,
    answeredRequestIds = emptySet(),
)

/** Returns the Fix thread of session-active.html, waiting on the user to allow `git push`. */
fun buildBookThreadState(): ThreadUiState {
    val waiting = buildBookOfficeState().office.lanes.firstOrNull { it.kind == OfficeLaneKind.Waiting }
    return ThreadUiState(
        title = "Fix 3‑D Secure checkout for EU cards",
        face = OfficeFace(FIX_ID, Pose.Waiting, isAssistant = false),
        projectName = WEBSHOP.name,
        blocks = buildThreadBlocks(FIX_TRANSCRIPT, listOf(PUSH_REQUEST)),
        openRequest = PUSH_REQUEST,
        openRequestAnswered = false,
        waitingCount = waiting?.rows?.size ?: 0,
        now = BOOK_NOW,
        zone = UTC,
    )
}

/** Returns Ada's main conversation of assistant.html, with Ada answering the backup question. */
fun buildBookAssistantState(): AssistantUiState = AssistantUiState(
    name = ADA.name,
    face = OfficeFace(ADA_ID, Pose.Working, isAssistant = true),
    answering = true,
    answerSoFar = "Milo started an investigation at 09:35 on build-box-1. So far: the backup job's `pg_dump` has been " +
        "slower each night since the table `events` passed 40 GB",
    messages = ADA_MESSAGES,
    sessionId = null,
    openRequest = null,
    openRequestAnswered = false,
    reminder = ReminderCard("m-ada-4", "Renew the SSL cert for ops", "Fri 2 Oct · 09:00 · to Web chat"),
    zone = UTC,
)

/** Returns the You screen signed in to studio-mac and connected, with the app's [licences]. */
fun buildBookYouState(licences: List<FontLicence>): YouUiState = YouUiState(
    username = "rogier",
    controllerUrl = "http://studio-mac.local:7777",
    connection = LiveConnectionState.Connected("studio-mac.local:7777"),
    showsOneUiNote = true,
    licences = licences,
    waitingCount = buildBookOfficeState().office.lanes.firstOrNull { it.kind == OfficeLaneKind.Waiting }?.rows?.size ?: 0,
)

/** The moment the Fix thread's turn started: 09:02 UTC. */
private val TURN_START: Instant = Instant.parse("2026-09-29T09:02:00Z")

private const val TURN_ID = "turn-1"

/** The agent's first message: the cause, the fix, and how it was made. */
private val CAUSE_MESSAGE = listOf(
    "Found it. Since Stripe SDK v14, `confirmPayment` returns `status: 'requires_action'` for cards " +
        "that need 3‑D Secure. `handlePaymentResult` in `src/checkout/payment.ts` only handles " +
        "`succeeded` and treats everything else as a failure, so we show \"Card declined\" instead of " +
        "opening the 3‑D Secure modal.",
    "",
    "```ts",
    "if (result.status === \"requires_action\") {",
    "  return openThreeDSModal(result.clientSecret);",
    "}",
    "```",
    "",
    "I wrote a failing test first, then the fix.",
).joinToString("\n")

/**
 * The Fix thread's events, the desktop's `FIX_STEPS` (apps/desktop/src/renderer/specimens/
 * thread-fixture.ts) in seconds after 09:02: the user's message, six reads and a command, the
 * agent's first message at 2m 14s, three edits and the test run, the agent's second message, and
 * the Request to push at 09:31.
 */
private val FIX_STEPS: List<Pair<Int, ProviderEvent>> = listOf<Pair<Int, ProviderEvent>>(
    0 to ProviderEvent.TurnStarted(turnId = TURN_ID, model = "claude-opus-5-5"),
) + runItem(
    0, 0, "it-ask", ItemKind.UserMessage,
    buildJsonObject {
        put(
            "text",
            "Checkout fails for EU cards that need 3‑D Secure since deploy #1289. Find the cause " +
                "and fix it. Add a test that reproduces it first.",
        )
    },
) +
    runTool(5, 6, "it-read-1", ItemKind.FileRead, "Read", "file_path", "src/checkout/payment.ts") +
    runTool(12, 13, "it-read-2", ItemKind.FileRead, "Read", "file_path", "src/checkout/stripe.ts") +
    runTool(20, 21, "it-read-3", ItemKind.FileRead, "Read", "file_path", "src/checkout/3ds-modal.tsx") +
    runTool(31, 32, "it-read-4", ItemKind.FileRead, "Read", "file_path", "src/checkout/checkout.tsx") +
    runTool(45, 46, "it-read-5", ItemKind.FileRead, "Read", "file_path", "package.json") +
    runTool(58, 59, "it-read-6", ItemKind.FileRead, "Read", "file_path", "CHANGELOG.md") +
    runTool(70, 74, "it-log", ItemKind.CommandExecution, "Bash", "command", "git log --oneline -5 -- src/checkout") +
    runItem(134, 140, "it-cause", ItemKind.AssistantMessage, null, CAUSE_MESSAGE) +
    runTool(145, 150, "it-test", ItemKind.FileChange, "Write", "file_path", "src/checkout/payment.test.ts") +
    runTool(170, 176, "it-fix", ItemKind.FileChange, "Edit", "file_path", "src/checkout/payment.ts") +
    runTool(190, 195, "it-modal", ItemKind.FileChange, "Edit", "file_path", "src/checkout/3ds-modal.tsx") +
    runTool(210, 300, "it-run-tests", ItemKind.CommandExecution, "Bash", "command", "pnpm test checkout") +
    runItem(431, 434, "it-ready", ItemKind.AssistantMessage, null, "Tests pass. Ready to push the branch and open a pull request.") +
    listOf(1740 to ProviderEvent.RequestOpened(request = PUSH_REQUEST))

/** The Fix thread's transcript rows: [FIX_STEPS] with positions from 1. */
private val FIX_TRANSCRIPT: List<TranscriptRow> = FIX_STEPS.mapIndexed { index, (seconds, event) ->
    TranscriptRow(index + 1L, (TURN_START + seconds.seconds).toString(), event)
}

/**
 * Returns the events of one item that runs from [from] to [to] seconds: its start with [detail],
 * the [text] it wrote when given, and its completion.
 */
private fun runItem(from: Int, to: Int, itemId: String, kind: ItemKind, detail: JsonObject?, text: String? = null): List<Pair<Int, ProviderEvent>> =
    listOfNotNull(
        from to ProviderEvent.ItemStarted(turnId = TURN_ID, itemId = itemId, kind = kind, detail = detail),
        text?.let { to to ProviderEvent.ContentDelta(turnId = TURN_ID, itemId = itemId, streamKind = StreamKind.AssistantText, delta = it) },
        to to ProviderEvent.ItemCompleted(turnId = TURN_ID, itemId = itemId, kind = kind, detail = detail, status = ItemStatus.Completed),
    )

/**
 * Returns the events of a tool call as Claude Code reports it: the tool's [name] and its input,
 * which holds [inputKey] set to [inputValue]. A file read also carries `path`, as the adapter
 * sets it from the input's `file_path`.
 */
private fun runTool(from: Int, to: Int, itemId: String, kind: ItemKind, name: String, inputKey: String, inputValue: String) =
    runItem(
        from, to, itemId, kind,
        buildJsonObject {
            if (kind == ItemKind.FileRead) put("path", inputValue)
            put("name", name)
            put("input", buildJsonObject { put(inputKey, inputValue) })
        },
    )

/** Ada's main conversation, as assistant.html draws it up to the backup question. */
private val ADA_MESSAGES: List<ConversationMessage> = listOf(
    buildAdaMessage(
        2, ConversationSenderRole.Assistant, "Ada", "2026-09-29T09:00:00Z",
        "Morning Rogier. Triage found one urgent thing: EU card payments that need 3‑D Secure have " +
            "failed since yesterday's deploy. You started a fix at 09:02; it's waiting on your OK to push. " +
            "Also: Marta at Brightline wants her invoice in the company name - I can draft that.",
    ),
    buildAdaMessage(3, ConversationSenderRole.Owner, "rogier", "2026-09-29T09:20:00Z", "Remind me Friday to renew the SSL cert for ops."),
    buildAdaMessage(4, ConversationSenderRole.Assistant, "Ada", "2026-09-29T09:20:30Z", "Done. I'll remind you Friday 2 October at 09:00."),
    buildAdaMessage(5, ConversationSenderRole.Owner, "rogier", "2026-09-29T09:38:00Z", "What's the status of the backup job?"),
)

/** Returns message [position] of Ada's main conversation, with the id `m-ada-<position>`. */
fun buildAdaMessage(position: Long, role: ConversationSenderRole, label: String, at: String, text: String) = ConversationMessage(
    id = "m-ada-$position",
    conversationId = ADA_CONVERSATION_ID,
    containerKey = null,
    position = position,
    senderRole = role,
    senderLabel = label,
    text = text,
    sessionId = if (role == ConversationSenderRole.Owner) null else "s-ada",
    turnId = null,
    itemId = null,
    actor = if (role == ConversationSenderRole.Owner) "user" else "session:s-ada",
    createdAt = Instant.parse(at),
)

/** Returns a session of the book, last active [minutesAgo] minutes before [BOOK_NOW]. */
private fun buildSession(
    id: String,
    title: String,
    project: Project?,
    runner: Runner,
    status: SessionStatus,
    minutesAgo: Int,
    request: SessionRequest? = null,
): Session {
    val lastActivityAt = BOOK_NOW - minutesAgo.minutes
    return Session(
        id = id,
        title = title,
        status = status,
        resumable = false,
        resumeHeld = false,
        permissionProfileId = "p-worker",
        agentId = null,
        conversationId = null,
        runId = null,
        stepId = null,
        instanceId = "i-claude-code",
        runnerId = runner.id,
        workspaceId = null,
        projectId = project?.id,
        requestedAccessMode = AccessMode.ApprovalRequired,
        accessMode = AccessMode.ApprovalRequired,
        nativeSessionId = null,
        modelSelection = ModelSelection("claude-opus-5-5", emptyMap()),
        parentSessionId = null,
        openRequests = listOfNotNull(request),
        openPermissionRequests = emptyList(),
        toolCalls = 0,
        createdAt = lastActivityAt,
        startedAt = lastActivityAt,
        exitedAt = if (status == SessionStatus.Exited) lastActivityAt else null,
        lastActivityAt = lastActivityAt,
    )
}

private fun buildRunner(id: String, name: String, maxConcurrentSessions: Int) = Runner(
    id = id,
    name = name,
    connectivity = RunnerConnectivity.Online,
    lifecycle = RunnerLifecycle.Active,
    reserved = false,
    version = "0.9.0",
    labels = emptyList(),
    maxConcurrentSessions = maxConcurrentSessions,
    lastSeenAt = BOOK_NOW,
)

private fun buildProject(id: String, name: String) = Project(id = id, name = name, createdAt = BOOK_NOW, updatedAt = BOOK_NOW)

private fun buildAssistant(id: String, name: String, mainConversationId: String) = Assistant(
    id = id,
    name = name,
    instanceId = "i-claude-code",
    permissionProfileId = "p-assistant",
    accessMode = AccessMode.ApprovalRequired,
    model = null,
    createdAt = BOOK_NOW,
    updatedAt = BOOK_NOW,
    reply = AssistantReply.TurnEnd,
    mainConversationId = mainConversationId,
)
