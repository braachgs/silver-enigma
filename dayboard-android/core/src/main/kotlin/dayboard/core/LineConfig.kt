package dayboard.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One of Day Board's lines as the split-flap board draws it: WRK on blue. */
data class LineDef(val id: String, val name: String, val code: String, val color: Int)

/**
 * Where a phone event came from, in the web app's terms: the Google account,
 * the ids its calendar may go by, and its Google event id.
 */
data class EventRef(
    val account: String,
    val calendarIds: Collection<String>,
    /** The event's Google id (for a repeating event, the series id). */
    val syncId: String?,
    /** The instance's original start (UTC millis), to build a repeating event's instance id. */
    val originalStart: Long,
    val allDay: Boolean,
    /** Day Board's own line saved on the event (private extended properties), if the phone synced them. */
    val savedLine: String? = null,
    val savedLineName: String? = null,
)

/**
 * The web app's lines, handed to the widget so both show the same tiles.
 * Sent as plain text, one record per line, fields split by tabs:
 *
 *     DB1
 *     L  id  name  code  RRGGBB      a line, in the web app's order
 *     A  email  lineId               an account's line
 *     C  email  calendarId  lineId   a calendar's line
 *     E  googleEventId  lineId       a line picked or saved for one event
 *     F  2026-10-21  lineId  [until]  [email]
 *                                    events from this day (to `until`, inclusive;
 *                                    blank: no end) default to this line, for
 *                                    one account if `email` is set
 *
 * Lines resolve as the web app's store.resolveLine: the event's own line,
 * then the dated line, then its calendar's, then its account's.
 */
class LineConfig(
    val lines: List<LineDef>,
    private val accounts: Map<String, String>,
    private val calendars: Map<Pair<String, String>, String>,
    private val events: Map<String, String>,
    val from: LocalDate?,
    private val fromLine: String?,
    val until: LocalDate? = null,
    private val fromAccount: String? = null,
) {
    private val byId = lines.associateBy { it.id }
    private val byName = lines.associateBy { it.name.lowercase(Locale.ROOT) }

    fun line(id: String?): LineDef? = id?.let { byId[it] }

    /** The line Day Board would give this event, or null when its account isn't in Day Board. */
    fun resolve(ref: EventRef, start: Long, zone: ZoneId): LineDef? {
        val account = ref.account.lowercase(Locale.ROOT)
        if (account !in accounts && calendars.keys.none { it.first == account }) return null
        instanceIds(ref).firstNotNullOfOrNull { line(events[it]) }?.let { return it }
        (line(ref.savedLine) ?: ref.savedLineName?.let { byName[it.lowercase(Locale.ROOT)] })?.let { return it }
        if (from != null && (fromAccount == null || fromAccount == account)) {
            val day = Instant.ofEpochMilli(start).atZone(zone).toLocalDate()
            if (!day.isBefore(from) && (until == null || !day.isAfter(until))) line(fromLine)?.let { return it }
        }
        ref.calendarIds.firstNotNullOfOrNull { line(calendars[account to it]) }?.let { return it }
        return line(accounts[account]) ?: lines.firstOrNull()
    }

    /** Google's id for this instance: the series id, then "<series>_20261015T093000Z" (timed) or "<series>_20261015" (all day). */
    private fun instanceIds(ref: EventRef): List<String> {
        val id = ref.syncId ?: return emptyList()
        val t = Instant.ofEpochMilli(ref.originalStart).atZone(ZoneOffset.UTC)
        val suffix = if (ref.allDay) DAY.format(t) else STAMP.format(t)
        return listOf(id, "${id}_$suffix")
    }

    fun encode(): String = buildString {
        append(MAGIC)
        for (l in lines) append("\nL\t${l.id}\t${l.name}\t${l.code}\t${String.format(Locale.ROOT, "%06X", l.color and 0xFFFFFF)}")
        for ((a, l) in accounts) append("\nA\t$a\t$l")
        for ((k, l) in calendars) append("\nC\t${k.first}\t${k.second}\t$l")
        for ((e, l) in events) append("\nE\t$e\t$l")
        if (from != null && fromLine != null) append("\nF\t$from\t$fromLine\t${until ?: ""}\t${fromAccount ?: ""}")
    }

    companion object {
        const val MAGIC = "DB1"
        private val STAMP = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss'Z'", Locale.ROOT)
        private val DAY = DateTimeFormatter.ofPattern("yyyyMMdd", Locale.ROOT)

        /** Null for anything that isn't a Day Board line setup (or has no lines). */
        fun parse(text: String?): LineConfig? {
            val rows = text?.split('\n')?.map { it.trimEnd('\r') } ?: return null
            if (rows.firstOrNull() != MAGIC) return null
            val lines = ArrayList<LineDef>()
            val accounts = LinkedHashMap<String, String>()
            val calendars = LinkedHashMap<Pair<String, String>, String>()
            val events = LinkedHashMap<String, String>()
            var from: LocalDate? = null
            var fromLine: String? = null
            var until: LocalDate? = null
            var fromAccount: String? = null
            for (row in rows.drop(1)) {
                val f = row.split('\t')
                when (f[0]) {
                    "L" -> if (f.size >= 5) {
                        val rgb = f[4].toIntOrNull(16) ?: continue
                        val code = Flap.clean(f[3]).replace(" ", "").take(3).ifEmpty { Flap.code(f[2]) }
                        lines += LineDef(f[1], f[2], code, rgb or 0xFF000000.toInt())
                    }
                    "A" -> if (f.size >= 3) accounts[f[1].lowercase(Locale.ROOT)] = f[2]
                    "C" -> if (f.size >= 4) calendars[f[1].lowercase(Locale.ROOT) to f[2]] = f[3]
                    "E" -> if (f.size >= 3) events[f[1]] = f[2]
                    "F" -> if (f.size >= 3) {
                        from = runCatching { LocalDate.parse(f[1]) }.getOrNull()
                        fromLine = f[2]
                        until = f.getOrNull(3)?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
                        fromAccount = f.getOrNull(4)?.lowercase(Locale.ROOT)?.ifBlank { null }
                    }
                }
            }
            if (lines.isEmpty()) return null
            return LineConfig(lines, accounts, calendars, events, from, fromLine, until, fromAccount)
        }
    }
}
