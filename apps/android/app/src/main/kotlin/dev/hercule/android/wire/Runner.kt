package dev.hercule.android.wire

import kotlin.time.Instant
import kotlinx.serialization.Serializable

/**
 * A runner, as `runner.query` lists it, cut to what the app reads. The list includes retired
 * runners, so a screen of the working fleet filters out [RunnerLifecycle.Retired] itself.
 */
@Serializable
data class Runner(
    val id: String,
    val name: String,
    val connectivity: RunnerConnectivity,
    val lifecycle: RunnerLifecycle,
    /** True when the runner only takes work that asks for it by id. */
    val reserved: Boolean,
    /** The runner's build, null until it has reported one. */
    val version: String?,
    val labels: List<String>,
    val maxConcurrentSessions: Int,
    val lastSeenAt: Instant?,
)

/** Whether the controller can reach a runner's machine. */
@Serializable
@JvmInline
value class RunnerConnectivity(val wire: String) {
    companion object {
        val Online = RunnerConnectivity("online")
        val Offline = RunnerConnectivity("offline")
        val Unreachable = RunnerConnectivity("unreachable")
    }
}

/** A runner's lifecycle, which only the user changes. A retired runner never runs work again. */
@Serializable
@JvmInline
value class RunnerLifecycle(val wire: String) {
    companion object {
        val Active = RunnerLifecycle("active")
        val Draining = RunnerLifecycle("draining")
        val Retired = RunnerLifecycle("retired")
    }
}
