package dev.hercule.android.credentials

import android.content.Context
import android.security.keystore.KeyPermanentlyInvalidatedException
import androidx.datastore.core.DataStore
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

/**
 * What the app keeps after sign in: where the controller is, who signed in, and the API Key
 * the app calls the controller with. The API Key's id is kept so that sign out can revoke it.
 */
data class StoredCredentials(
    val controllerUrl: String,
    val userName: String,
    val apiKeyId: String,
    val apiKey: String,
) {
    /** Returns the credentials with the API Key hidden, so a log line or a crash report never holds the key. */
    override fun toString() =
        "StoredCredentials(controllerUrl=$controllerUrl, userName=$userName, apiKeyId=$apiKeyId, apiKey=<hidden>)"
}

/** Where the last sign-in went and who signed in, kept after sign-out to fill the sign-in form. */
data class LastSignIn(val controllerUrl: String, val userName: String)

/** Thrown when the stored API Key cannot be decrypted, so the user has to sign in again. */
class ApiKeyUnreadableException(message: String, cause: Throwable) : IllegalStateException(message, cause)

/**
 * Keeps the [StoredCredentials] in a Preferences DataStore. The controller URL, the user name
 * and the API Key's id are stored as they are. The API Key is encrypted with AES-GCM under
 * [encryptionKey] and stored as base64 of the 12-byte IV followed by the ciphertext.
 *
 * On the phone [encryptionKey] is [loadOrCreateKeystoreKey]. Tests pass an in-memory AES key,
 * because Robolectric and the plain JVM have no Android Keystore.
 *
 * Loading the key, encrypting and decrypting run on [Dispatchers.IO], whichever thread the
 * caller is on. The Keystore can block for a while, and callers such as the controller watch
 * service and the app's first screen run on the main thread.
 */
class CredentialStore(
    private val dataStore: DataStore<Preferences>,
    encryptionKey: () -> SecretKey,
) {
    private val key by lazy(encryptionKey)

    /**
     * Emits the stored credentials, or null when nobody is signed in, and again after every
     * change. Fails with [ApiKeyUnreadableException] when the API Key can never be decrypted
     * again. Any other failure, such as a Keystore that is briefly unavailable after boot, is
     * thrown as it is, because the stored key may still be readable on the next try.
     */
    val credentials: Flow<StoredCredentials?> = dataStore.data.map(::decodeCredentials).flowOn(Dispatchers.IO)

    /**
     * Emits whether credentials are stored, and again each time that changes. Unlike
     * [credentials] it decrypts nothing, so it never fails on the API Key.
     */
    val hasCredentials: Flow<Boolean> = dataStore.data.map { ENCRYPTED_API_KEY in it }.distinctUntilChanged()

    /** Returns the stored credentials once, or null when nobody is signed in. Fails as [credentials] does. */
    suspend fun read(): StoredCredentials? = credentials.first()

    /** Stores [credentials] in one write, replacing whatever was stored before. */
    suspend fun save(credentials: StoredCredentials) {
        val encryptedApiKey = withContext(Dispatchers.IO) { encryptApiKey(credentials.apiKey) }
        dataStore.edit { preferences ->
            preferences[CONTROLLER_URL] = credentials.controllerUrl
            preferences[USER_NAME] = credentials.userName
            preferences[API_KEY_ID] = credentials.apiKeyId
            preferences[ENCRYPTED_API_KEY] = encryptedApiKey
        }
    }

    /**
     * Returns the controller URL and user name of the last sign-in, or null when the phone was
     * never signed in. They stay after [removeApiKey], so the sign-in form can start with them.
     */
    suspend fun readLastSignIn(): LastSignIn? {
        val preferences = dataStore.data.first()
        val controllerUrl = preferences[CONTROLLER_URL] ?: return null
        return LastSignIn(controllerUrl, preferences[USER_NAME].orEmpty())
    }

    /**
     * Removes the API Key and its id, so the app is signed out. The controller URL and the user
     * name stay: they are no secret, and the next sign-in starts with them.
     */
    suspend fun removeApiKey() {
        dataStore.edit { preferences ->
            preferences.remove(API_KEY_ID)
            preferences.remove(ENCRYPTED_API_KEY)
        }
    }

    private fun decodeCredentials(preferences: Preferences): StoredCredentials? {
        // save() writes all four values in one edit and removeApiKey() removes the key with its
        // id, so the other three are present whenever the encrypted key is.
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
        // Loaded outside the try: a Keystore that fails to load the key says nothing about
        // whether the stored value can be decrypted.
        val secretKey = key
        try {
            val bytes = Base64.getDecoder().decode(encryptedApiKey)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                secretKey,
                GCMParameterSpec(TAG_BITS, bytes, 0, IV_BYTES),
            )
            return String(cipher.doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES))
        } catch (error: AEADBadTagException) {
            // The value is damaged, or was encrypted under a Keystore key that is gone.
            throw buildApiKeyUnreadableException(error)
        } catch (error: KeyPermanentlyInvalidatedException) {
            throw buildApiKeyUnreadableException(error)
        } catch (error: IllegalArgumentException) {
            // Base64 decoding fails, and so does GCMParameterSpec on a value shorter than its IV.
            throw buildApiKeyUnreadableException(error)
        }
    }

    private fun buildApiKeyUnreadableException(cause: Throwable) = ApiKeyUnreadableException(
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

// A damaged file is replaced with an empty one, so the app reads as signed out and the user
// signs in again, instead of crashing at every start.
private val Context.credentialDataStore by preferencesDataStore(
    name = "credentials",
    corruptionHandler = ReplaceFileCorruptionHandler { emptyPreferences() },
)

/** Returns the app's [CredentialStore], backed by its DataStore file and its Keystore key. */
fun openCredentialStore(context: Context): CredentialStore =
    CredentialStore(context.applicationContext.credentialDataStore, ::loadOrCreateKeystoreKey)
