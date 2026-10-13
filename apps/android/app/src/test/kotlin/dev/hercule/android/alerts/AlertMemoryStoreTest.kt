package dev.hercule.android.alerts

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Runs on the plain JVM against a DataStore file in a temporary folder. */
class AlertMemoryStoreTest {
    @get:Rule val folder = TemporaryFolder()

    private val file: File by lazy { File(folder.root, "alerts.preferences_pb") }

    private val memory = AlertMemory(
        openRequestIds = mapOf("thread:s1" to listOf("r1", "r2")),
        shownAlerts = mapOf("thread:s1" to ShownAlert("r2"), "assistant:a1" to ShownAlert(null)),
        lastMessagePositions = mapOf("a1" to 41L),
        followedSessionId = "s2",
    )

    private fun TestScope.openDataStore() = PreferenceDataStoreFactory.create(scope = backgroundScope) { file }

    @Test
    fun `reads nothing before anything is written`() = runTest {
        assertNull(AlertMemoryStore(openDataStore()).read())
    }

    @Test
    fun `reads back what was written`() = runTest {
        val store = AlertMemoryStore(openDataStore())
        store.write(memory)
        assertEquals(memory, store.read())
    }

    @Test
    fun `reads nothing after clear`() = runTest {
        val store = AlertMemoryStore(openDataStore())
        store.write(memory)
        store.clear()
        assertNull(store.read())
    }

    @Test
    fun `reads nothing when the stored value is damaged`() = runTest {
        val dataStore = openDataStore()
        dataStore.edit { it[stringPreferencesKey("memory")] = "{not json" }
        assertNull(AlertMemoryStore(dataStore).read())
    }
}
