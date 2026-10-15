package dayboard.core

import dayboard.core.Samples.LONDON
import dayboard.core.Samples.t
import java.io.File
import java.util.Locale
import javax.imageio.ImageIO
import kotlin.test.Test

/** Draws the widget at common sizes into build/previews, to look at without a phone. */
class PreviewTest {
    private val out = File(System.getProperty("previews.dir") ?: "build/previews").apply { mkdirs() }

    private fun preview(name: String, wDp: Int, hDp: Int, now: String, hour12: Boolean = true, events: List<Event> = Samples.day(), message: String? = null) {
        val d = 3f
        val layout = BoardLayout(wDp * d, hDp * d, d, hour12)
        val model = BoardBuilder(LONDON, hour12, Locale.UK).build(events, Samples.lineOf, t(now), layout.capacity, message)
        val img = AwtPainter.image(layout.w.toInt(), layout.h.toInt()) { p ->
            BoardRenderer().draw(p, model, layout, clock = if (hour12) "9:52" else "09:52")
        }
        ImageIO.write(img, "png", File(out, "$name.png"))
    }

    @Test fun previews() {
        val morning = "2026-10-15T09:52+01:00[Europe/London]"
        preview("4x2", 300, 150, morning)
        preview("4x3", 300, 230, morning)
        preview("4x4", 300, 310, morning)
        preview("5x2", 390, 150, morning)
        preview("3x2", 230, 150, morning)
        preview("4x3-24h", 300, 230, morning, hour12 = false)
        preview("4x2-evening", 300, 150, "2026-10-15T21:40+01:00[Europe/London]")
        preview("4x2-empty", 300, 150, "2026-10-15T23:00+01:00[Europe/London]", events = emptyList())
        preview("4x2-permission", 300, 150, morning, message = "TAP TO ALLOW CALENDAR ACCESS")
    }
}
