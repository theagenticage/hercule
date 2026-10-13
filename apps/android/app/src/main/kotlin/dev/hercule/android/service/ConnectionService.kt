package dev.hercule.android.service

import android.Manifest
import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import dev.hercule.android.R
import dev.hercule.android.alerts.AlertChannels
import dev.hercule.android.app.AppGraph
import dev.hercule.android.app.ControllerClient
import dev.hercule.android.appGraph
import dev.hercule.android.controller.LiveConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrl

/**
 * Keeps the app connected to the controller while it is signed in, so that alerts arrive
 * when no screen is open. It is a foreground service with an ongoing, silent notification
 * that says where the connection stands.
 *
 * The service opens the graph's [ControllerClient], which holds the one live connection and
 * runs the alert pipeline; the connection itself reconnects and pings. When the controller
 * refuses the API Key, the service ends the sign-in and the user is told.
 */
class ConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watch: Job? = null
    private var client: ControllerClient? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Android stops an app that does not call startForeground within a few seconds of
        // startForegroundService, so it is called before anything else.
        try {
            ServiceCompat.startForeground(
                this,
                CONNECTION_NOTIFICATION_ID,
                buildNotification(getString(R.string.connection_connecting)),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } catch (_: ForegroundServiceStartNotAllowedException) {
            appGraph.postAppAlert(R.string.connection_not_started)
            stopSelf()
            return START_NOT_STICKY
        }
        // A second start, such as a sign-in while the service runs, keeps the running watch.
        if (watch?.isActive != true) watch = scope.launch { watchConnection(appGraph) }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        // The connection lives exactly as long as the service. Only this service's own client
        // is closed: a sign-in that followed a sign-out may already have opened the next one.
        client?.let(appGraph::closeClientLater)
        super.onDestroy()
    }

    /** Opens the client and keeps the notification in line with the connection's state. */
    private suspend fun watchConnection(graph: AppGraph) {
        val client = graph.openClient()
        if (client == null) {
            stopSelf()
            return
        }
        this.client = client
        val host = client.credentials.controllerUrl.toHttpUrl().host
        client.live.state.collect { state ->
            val text = when (state) {
                is LiveConnectionState.Connected -> getString(R.string.connection_connected, state.host)
                LiveConnectionState.Reconnecting -> getString(R.string.connection_reconnecting)
                LiveConnectionState.Connecting, LiveConnectionState.Stopped -> getString(R.string.connection_connecting_to, host)
                LiveConnectionState.SignedOut -> {
                    graph.endRefusedSignIn()
                    return@collect
                }
            }
            // Without the permission the notification is hidden, but the service still runs.
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                NotificationManagerCompat.from(this).notify(CONNECTION_NOTIFICATION_ID, buildNotification(text))
            }
        }
    }

    private fun buildNotification(text: String): Notification {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        return NotificationCompat.Builder(this, AlertChannels.CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_mark)
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(launch?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE) })
            .build()
    }

    private companion object {
        // Alerts are tagged with their key; this one is untagged, so its id cannot collide.
        const val CONNECTION_NOTIFICATION_ID = 11
    }
}
