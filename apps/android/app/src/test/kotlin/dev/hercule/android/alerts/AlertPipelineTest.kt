package dev.hercule.android.alerts

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import dev.hercule.android.controller.ControllerApi
import dev.hercule.android.controller.ControllerStore
import dev.hercule.android.controller.LiveConnection
import java.io.File
import java.io.IOException
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Tests how the pipeline decides: which lists it waits for, which list counts as the first,
 * and what it stores. Runs on the plain JVM against a DataStore file in a temporary folder.
 */
class AlertPipelineTest {
    @get:Rule val folder = TemporaryFolder()

    private val waiting = buildSession("s1", openRequests = listOf(buildCommand("r1")))
    private val poirot = buildAssistant("a1")
    private val idle = AlertLists(
        threads = listOf(waiting),
        assistants = listOf(poirot),
        currentSessions = mapOf("a1" to null),
        messages = mapOf(poirot.mainConversationId to listOf(buildMessage(4, "Done."))),
    )
    /** The transcripts once read: the waiting thread's, and no followed thread. */
    private val transcriptsRead = LiveUpdateTranscripts(null, mapOf("s1" to emptyList()))

    private val decisions = mutableListOf<AlertDecision>()
    private val keyOnScreen = MutableStateFlow<AlertKey?>(null)

    private fun TestScope.openMemoryStore() =
        AlertMemoryStore(PreferenceDataStoreFactory.create(scope = backgroundScope) { File(folder.root, "alerts.preferences_pb") })

    /** Builds a pipeline whose store is never started: these tests hand it snapshots directly. */
    private fun TestScope.buildPipeline(memoryStore: AlertMemoryStore): AlertPipeline {
        val api = ControllerApi("http://127.0.0.1:1/".toHttpUrl(), "key-1", OkHttpClient())
        val store = ControllerStore(api, LiveConnection(api, OkHttpClient(), backgroundScope), backgroundScope)
        return AlertPipeline(store, memoryStore, keyOnScreen, MutableStateFlow(null)) { decisions += it }
    }

    private fun buildSnapshot(lists: AlertLists = idle) = assertNotNull(buildAlertSnapshot(lists, transcriptsRead, keyOnScreen.value))

    @Test
    fun `builds a snapshot only once every list it holds has been read`() {
        assertNull(buildAlertSnapshot(idle.copy(threads = null), transcriptsRead, null))
        assertNull(buildAlertSnapshot(idle.copy(assistants = null), transcriptsRead, null))
        assertNull(buildAlertSnapshot(idle.copy(currentSessions = emptyMap()), transcriptsRead, null), "a current session not read yet")
        assertNull(buildAlertSnapshot(idle.copy(messages = mapOf(poirot.mainConversationId to null)), transcriptsRead, null))
        assertNull(buildAlertSnapshot(idle.copy(messages = emptyMap()), transcriptsRead, null))
        assertNull(buildAlertSnapshot(idle, LiveUpdateTranscripts(null, mapOf("s1" to null)), null), "the waiting thread's transcript not read yet")
        assertNull(buildAlertSnapshot(idle, LiveUpdateTranscripts(null, emptyMap()), null), "the waiting thread's transcript not asked for yet")
        val working = idle.copy(threads = listOf(buildSession("s2")))
        assertNull(buildAlertSnapshot(working, LiveUpdateTranscripts("s2", mapOf("s2" to null)), null), "the followed thread's transcript not read yet")

        assertEquals(listOf(poirot), buildAlertSnapshot(idle, transcriptsRead, null)?.assistants?.map { it.assistant })
        // Lists that are read and empty are complete.
        assertNotNull(buildAlertSnapshot(AlertLists(emptyList(), emptyList(), emptyMap(), emptyMap()), transcriptsRead, null))
        // A followed thread that left the list needs no transcript.
        val followedGone = LiveUpdateTranscripts("gone", mapOf("s1" to emptyList(), "gone" to null))
        assertEquals(setOf("s1"), buildAlertSnapshot(idle, followedGone, null)?.liveUpdateTranscripts?.keys)
    }

    @OptIn(ExperimentalCoroutinesApi::class) // for currentTime, the test clock
    @Test
    fun `snapshots that never stop still reach a decision within one interval`() = runTest {
        // A streaming thread changes the lists every 100 ms. A debounce would wait for a pause
        // that never comes; the decision must still arrive once the first interval ends.
        val endless = flow {
            while (true) {
                emit(buildSnapshot())
                delay(100)
            }
        }

        coalesceSnapshots(endless).first()

        assertEquals(DECISION_INTERVAL.inWholeMilliseconds, currentTime)
    }

    @Test
    fun `with no memory stored, the first list only records what is open, and is stored`() = runTest {
        val memoryStore = openMemoryStore()
        val pipeline = buildPipeline(memoryStore)
        pipeline.loadMemory()

        pipeline.decide(buildSnapshot())

        assertEquals(emptyList(), decisions.single().changes)
        assertEquals(listOf("r1"), memoryStore.read()?.openRequestIds?.get(ThreadAlertKey("s1").id))
    }

    @Test
    fun `an empty first list is stored too, so the next start compares against it`() = runTest {
        val memoryStore = openMemoryStore()
        val pipeline = buildPipeline(memoryStore)
        pipeline.loadMemory()

        pipeline.decide(buildSnapshot(AlertLists(emptyList(), emptyList(), emptyMap(), emptyMap())))

        assertEquals(AlertMemory(), memoryStore.read())
    }

    @Test
    fun `a memory that could not be stored is stored at the next decision, and the pipeline goes on`() = runTest {
        val file = PreferenceDataStoreFactory.create(scope = backgroundScope) { File(folder.root, "alerts.preferences_pb") }
        var isDiskFull = true
        val failingOnce = object : DataStore<Preferences> by file {
            override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences {
                if (isDiskFull) throw IOException("No space left on device")
                return file.updateData(transform)
            }
        }
        val memoryStore = AlertMemoryStore(failingOnce)
        val pipeline = buildPipeline(memoryStore)
        pipeline.loadMemory()

        pipeline.decide(buildSnapshot())
        assertNull(memoryStore.read())
        isDiskFull = false
        pipeline.decide(buildSnapshot())

        assertEquals(listOf("r1"), memoryStore.read()?.openRequestIds?.get(ThreadAlertKey("s1").id))
        assertEquals(2, decisions.size)
    }

    @Test
    fun `with memory stored, a Request that opened meanwhile alerts with sound`() = runTest {
        val memoryStore = openMemoryStore()
        memoryStore.write(AlertMemory(lastMessagePositions = mapOf("a1" to 4L)))
        val pipeline = buildPipeline(memoryStore)
        pipeline.loadMemory()

        pipeline.decide(buildSnapshot())

        val update = decisions.single().liveUpdates.single()
        assertEquals("s1", update.sessionId)
        assertEquals(true, update.alert)
    }

    @Test
    fun `a thread on screen gets a Live Update that does not alert`() = runTest {
        val memoryStore = openMemoryStore()
        memoryStore.write(AlertMemory(lastMessagePositions = mapOf("a1" to 4L)))
        val pipeline = buildPipeline(memoryStore)
        pipeline.loadMemory()
        keyOnScreen.value = ThreadAlertKey("s1")

        pipeline.decide(buildSnapshot())

        val decision = decisions.single()
        assertEquals(emptyList(), decision.changes)
        assertEquals(false, decision.liveUpdates.single().alert)
    }
}
