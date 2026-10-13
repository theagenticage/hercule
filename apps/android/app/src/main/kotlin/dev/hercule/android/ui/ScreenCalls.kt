package dev.hercule.android.ui

import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import dev.hercule.android.app.ControllerClient
import dev.hercule.android.controller.ControllerApi
import dev.hercule.android.controller.ControllerApiException
import java.io.IOException
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException

/**
 * The failures of the calls a screen makes to the controller, such as an answer the controller
 * refused, as the sentences the screen shows. A screen's view model holds one and runs its calls
 * through [launchCall]; the screen shows each failure with [ShowCallFailures].
 */
class CallFailures {
    private val mutableFailures = MutableSharedFlow<String>(extraBufferCapacity = 8)

    /** The failures, one sentence each, as they happen. */
    val failures: SharedFlow<String> = mutableFailures.asSharedFlow()

    /** Reports [failure], a sentence the screen shows, for a failure that is not a call's. */
    fun report(failure: String) {
        mutableFailures.tryEmit(failure)
    }

    /**
     * Runs [call] in [scope] with [client]'s API. When no client is open, the controller
     * refuses the call, or it cannot be reached, the failure is reported in [failures] instead
     * of being thrown, because the user has to know that nothing happened.
     */
    fun launchCall(scope: CoroutineScope, client: ControllerClient?, call: suspend (ControllerApi) -> Unit) {
        if (client == null) {
            report("The app is not connected to the controller yet. Nothing was sent.")
            return
        }
        scope.launch {
            val failure = try {
                call(client.api)
                null
            } catch (e: ControllerApiException) {
                e.error.message
            } catch (_: IOException) {
                "The controller could not be reached. Nothing was sent."
            } catch (_: SerializationException) {
                "The controller's answer could not be read."
            }
            failure?.let(::report)
        }
    }
}

/** Shows each failure of [failures] in a toast while the screen is on show. */
@Composable
fun ShowCallFailures(failures: CallFailures) {
    val context = LocalContext.current
    LaunchedEffect(failures) {
        failures.failures.collect { Toast.makeText(context, it, Toast.LENGTH_LONG).show() }
    }
}

/**
 * Returns a flow of the current time: now, then again at every whole minute, so that ages such
 * as "10m" stay true while a screen is on show.
 */
fun tickEveryMinute(): Flow<Instant> = flow {
    while (true) {
        val now = Clock.System.now()
        emit(now)
        val untilNextMinute = 1.minutes.inWholeMilliseconds - now.toEpochMilliseconds() % 1.minutes.inWholeMilliseconds
        delay(untilNextMinute)
    }
}

/** How long a screen's state keeps being read after the screen stops showing, such as across a rotation. */
const val STOP_AFTER_MILLIS = 5_000L
