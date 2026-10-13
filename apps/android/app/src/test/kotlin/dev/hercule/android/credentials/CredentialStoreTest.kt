package dev.hercule.android.credentials

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.io.File
import java.util.Base64
import javax.crypto.KeyGenerator
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** Runs on the plain JVM: the store gets an in-memory AES key in place of the Keystore one. */
class CredentialStoreTest {
    @get:Rule val folder = TemporaryFolder()

    private val file: File by lazy { File(folder.root, "credentials.preferences_pb") }
    private val aesKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    private val credentials = StoredCredentials(
        controllerUrl = "http://hercule.tail1234.ts.net:7400",
        userName = "rogier",
        apiKeyId = "0199d3a2-7c4e-7b1a-9f3e-2d5c8a1b4e60",
        apiKey = "q3Zf8xV1bN0cR7tYkL2mP9sD4hJ6wE5aG1uI8oT3nXc",
    )

    private fun TestScope.openDataStore() =
        PreferenceDataStoreFactory.create(scope = backgroundScope) { file }

    @Test
    fun `reads nothing before save`() = runTest {
        assertNull(CredentialStore(openDataStore()) { aesKey }.read())
    }

    @Test
    fun `reads back what was saved`() = runTest {
        val store = CredentialStore(openDataStore()) { aesKey }
        store.save(credentials)
        assertEquals(credentials, store.read())
    }

    @Test
    fun `stores the plain fields as they are, and never the API Key`() = runTest {
        val dataStore = openDataStore()
        CredentialStore(dataStore) { aesKey }.save(credentials)

        val bytes = file.readText(Charsets.ISO_8859_1)
        listOf(credentials.controllerUrl, credentials.userName, credentials.apiKeyId)
            .forEach { assertTrue(it in bytes, "$it is not stored as it is") }
        assertFalse(credentials.apiKey in bytes, "the API Key is stored unencrypted")
    }

    @Test
    fun `reads no credentials after the API Key is removed, but keeps the last sign-in`() = runTest {
        val store = CredentialStore(openDataStore()) { aesKey }
        assertNull(store.readLastSignIn())
        store.save(credentials)
        store.removeApiKey()
        assertNull(store.read())
        assertFalse(store.hasCredentials.first())
        assertEquals(LastSignIn(credentials.controllerUrl, credentials.userName), store.readLastSignIn())
        assertFalse(credentials.apiKeyId in file.readText(Charsets.ISO_8859_1))
    }

    @Test
    fun `fails clearly when the ciphertext is damaged`() = runTest {
        val dataStore = openDataStore()
        val store = CredentialStore(dataStore) { aesKey }
        store.save(credentials)
        dataStore.edit { preferences ->
            val key = stringPreferencesKey("encrypted_api_key")
            val bytes = Base64.getDecoder().decode(checkNotNull(preferences[key]))
            // The last byte belongs to the GCM tag, so flipping one of its bits must fail decryption.
            bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
            preferences[key] = Base64.getEncoder().encodeToString(bytes)
        }

        assertFailsWith<ApiKeyUnreadableException> { store.read() }
    }

    @Test
    fun `fails clearly when the key is another one`() = runTest {
        val dataStore = openDataStore()
        CredentialStore(dataStore) { aesKey }.save(credentials)
        val otherKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

        assertFailsWith<ApiKeyUnreadableException> { CredentialStore(dataStore) { otherKey }.read() }
    }
}
