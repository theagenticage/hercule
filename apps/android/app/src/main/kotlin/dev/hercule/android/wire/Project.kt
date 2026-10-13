package dev.hercule.android.wire

import kotlin.time.Instant
import kotlinx.serialization.Serializable

/**
 * A project, as `project.query` lists it: a name that groups Threads and tasks. A deleted
 * project is never returned.
 */
@Serializable
data class Project(
    val id: String,
    val name: String,
    /** Markdown. Absent when the project has none. */
    val description: String? = null,
    val createdAt: Instant,
    val updatedAt: Instant,
)
