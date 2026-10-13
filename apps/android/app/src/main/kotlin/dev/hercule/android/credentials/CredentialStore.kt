package dev.hercule.android.credentials

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.security.GeneralSecurityException
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * What the app keeps after sign in: where the controller is, who signed in, and the API Key
 * the app calls the controller with. The API Key's id is kept so that sign out can revoke it.
 */
data class StoredCredentials(
    val controllerUrl: String,
    val userName: String,
    val apiKeyId: String,
    val apiKey: String,
)

/** Thrown when the stored API Key cannot be decrypted, so the user has to sign in again. */
class ApiKeyUnreadableException(message: String, cause: Throwable) : IllegalStateException(message, cause)

/**
 * Keeps the [StoredCredentials] in a Preferences DataStore. The controller URL, the user name
 * and the API Key's id are stored as they are. The API Key is encrypted with AES-GCM under
 * [encryptionKey] and stored as base64 of the 12-byte IV followed by the ciphertext.
 *
 * On the phone [encryptionKey] is [loadOrCreateKeystoreKey]. Tests pass an in-memory AES key,
 * because Robolectric and the plain JVM have no Android Keystore.
 */
class CredentialStore(
    private val dataStore: DataStore<Preferences>,
    encryptionKey: () -> SecretKey,
) {
    private val key by lazy(encryptionKey)

    /**
     * Emits the stored credentials, or null when nobody is signed in, and again after every
     * change. Fails with [ApiKeyUnreadableException] when the API Key cannot be decrypted.
     */
    val credentials: Flow<StoredCredentials?> = dataStore.data.map(::decodeCredentials)

    /** Returns the stored credentials once, or null when nobody is signed in. Fails as [credentials] does. */
    suspend fun read(): StoredCredentials? = credentials.first()

    /** Stores [credentials] in one write, replacing whatever was stored before. */
    suspend fun save(credentials: StoredCredentials) {
        val encryptedApiKey = encryptApiKey(credentials.apiKey)
        dataStore.edit { preferences ->
            preferences[CONTROLLER_URL] = credentials.controllerUrl
            preferences[USER_NAME] = credentials.userName
            preferences[API_KEY_ID] = credentials.apiKeyId
            preferences[ENCRYPTED_API_KEY] = encryptedApiKey
        }
    }

    /** Removes everything stored, so the app is signed out. */
    suspend fun clear() {
        dataStore.edit { it.clear() }
    }

    private fun decodeCredentials(preferences: Preferences): StoredCredentials? {
        // save() writes all four values in one edit, so the encrypted key is present exactly
        // when the other three are.
        val encryptedApiKey = preferences[ENCRYPTED_API_KEY] ?: return null
        return StoredCredentials(
            controllerUrl = checkNotNull(preferences[CONTROLLER_URL]),
            userName = checkNotNull(preferences[USER_NAME]),
            apiKeyId = checkNotNull(preferences[API_KEY_ID]),
            apiKey = decryptApiKey(encryptedApiKey),
        )
    }

    private fun encryptApiKey(apiKey: String): String {
        // Without an IV of our own, the cipher picks a random one. The Android Keystore
        // insists on that for GCM keys, so an IV is never reused under the same key.
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        return Base64.getEncoder().encodeToString(cipher.iv + cipher.doFinal(apiKey.toByteArray()))
    }

    private fun decryptApiKey(encryptedApiKey: String): String {
        try {
            val bytes = Base64.getDecoder().decode(encryptedApiKey)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                key,
                GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES),
            )
            return String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES))
        } catch (error: GeneralSecurityException) {
            throw unreadable(error)
        } catch (error: IllegalArgumentException) {
            // Base64 decoding fails, and so does GCMParameterSpec on a value shorter than its IV.
            throw unreadable(error)
        }
    }

    private fun unreadable(cause: Throwable) = ApiKeyUnreadableException(
        "The stored API Key cannot be decrypted: either the stored value is damaged or its " +
            "Keystore key is gone. Sign out and sign in again to store a new API Key.",
        cause,
    )

    private companion object {
        val CONTROLLER_URL = stringPreferencesKey("controller_url")
        val USER_NAME = stringPreferencesKey("user_name")
        val API_KEY_ID = stringPreferencesKey("api_key_id")
        val ENCRYPTED_API_KEY = stringPreferencesKey("encrypted_api_key")

        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}

private val Context.credentialDataStore by preferencesDataStore(name = "credentials")

/** Returns the app's [CredentialStore], backed by its DataStore file and its Keystore key. */
fun openCredentialStore(context: Context): CredentialStore =
    CredentialStore(context.applicationContext.credentialDataStore, ::loadOrCreateKeystoreKey)
