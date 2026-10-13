package dev.hercule.android.wire

import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Test

/** Decodes runners, including a retired one and an unknown lifecycle, and projects. */
class RunnerProjectWireTest {
    @Test
    fun `decodes an active runner and a retired one`() {
        val page = WireJson.decodeFromString<Page<Runner>>(
            """
            {"items":[
              {"id":"01a1321f-9470-77f6-ba91-0bc1a99f06ca","name":"studio","connectivity":"online","lifecycle":"active","reserved":false,"version":"0.1.0+738cdb2b1","labels":["mac"],"maxConcurrentSessions":4,"lastSeenAt":"2026-10-12T22:00:00.000Z","facts":{"os":"darwin"}},
              {"id":"01a1321f-9470-77f6-ba91-0bc1a99f06cb","name":"old-box","connectivity":"offline","lifecycle":"retired","reserved":false,"version":null,"labels":[],"maxConcurrentSessions":2,"lastSeenAt":null}
            ],"nextCursor":null}
            """,
        )
        val (active, retired) = page.items
        assertEquals(RunnerConnectivity.Online, active.connectivity)
        assertEquals(RunnerLifecycle.Active, active.lifecycle)
        assertEquals(RunnerLifecycle.Retired, retired.lifecycle)
        assertEquals(RunnerConnectivity.Offline, retired.connectivity)
        assertNull(retired.version)
        assertNull(retired.lastSeenAt)
    }

    @Test
    fun `decodes a lifecycle this build does not know`() {
        val runner = WireJson.decodeFromString<Runner>(
            """{"id":"r","name":"n","connectivity":"unreachable","lifecycle":"quarantined","reserved":true,"version":null,"labels":[],"maxConcurrentSessions":1,"lastSeenAt":null}""",
        )
        assertEquals(RunnerLifecycle("quarantined"), runner.lifecycle)
        assertEquals(RunnerConnectivity.Unreachable, runner.connectivity)
    }

    @Test
    fun `decodes a project without a description`() {
        val project = WireJson.decodeFromString<Project>(
            """{"id":"01928f00-0000-7000-8000-0000000000p1","name":"hercule","createdAt":"2026-10-01T10:00:00.000Z","updatedAt":"2026-10-02T10:00:00.000Z"}""",
        )
        assertEquals("hercule", project.name)
        assertNull(project.description)
    }
}
