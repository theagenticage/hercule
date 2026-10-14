package dev.hercule.android.office

import dev.hercule.android.faces.Pose
import dev.hercule.android.wire.Assistant
import dev.hercule.android.wire.Project
import dev.hercule.android.wire.Runner
import dev.hercule.android.wire.RunnerLifecycle
import dev.hercule.android.wire.Session
import dev.hercule.android.wire.SessionRequest
import kotlin.time.Instant

/**
 * Everything the Office screen draws (the book's mobile/office.html), from top to bottom:
 *
 * - [receipt]: one count per lane in [lanes], in the same order, such as
 *   `["3 waiting on you", "8 working", "4 idle"]`. The screen joins them with " · " and draws
 *   the first in the waiting colour when the first lane is [OfficeLaneKind.Waiting];
 * - [fields]: the plan, one field per runner that is not retired;
 * - [lobby]: the asleep assistants, who sit in the plan's Lobby;
 * - [lanes]: the lanes that have at least one row, in the order Waiting on you, Working, Idle.
 */
data class Office(
    val receipt: List<String>,
    val fields: List<OfficeField>,
    val lobby: List<OfficeRow>,
    val lanes: List<OfficeLane>,
)

/** The kinds of lane, in the order the Office shows them, with their title and receipt words. */
enum class OfficeLaneKind(val title: String, val receiptWords: String) {
    Waiting("Waiting on you", "waiting on you"),
    Working("Working", "working"),
    Idle("Idle", "idle"),
}

/**
 * One lane of the Office: its rows and [oldestAge], the largest age among them, such as "10m".
 * The Waiting on you lane lists the colleague that has waited longest first, because its first
 * row answers inline; the other lanes list the most recently active first.
 */
data class OfficeLane(
    val kind: OfficeLaneKind,
    val rows: List<OfficeRow>,
    val oldestAge: String?,
)

/**
 * One row of the Office: a thread or an assistant. Exactly one of [sessionId] (for a thread)
 * and [assistantId] (for an assistant) tells the screen what the row opens; an assistant's
 * [sessionId] is its current session, or null while it has none.
 *
 * - [title] is the thread's title or the assistant's name.
 * - [age] is the time since the session was last active, as [formatAge] writes it, or null for
 *   an assistant with no session.
 * - [project] is the thread's project, or null for an assistant and for a thread with no project
 *   or one the project list does not hold.
 * - [state] is the question of the oldest open Request for a waiting row, as
 *   [formatRequestQuestion] writes it, and the pose's words for every other row.
 * - [request] is that oldest open Request, which the first waiting row answers inline; null
 *   when nothing waits.
 */
data class OfficeRow(
    val sessionId: String?,
    val assistantId: String?,
    val title: String,
    val pose: Pose,
    val age: String?,
    val project: Project?,
    val state: String,
    val request: SessionRequest?,
) {
    /** The face's seed: the assistant's id for an assistant, the session's id for a thread. */
    val face: OfficeFace
        get() = OfficeFace(seed = assistantId ?: sessionId.orEmpty(), pose = pose, isAssistant = assistantId != null)

    /**
     * The row's second line: `<project> · <state>` for a thread, `Assistant · <state>` for an
     * assistant, and the state alone for a thread with no project.
     */
    val detail: String
        get() = listOfNotNull(if (assistantId != null) "Assistant" else project?.name, state).joinToString(" · ")
}

/**
 * A face to draw: [seed] and [pose]. An assistant's face is drawn with `buildAssistantLook`,
 * which adds headwear, and a thread's with `buildLook`.
 */
data class OfficeFace(val seed: String, val pose: Pose, val isAssistant: Boolean)

/**
 * One runner's field on the plan: the faces of the threads and assistants in the lanes whose
 * session runs there, in lane order, and its capacity line from [describeCapacity].
 */
data class OfficeField(
    val runner: Runner,
    val faces: List<OfficeFace>,
    val capacity: String,
)

/**
 * Builds the Office from what the app has read:
 *
 * - [sessions]: the threads, and any run sessions the caller has. A run session is in no lane
 *   and on no field, because the desktop keeps runs out of Waiting on you (wire doc §C), but it
 *   still counts towards its runner's capacity, since it holds a slot there;
 * - [assistants] and [currentSessions]: each assistant and the current session of its main
 *   conversation, keyed by assistant id. An assistant missing from the map has no session yet;
 * - [runners]: every runner, retired ones included. A retired runner gets no field. A runner
 *   missing from the list counts as connected when a pose is decided;
 * - [projects]: the projects, for each thread's project name;
 * - [now]: the moment every age is measured from.
 *
 * Who goes where:
 *
 * - a thread is in the lane of its pose ([decideThreadPose]): waiting, working or idle. An
 *   asleep or away thread is not shown, as the desktop's Office seats no such thread;
 * - an assistant is in the Waiting or Working lane when its pose is waiting or working, in the
 *   [Office.lobby] when it is asleep, and in the Idle lane otherwise, so an assistant that
 *   can't be reached still has a row (pose from [decideAssistantPose]).
 */
fun buildOffice(
    sessions: List<Session>,
    assistants: List<Assistant>,
    currentSessions: Map<String, Session>,
    runners: List<Runner>,
    projects: List<Project>,
    now: Instant,
): Office {
    val runnersById = runners.associateBy { it.id }
    val projectsById = projects.associateBy { it.id }

    val threads = sessions
        .filter { it.runId == null && it.agentId == null }
        .map { session ->
            val pose = decideThreadPose(session, runnersById[session.runnerId])
            val lane = when (pose) {
                Pose.Waiting -> OfficeLaneKind.Waiting
                Pose.Working -> OfficeLaneKind.Working
                Pose.Idle -> OfficeLaneKind.Idle
                else -> null
            }
            Colleague(
                buildRow(session, pose, now, assistantId = null, title = session.title, project = projectsById[session.projectId]),
                session,
                lane,
            )
        }
    val assistantColleagues = assistants
        .sortedWith(compareBy<Assistant> { it.name }.thenBy { it.id })
        .map { assistant ->
            val session = currentSessions[assistant.id]
            val pose = decideAssistantPose(session, session?.let { runnersById[it.runnerId] })
            val lane = when (pose) {
                Pose.Waiting -> OfficeLaneKind.Waiting
                Pose.Working -> OfficeLaneKind.Working
                Pose.Asleep -> null
                else -> OfficeLaneKind.Idle
            }
            Colleague(buildRow(session, pose, now, assistantId = assistant.id, title = assistant.name, project = null), session, lane)
        }
    val colleagues = threads + assistantColleagues

    val lanes = OfficeLaneKind.entries.mapNotNull { kind ->
        val inLane = colleagues.filter { it.lane == kind }
        if (inLane.isEmpty()) return@mapNotNull null
        // An assistant with no session has no activity time; it goes last in its lane.
        val withSessionFirst = compareBy<Colleague> { it.session == null }
        val ordered = inLane.sortedWith(
            if (kind == OfficeLaneKind.Waiting) {
                withSessionFirst.thenBy { it.session?.lastActivityAt }.thenBy { it.session?.id }
            } else {
                withSessionFirst.thenByDescending { it.session?.lastActivityAt }.thenBy { it.session?.id ?: it.row.assistantId }
            },
        )
        val oldest = inLane.mapNotNull { it.session?.lastActivityAt }.minOrNull()
        OfficeLane(kind, ordered.map { it.row }, oldest?.let { formatAge(it, now) }) to ordered
    }

    val seated = lanes.flatMap { (_, ordered) -> ordered }
    val slotSessions = (sessions + currentSessions.values).distinctBy { it.id }
    val fields = runners
        .filter { it.lifecycle != RunnerLifecycle.Retired }
        .map { runner ->
            OfficeField(
                runner = runner,
                faces = seated.filter { it.session?.runnerId == runner.id }.map { it.row.face },
                capacity = describeCapacity(runner, slotSessions.filter { it.runnerId == runner.id }),
            )
        }

    return Office(
        receipt = lanes.map { (lane, _) -> "${lane.rows.size} ${lane.kind.receiptWords}" },
        fields = fields,
        lobby = assistantColleagues.filter { it.row.pose == Pose.Asleep }.map { it.row },
        lanes = lanes.map { (lane, _) -> lane },
    )
}

/**
 * A thread or an assistant while the Office is built: its row, its session (null for an
 * assistant with none), and the lane it goes in, or null when it is in no lane.
 */
private class Colleague(val row: OfficeRow, val session: Session?, val lane: OfficeLaneKind?)

/** Builds the row of a thread, or of an assistant whose current session is [session]. */
private fun buildRow(
    session: Session?,
    pose: Pose,
    now: Instant,
    assistantId: String?,
    title: String,
    project: Project?,
): OfficeRow {
    val request = session?.openRequests?.firstOrNull()
    return OfficeRow(
        sessionId = session?.id,
        assistantId = assistantId,
        title = title,
        pose = pose,
        age = session?.let { formatAge(it.lastActivityAt, now) },
        project = project,
        state = if (request != null) formatRequestQuestion(request) else pose.words,
        request = request,
    )
}
