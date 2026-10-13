package dev.hercule.android.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.datastore.core.DataStore
import androidx.datastore.core.handlers.ReplaceFileCorruptionHandler
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

/**
 * Answers what the app still has to ask the user for so that alerts arrive while it is in the
 * background: the permission to post notifications, and leave to skip battery optimisation,
 * which keeps the live connection open while the phone sleeps. It shows nothing itself; a
 * screen asks with what it returns.
 *
 * The battery question is asked once. [dataStore] remembers that it was asked, because a user
 * who said no should not be asked at every sign-in.
 */
class BackgroundPermissions(private val context: Context, private val dataStore: DataStore<Preferences>) {
    /** Checks whether the app still needs the user's permission to post notifications. */
    fun needsNotificationPermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    /** Checks whether the app should ask to skip battery optimisation: it is not exempt yet, and has never asked. */
    suspend fun shouldAskBatteryExemption(): Boolean {
        val powerManager = context.getSystemService(PowerManager::class.java)
        if (powerManager.isIgnoringBatteryOptimizations(context.packageName)) return false
        return dataStore.data.first()[BATTERY_EXEMPTION_ASKED] != true
    }

    /**
     * Returns the intent that opens the system dialog asking to let the app skip battery
     * optimisation. Start it with `startActivity`, then call [recordBatteryExemptionAsked].
     */
    // Lint's BatteryLife check warns that Google Play allows this request only for a few kinds
    // of app. The app is installed by hand, not from Play, and alerts that arrive late defeat
    // its purpose, so it asks.
    @SuppressLint("BatteryLife")
    fun buildBatteryExemptionIntent(): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, "package:${context.packageName}".toUri())

    /** Records that the battery question was asked, so [shouldAskBatteryExemption] returns false from now on. */
    suspend fun recordBatteryExemptionAsked() {
        dataStore.edit { it[BATTERY_EXEMPTION_ASKED] = true }
    }

    private companion object {
        val BATTERY_EXEMPTION_ASKED = booleanPreferencesKey("battery_exemption_asked")
    }
}

// A damaged file is replaced with an empty one, so the battery question may be asked once
// more instead of the app crashing at every start.
private val Context.backgroundPermissionsDataStore by preferencesDataStore(
    name = "background_permissions",
    corruptionHandler = ReplaceFileCorruptionHandler { emptyPreferences() },
)

/** Returns the app's [BackgroundPermissions], backed by its DataStore file "background_permissions". */
fun openBackgroundPermissions(context: Context): BackgroundPermissions =
    BackgroundPermissions(context.applicationContext, context.applicationContext.backgroundPermissionsDataStore)
