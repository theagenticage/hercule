package dev.hercule.android.alerts

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json

/**
 * Keeps the [AlertMemory] in a Preferences DataStore, as one JSON value, so that it outlives
 * the process. The alert rules' caller reads it before each decision and writes the
 * decision's memory after.
 */
class AlertMemoryStore(private val dataStore: DataStore<Preferences>) {
    /**
     * Returns the stored memory, or null when none is stored: after sign-in, or when the
     * stored value cannot be read, so that the next list is treated as a first list.
     */
    suspend fun read(): AlertMemory? {
        val json = dataStore.data.first()[MEMORY] ?: return null
        return try {
            Json.decodeFromString<AlertMemory>(json)
        } catch (_: IllegalArgumentException) {
            // SerializationException is an IllegalArgumentException. A damaged value only
            // costs the alerts of one list, which is safer than failing every list after it.
            null
        }
    }

    /** Stores [memory], replacing what was stored. */
    suspend fun write(memory: AlertMemory) {
        val json = Json.encodeToString(memory)
        dataStore.edit { it[MEMORY] = json }
    }

    /** Removes the stored memory, at sign-out. */
    suspend fun clear() {
        dataStore.edit { it.clear() }
    }

    private companion object {
        val MEMORY = stringPreferencesKey("memory")
    }
}

// A damaged file is replaced with an empty one: the next list of Requests is then only
// recorded, as after a sign-in, instead of the pipeline failing on every start.
private val Context.alertDataStore by preferencesDataStore(
    name = "alerts",
    corruptionHandler = ReplaceFileCorruptionHandler { emptyPreferences() },
)

/** Returns the app's [AlertMemoryStore], backed by its DataStore file "alerts". */
fun openAlertMemoryStore(context: Context): AlertMemoryStore =
    AlertMemoryStore(context.applicationContext.alertDataStore)
