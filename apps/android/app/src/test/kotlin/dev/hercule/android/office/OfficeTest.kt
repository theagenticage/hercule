package dev.hercule.android.office

import dev.hercule.android.faces.Pose
import dev.hercule.android.wire.Question
import dev.hercule.android.wire.QuestionOption
import dev.hercule.android.wire.QuestionRequest
import dev.hercule.android.wire.RunnerLifecycle
import dev.hercule.android.wire.SessionStatus
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant
import org.junit.Test

/** Tests [buildOffice] on a small world modelled on the book's Office page. */
class OfficeTest {
    private val now = Instant.parse("2026-09-10T10:00:00.000Z")
    private fun ago(duration: Duration) = now - duration

    private val studio = buildRunner("r-studio", "studio-mac", maxConcurrentSessions = 6)
    private val box = buildRunner("r-box", "build-box-1", maxConcurrentSessions = 8)
    private val retired = buildRunner("r-old", "old-box", lifecycle = RunnerLifecycle.Retired)
    private val webshop = buildProject("p-web", "webshop")
    private val ops = buildProject("p-ops", "ops")

    private val push = buildCommandRequest("q-push", "git push -u origin fix/3ds-eu-cards")
    private val grafana = QuestionRequest(
        "q-grafana",
        "tool-1",
        QuestionRequest.Detail(
            listOf(
                Question(
                    "Keep the old Grafana folder?",
                    "Folder",
                    listOf(QuestionOption("Keep", ""), QuestionOption("Delete", "")),
                    multiSelect = false,
                ),
            ),
        ),
    )

    private val threads = listOf(
        buildSession("s-3ds", "Fix 3-D Secure checkout", SessionStatus.Busy, runnerId = studio.id, projectId = webshop.id, openRequests = listOf(push), lastActivityAt = ago(10.minutes)),
        buildSession("s-ops", "Migrate ops dashboards", SessionStatus.Idle, runnerId = studio.id, projectId = ops.id, openRequests = listOf(grafana), lastActivityAt = ago(6.minutes)),
        buildSession("s-cart", "Refactor cart totals", SessionStatus.Busy, runnerId = box.id, projectId = webshop.id, lastActivityAt = ago(22.minutes)),
        buildSession("s-hook", "Webhook retry backoff", SessionStatus.Busy, runnerId = box.id, lastActivityAt = ago(3.minutes)),
        buildSession("s-queued", "Rotate staging secrets", SessionStatus.Queued, runnerId = box.id, projectId = "p-deleted", lastActivityAt = ago(15.minutes)),
        buildSession("s-stripe", "Read the Stripe v14 changelog", SessionStatus.Idle, runnerId = studio.id, projectId = webshop.id, lastActivityAt = ago(20.minutes)),
        // Away and asleep threads are not in the Office, but still hold no slot.
        buildSession("s-gone", "An ended thread", SessionStatus.Exited, runnerId = studio.id, lastActivityAt = ago(300.minutes)),
        buildSession("s-nap", "A resumable thread", SessionStatus.Exited, resumable = true, runnerId = studio.id, lastActivityAt = ago(90.minutes)),
        // A run's session is in no lane, but holds a slot on its runner.
        buildSession("s-run", "Ship release v2.15", SessionStatus.Busy, runId = "run-1", runnerId = box.id, openRequests = listOf(buildCommandRequest("q-run", "npm publish"))),
    )
    private val ada = buildAssistant("a-ada", "Ada")
    private val milo = buildAssistant("a-milo", "Milo")
    private val juno = buildAssistant("a-juno", "Juno")
    private val kit = buildAssistant("a-kit", "Kit")
    private val currentSessions = mapOf(
        ada.id to buildSession("s-ada", "Ada", SessionStatus.Busy, agentId = ada.id, conversationId = "c-ada", runnerId = studio.id, lastActivityAt = now),
        milo.id to buildSession("s-milo", "Milo", SessionStatus.Idle, agentId = milo.id, conversationId = "c-milo", runnerId = box.id, lastActivityAt = ago(40.minutes)),
        juno.id to buildSession("s-juno", "Juno", SessionStatus.Exited, resumable = true, agentId = juno.id, conversationId = "c-juno", runnerId = studio.id, lastActivityAt = ago(120.minutes)),
    )

    private val office = buildOffice(
        sessions = threads,
        assistants = listOf(milo, kit, juno, ada),
        currentSessions = currentSessions,
        runners = listOf(studio, box, retired),
        projects = listOf(webshop, ops),
        now = now,
    )

    private fun readLane(kind: OfficeLaneKind) = office.lanes.single { it.kind == kind }

    @Test
    fun `counts each lane in the receipt, in lane order`() {
        assertEquals(listOf("2 waiting on you", "4 working", "3 idle"), office.receipt)
        assertEquals(listOf(OfficeLaneKind.Waiting, OfficeLaneKind.Working, OfficeLaneKind.Idle), office.lanes.map { it.kind })
    }

    @Test
    fun `lists who waits longest first, with the question as the state`() {
        val lane = readLane(OfficeLaneKind.Waiting)
        assertEquals(listOf("s-3ds", "s-ops"), lane.rows.map { it.sessionId })
        assertEquals("10m", lane.oldestAge)
        assertEquals(
            listOf("webshop · Run git push -u origin fix/3ds-eu-cards?", "ops · Keep the old Grafana folder?"),
            lane.rows.map { it.detail },
        )
        assertEquals(push, lane.rows.first().request)
    }

    @Test
    fun `lists the working threads and assistants, the most recently active first`() {
        val lane = readLane(OfficeLaneKind.Working)
        assertEquals(listOf("Ada", "Webhook retry backoff", "Rotate staging secrets", "Refactor cart totals"), lane.rows.map { it.title })
        assertEquals(listOf("now", "3m", "15m", "22m"), lane.rows.map { it.age })
        assertEquals("22m", lane.oldestAge)
        // An assistant reads "Assistant"; a thread with no project, or one the list does not
        // hold, shows its state alone.
        assertEquals(listOf("Assistant · working", "working", "working", "webshop · working"), lane.rows.map { it.detail })
    }

    @Test
    fun `puts an assistant with no session last in the idle lane, with no age`() {
        val lane = readLane(OfficeLaneKind.Idle)
        assertEquals(listOf("Read the Stripe v14 changelog", "Milo", "Kit"), lane.rows.map { it.title })
        assertEquals(listOf("20m", "40m", null), lane.rows.map { it.age })
        assertEquals("40m", lane.oldestAge)
        val kitRow = lane.rows.last()
        assertNull(kitRow.sessionId)
        assertEquals(OfficeFace("a-kit", Pose.Idle, isAssistant = true), kitRow.face)
        assertEquals("Assistant · idle", kitRow.detail)
    }

    @Test
    fun `seats the asleep assistants in the lobby and in no lane`() {
        assertEquals(listOf("a-juno"), office.lobby.map { it.assistantId })
        assertEquals(Pose.Asleep, office.lobby.single().pose)
        assertEquals("Assistant · asleep", office.lobby.single().detail)
        assertEquals(emptyList(), office.lanes.flatMap { it.rows }.filter { it.assistantId == "a-juno" })
    }

    @Test
    fun `draws a field per runner that is not retired, with the faces seated there and its capacity`() {
        assertEquals(listOf("r-studio", "r-box"), office.fields.map { it.runner.id })
        val (studioField, boxField) = office.fields
        assertEquals(
            listOf(
                OfficeFace("s-3ds", Pose.Waiting, isAssistant = false),
                OfficeFace("s-ops", Pose.Waiting, isAssistant = false),
                OfficeFace("a-ada", Pose.Working, isAssistant = true),
                OfficeFace("s-stripe", Pose.Idle, isAssistant = false),
            ),
            studioField.faces,
        )
        assertEquals("4 running of 6", studioField.capacity)
        assertEquals(listOf("s-hook", "s-queued", "s-cart", "a-milo"), boxField.faces.map { it.seed })
        // The run's session holds a slot on build-box-1 though it has no face there.
        assertEquals("4 running of 8 · 1 queued", boxField.capacity)
    }

    @Test
    fun `draws no lane and no count when nobody is at work`() {
        val empty = buildOffice(emptyList(), emptyList(), emptyMap(), listOf(studio), emptyList(), now)
        assertEquals(Office(receipt = emptyList(), fields = listOf(OfficeField(studio, emptyList(), "0 running of 6")), lobby = emptyList(), lanes = emptyList()), empty)
    }
}
