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
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.transform
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException

/**
 * The failures of the calls a screen makes to the controller, such as an answer the controller
 * refused, as the sentences the screen shows. A screen's view model holds one and runs its calls
 * through [launchCall]; the screen shows each failure with [ShowCallFailures].
 */
class CallFailures {
    // A channel keeps a failure until the screen shows it, such as one that happens while the
    // screen is recreated after a rotation, and shows each failure once.
    private val channel = Channel<String>(Channel.BUFFERED)

    /** The failures, one sentence each, in the order they happened. Each is received once. */
    val failures: Flow<String> = channel.receiveAsFlow()

    /** Reports [failure], a sentence the screen shows, for a failure that is not a call's. */
    fun report(failure: String) {
        channel.trySend(failure)
    }

    /**
     * Runs [call] in [scope] with [client]'s API. When no client is open, the controller
     * refuses the call, or it cannot be reached, the failure is reported in [failures] instead
     * of being thrown, because the user has to know that nothing happened. [onFailure] is then
     * called too, so the screen can offer the call again.
     */
    fun launchCall(
        scope: CoroutineScope,
        client: ControllerClient?,
        onFailure: () -> Unit = {},
        call: suspend (ControllerApi) -> Unit,
    ) {
        if (client == null) {
            report("The app is not connected to the controller yet. Nothing was sent.")
            onFailure()
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
            if (failure != null) {
                report(failure)
                onFailure()
            }
        }
    }
}

/**
 * The Requests a screen has answered, by id, whose answer has not failed. A screen draws such a
 * Request as answered, and [launchAnswer] sends nothing for it, so a double tap sends one answer.
 */
class AnsweredRequests {
    private val mutableIds = MutableStateFlow(emptySet<String>())

    /** The ids of the answered Requests. */
    val ids: StateFlow<Set<String>> = mutableIds.asStateFlow()

    /**
     * Records [requestId] as answered and runs [call] through [calls], or does nothing when the
     * Request is answered already. A failed call removes the record, so the user can answer again.
     */
    fun launchAnswer(
        calls: CallFailures,
        scope: CoroutineScope,
        client: ControllerClient?,
        requestId: String,
        call: suspend (ControllerApi) -> Unit,
    ) {
        if (requestId in mutableIds.value) return
        mutableIds.update { it + requestId }
        calls.launchCall(scope, client, onFailure = { mutableIds.update { it - requestId } }, call)
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

/** How often a screen's state may change: once a frame on the phone's 120 Hz screen. */
const val FRAME_MILLIS = 8L

/**
 * Returns this flow's values at most once every [FRAME_MILLIS]: the first at once, then the newest
 * one after each frame, so no value waits longer than a frame and none in between is drawn.
 * It only skips values a screen would draw over in the same frame; it does nothing while
 * nothing collects.
 */
fun <T> Flow<T>.throttleToFrames(): Flow<T> = conflate().transform { value ->
    emit(value)
    delay(FRAME_MILLIS)
}
