package dev.hercule.android

import android.app.Application
import android.content.Context
import dev.hercule.android.alerts.AlertPoster
import dev.hercule.android.alerts.createAlertChannels
import dev.hercule.android.alerts.openAlertMemoryStore
import dev.hercule.android.app.AppGraph
import dev.hercule.android.app.openBackgroundPermissions
import dev.hercule.android.credentials.openCredentialStore
import dev.hercule.android.faces.FaceIcons
import okhttp3.OkHttpClient

/**
 * The app's process. It creates the notification channels and the [AppGraph] that every
 * screen, the connection service and the receivers share.
 *
 * Creating the graph opens no file and no network connection, because Android creates this
 * class for every process start, a tapped alert button or a boot broadcast among them.
 */
class MainApplication : Application() {
    /** The app's one graph of long-lived objects. */
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        createAlertChannels(this)
        graph = AppGraph(
            context = this,
            credentialStore = openCredentialStore(this),
            alertMemoryStore = openAlertMemoryStore(this),
            poster = AlertPoster(this, FaceIcons(this)),
            httpClient = OkHttpClient(),
            backgroundPermissions = openBackgroundPermissions(this),
        )
    }
}

/** Returns the app's [AppGraph], from any context of the app's process. */
val Context.appGraph: AppGraph
    get() = (applicationContext as MainApplication).graph
