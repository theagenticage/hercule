package dev.hercule.android.credentials

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

private const val KEYSTORE = "AndroidKeyStore"
private const val API_KEY_ALIAS = "api_key_encryption"

/**
 * Returns the AES-256 key that encrypts the stored API Key, creating it in the Android
 * Keystore the first time. The key material never leaves the Keystore.
 *
 * The key needs neither a user authentication nor an unlocked device. The background
 * connection reads the API Key while the phone is locked, for example to answer a Request
 * from an alert, and a key with either requirement would refuse to decrypt then.
 */
fun loadOrCreateKeystoreKey(): SecretKey {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keyStore.getKey(API_KEY_ALIAS, null) as SecretKey?)?.let { return it }

    val spec = KeyGenParameterSpec.Builder(
        API_KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setUserAuthenticationRequired(false)
        .setUnlockedDeviceRequired(false)
        .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        .apply { init(spec) }
        .generateKey()
}
