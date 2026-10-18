package dev.hercule.android.ui.you

import kotlin.test.assertEquals
import org.junit.Test

/** Tests [readHost], which the You screen writes the controller's address with. */
class ReadHostTest {
    @Test
    fun `reads the host of a controller address`() {
        assertEquals("studio-mac.local:7777", readHost("http://studio-mac.local:7777/"))
        assertEquals("example.com", readHost("https://example.com/api"))
        assertEquals("studio-mac.local", readHost("studio-mac.local"))
    }
}
