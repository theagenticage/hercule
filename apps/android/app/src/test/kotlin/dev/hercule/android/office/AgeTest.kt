package dev.hercule.android.office

import kotlin.test.assertEquals
import kotlin.time.Instant
import org.junit.Test

/**
 * Tests [formatAge]. The cases are copied one for one from the `formatAge` cases in
 * packages/client-core/src/threads/age.test.ts; `describeAge` and `findNextAgeChange` are not
 * ported.
 */
class AgeTest {
    private val now = Instant.parse("2026-09-08T12:00:00.000Z")

    private fun formatAgeAt(at: String) = formatAge(Instant.parse(at), now)

    @Test
    fun `shows under a minute as now`() {
        assertEquals("now", formatAgeAt("2026-09-08T11:59:31.000Z"))
        assertEquals("now", formatAge(now, now))
    }

    @Test
    fun `shows minutes under an hour`() {
        assertEquals("5m", formatAgeAt("2026-09-08T11:55:00.000Z"))
        assertEquals("59m", formatAgeAt("2026-09-08T11:01:00.000Z"))
    }

    @Test
    fun `shows hours under a day`() {
        assertEquals("3h", formatAgeAt("2026-09-08T09:00:00.000Z"))
        assertEquals("23h", formatAgeAt("2026-09-07T13:00:00.000Z"))
    }

    @Test
    fun `shows days under a week`() {
        assertEquals("2d", formatAgeAt("2026-09-06T12:00:00.000Z"))
        assertEquals("6d", formatAgeAt("2026-09-02T00:00:00.000Z"))
    }

    @Test
    fun `shows weeks from seven days on`() {
        assertEquals("3w", formatAgeAt("2026-08-18T12:00:00.000Z"))
        assertEquals("1w", formatAgeAt("2026-09-01T12:00:00.000Z"))
    }

    @Test
    fun `never shows seconds`() {
        assertEquals("4m", formatAgeAt("2026-09-08T11:55:59.000Z"))
    }

    @Test
    fun `never shows a negative age for an instant after now`() {
        assertEquals("now", formatAgeAt("2026-09-08T12:05:00.000Z"))
    }
}
