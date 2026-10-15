package dayboard.core

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One calendar event instance. All-day events run from local midnight to local midnight. */
data class Event(
    val id: Long,
    val calendarId: Long,
    val title: String,
    val location: String?,
    val start: Long,
    val end: Long,
    val allDay: Boolean,
    /** ARGB: the event's own colour, else its calendar's. */
    val color: Int,
)

/** How a row's line tile looks: a three-letter code on a coloured flap. */
data class Line(val code: String, val color: Int)

data class Row(val event: Event, val line: Line, val time: String, val remark: Remark, val tomorrow: Boolean)

data class BoardModel(
    val now: Long,
    /** "THU 15 OCT" */
    val dayLabel: String,
    val rows: List<Row>,
    val allDay: List<Event>,
    /** Departures still due today that didn't fit. */
    val moreToday: Int,
    /** Shown instead of rows when there are none (or calendar access is missing). */
    val message: String?,
    /** When the board next changes on its own: a remark boundary or midnight. */
    val nextChange: Long,
)

/**
 * Picks what the widget shows: today's live and upcoming departures, then
 * tomorrow's first ones (marked TOMORROW) if there's room, as a station
 * board keeps showing the next trains after the last one of the day.
 */
class BoardBuilder(
    private val zone: ZoneId,
    private val hour12: Boolean,
    private val locale: Locale = Locale.getDefault(),
) {
    private val dayFormat = DateTimeFormatter.ofPattern("EEE d MMM", locale)

    fun dayStart(now: Long, plusDays: Long = 0): Long =
        Instant.ofEpochMilli(now).atZone(zone).toLocalDate().plusDays(plusDays).atStartOfDay(zone).toInstant().toEpochMilli()

    /** "10:30A" style: five cells plus an A/P cell on a 12-hour clock, "10:30" on a 24-hour one. */
    fun boardTime(t: Long): String {
        val z = Instant.ofEpochMilli(t).atZone(zone)
        if (!hour12) return String.format(Locale.ROOT, "%02d:%02d", z.hour, z.minute)
        val h = if (z.hour % 12 == 0) 12 else z.hour % 12
        return String.format(Locale.ROOT, "%d:%02d", h, z.minute).padStart(5, ' ') + if (z.hour < 12) "A" else "P"
    }

    fun dayLabel(now: Long): String {
        val day = Instant.ofEpochMilli(now).atZone(zone)
        val raw = dayFormat.format(day).replace(".", "")
        val label = Flap.clean(raw).trim()
        // A label with characters the flaps can't show falls back to English.
        val whole = label.replace(" ", "").length == raw.replace(Regex("\\s"), "").length
        return if (whole) label
        else Flap.clean(DateTimeFormatter.ofPattern("EEE d MMM", Locale.UK).format(day))
    }

    fun build(events: List<Event>, lineOf: (Event) -> Line, now: Long, maxRows: Int, message: String? = null): BoardModel {
        val today = dayStart(now)
        val tomorrow = dayStart(now, 1)
        val dayAfter = dayStart(now, 2)
        val order = compareBy<Event>({ it.start }, { it.end }, { it.title })
        val timed = events.filter { !it.allDay }

        // Live (started, not ended) or still to come today.
        val todays = timed.filter { it.start < tomorrow && it.end > now && (it.end > it.start || it.start >= now) }.sortedWith(order)
        val tomorrows = timed.filter { it.start in tomorrow until dayAfter }.sortedWith(order)

        val rows = ArrayList<Row>()
        for (e in todays) {
            if (rows.size >= maxRows) break
            rows += Row(e, lineOf(e), boardTime(e.start), Remarks.of(e.start, e.end, now), tomorrow = false)
        }
        for (e in tomorrows) {
            if (rows.size >= maxRows) break
            // Just before midnight, a departure just after it counts down as usual.
            val r = if (e.start - now <= 15 * MINUTE) Remarks.of(e.start, e.end, now) else Remarks.TOMORROW
            rows += Row(e, lineOf(e), boardTime(e.start), r, tomorrow = true)
        }
        val allDay = events.filter { it.allDay && it.start < tomorrow && it.end > today }.sortedWith(order)

        val soon = tomorrows.filter { it.start - 15 * MINUTE < tomorrow }
        val changes = (todays + soon).mapNotNull { Remarks.nextChange(it.start, it.end, now) } + tomorrow
        val emptyText = when {
            message != null -> message
            rows.isNotEmpty() -> null
            timed.any { it.end in (today + 1)..now } -> "NO MORE DEPARTURES TODAY"
            else -> "NO DEPARTURES TODAY"
        }
        return BoardModel(
            now = now,
            dayLabel = dayLabel(now),
            rows = if (message != null) emptyList() else rows,
            allDay = if (message != null) emptyList() else allDay,
            moreToday = if (message != null) 0 else (todays.size - rows.count { !it.tomorrow }).coerceAtLeast(0),
            message = emptyText,
            nextChange = changes.filter { it > now }.minOrNull() ?: tomorrow,
        )
    }
}
