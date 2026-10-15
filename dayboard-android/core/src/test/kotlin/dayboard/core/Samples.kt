package dayboard.core

import java.time.ZoneId
import java.time.ZonedDateTime

/** A London day like the owner's: Work and Personal calendars, a New York family one, a UTC fixtures one. */
object Samples {
    val LONDON: ZoneId = ZoneId.of("Europe/London")
    fun t(s: String): Long = ZonedDateTime.parse(s).toInstant().toEpochMilli()

    const val WORK = 1L
    const val PERSONAL = 2L
    const val FAMILY = 3L
    const val FOOTBALL = 4L
    val names = mapOf(WORK to "Work", PERSONAL to "Personal", FAMILY to "Gagne Family", FOOTBALL to "Brentford FC")
    val colors = mapOf(WORK to 0xFF039BE5.toInt(), PERSONAL to 0xFF33B679.toInt(), FAMILY to 0xFFF6BF26.toInt(), FOOTBALL to 0xFFD50000.toInt())
    val lineOf: (Event) -> Line = { e -> Line(Flap.code(names[e.calendarId]), e.color) }

    private var n = 0L
    fun ev(cal: Long, title: String, start: String, end: String, allDay: Boolean = false) =
        Event(++n, cal, title, null, t(start), t(end), allDay, colors.getValue(cal))

    fun day(): List<Event> = listOf(
        ev(WORK, "Morning standup", "2026-10-15T09:30+01:00[Europe/London]", "2026-10-15T10:00+01:00[Europe/London]"),
        ev(WORK, "Design review with Priya", "2026-10-15T10:05+01:00[Europe/London]", "2026-10-15T10:45+01:00[Europe/London]"),
        ev(PERSONAL, "Dentist", "2026-10-15T11:30+01:00[Europe/London]", "2026-10-15T12:15+01:00[Europe/London]"),
        ev(FAMILY, "Call Mom", "2026-10-15T13:00-04:00[America/New_York]", "2026-10-15T13:30-04:00[America/New_York]"),
        ev(FOOTBALL, "Brentford v Leeds United", "2026-10-15T19:30Z[UTC]", "2026-10-15T21:30Z[UTC]"),
        ev(PERSONAL, "School run", "2026-10-16T08:30+01:00[Europe/London]", "2026-10-16T09:00+01:00[Europe/London]"),
        ev(WORK, "Quarterly planning", "2026-10-16T10:00+01:00[Europe/London]", "2026-10-16T11:00+01:00[Europe/London]"),
        ev(FAMILY, "Half term", "2026-10-15T00:00+01:00[Europe/London]", "2026-10-17T00:00+01:00[Europe/London]", allDay = true),
    )
}
