package dev.hercule.android.alerts

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import dev.hercule.android.controller.ControllerApi
import dev.hercule.android.controller.ControllerStore
import dev.hercule.android.controller.LiveConnection
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
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
    private val nothingFollowed = FollowedTranscript(null, emptyList())

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

    private fun buildSnapshot(lists: AlertLists = idle) = assertNotNull(buildAlertSnapshot(lists, nothingFollowed, keyOnScreen.value))

    @Test
    fun `builds a snapshot only once every list it holds has been read`() {
        assertNull(buildAlertSnapshot(idle.copy(threads = null), nothingFollowed, null))
        assertNull(buildAlertSnapshot(idle.copy(assistants = null), nothingFollowed, null))
        assertNull(buildAlertSnapshot(idle.copy(currentSessions = emptyMap()), nothingFollowed, null), "a current session not read yet")
        assertNull(buildAlertSnapshot(idle.copy(messages = mapOf(poirot.mainConversationId to null)), nothingFollowed, null))
        assertNull(buildAlertSnapshot(idle.copy(messages = emptyMap()), nothingFollowed, null))
        assertNull(buildAlertSnapshot(idle, FollowedTranscript("s1", null), null), "the followed thread's transcript not read yet")

        assertEquals(listOf(poirot), buildAlertSnapshot(idle, nothingFollowed, null)?.assistants?.map { it.assistant })
        // Lists that are read and empty are complete.
        assertNotNull(buildAlertSnapshot(AlertLists(emptyList(), emptyList(), emptyMap(), emptyMap()), nothingFollowed, null))
        // A followed thread that left the list needs no transcript.
        assertEquals(emptyList(), buildAlertSnapshot(idle, FollowedTranscript("gone", null), null)?.followedTranscript)
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
    fun `with memory stored, a Request that opened meanwhile alerts with sound`() = runTest {
        val memoryStore = openMemoryStore()
        memoryStore.write(AlertMemory(lastMessagePositions = mapOf("a1" to 4L)))
        val pipeline = buildPipeline(memoryStore)
        pipeline.loadMemory()

        pipeline.decide(buildSnapshot())

        val post = decisions.single().changes.single() as AlertChange.Post
        assertEquals(ThreadAlertKey("s1"), post.alert.key)
        assertEquals(true, post.withSound)
    }

    @Test
    fun `a thread on screen gets its Live Update and no alert`() = runTest {
        val memoryStore = openMemoryStore()
        memoryStore.write(AlertMemory(lastMessagePositions = mapOf("a1" to 4L)))
        val pipeline = buildPipeline(memoryStore)
        pipeline.loadMemory()
        keyOnScreen.value = ThreadAlertKey("s1")

        pipeline.decide(buildSnapshot())

        val decision = decisions.single()
        assertEquals(emptyList(), decision.changes)
        assertEquals("s1", decision.liveUpdate?.sessionId)
    }
}
