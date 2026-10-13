package dev.hercule.android.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import dev.hercule.android.appGraph
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Starts the connection service again after the phone restarts or the app is updated, when
 * the phone is signed in. Both broadcasts let an app start a foreground service from the
 * background, and Android 15's ban on starting some service types at boot does not cover the
 * `specialUse` type the connection service has.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (!isRestartAction(action)) return
        val graph = context.appGraph
        val pending = goAsync()
        receiverScope.launch {
            try {
                if (shouldStartConnection(action, graph.isSignedIn())) graph.startConnectionService()
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        // A failure here would otherwise crash the app at every boot. It is logged, and the
        // connection then starts the next time the user opens the app.
        val receiverScope = CoroutineScope(
            SupervisorJob() + Dispatchers.IO + CoroutineExceptionHandler { _, error ->
                Log.e("BootReceiver", "The connection could not be started after a restart", error)
            },
        )
    }
}

/** Checks whether [action] is a broadcast after which the connection should come back. */
private fun isRestartAction(action: String?): Boolean =
    action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_MY_PACKAGE_REPLACED

/** Checks whether the broadcast [action] should start the connection service: it is a restart, and the phone is signed in. */
internal fun shouldStartConnection(action: String?, isSignedIn: Boolean): Boolean = isSignedIn && isRestartAction(action)
