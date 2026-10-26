package dayboard.match

import dayboard.core.BoardBuilder
import dayboard.core.MINUTE
import dayboard.core.Remark
import dayboard.core.Tone
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.ceil

enum class Section { TODAY, UPCOMING, RECENT }

data class MatchRow(
    val match: Match,
    /** Kickoff " 3:00P" (12-hour, local). The day is in [header]. */
    val time: String,
    /** Blank for a later day's fixture: the day header above says when. */
    val status: Remark,
    val section: Section,
    /** The followed club's next or current match, pinned to the top. */
    val pinned: Boolean,
    /** A plain-text line above this row when a new day starts: "TODAY", "SATURDAY 31 OCT", "YOUR CLUB · TOMORROW". */
    val header: String? = null,
    /** On the pinned row, the followed club, whose name is drawn in amber. */
    val pinnedTeam: Int? = null,
    /** For short boards with no room for day lines: the status flap's day ("TOMORROW", "SAT 31 OCT") ... */
    val shortDay: String = "",
    /** ... and a past result's day in the time flaps ("SAT 24"). */
    val dayTime: String = "",
)

/** What the app knows: the last matches it fetched successfully, and how the latest attempt went. */
data class FeedState(
    val matches: List<Match>,
    /** When [matches] were fetched; null before the first success. */
    val fetchedAt: Long?,
    /** Why the latest attempt failed (null when it succeeded): "OFFLINE", "CHECK API KEY"... */
    val error: String? = null,
    /** Shown instead of matches, e.g. "ADD YOUR API KEY IN MATCH BOARD". */
    val message: String? = null,
)

data class MatchBoardModel(
    val now: Long,
    val dayLabel: String,
    val rows: List<MatchRow>,
    val message: String?,
    /** "AS OF 3:05 PM", plus why the data may be old: "AS OF 3:05 PM · UPDATE FAILED". */
    val footer: String,
    /** Matches that didn't fit. */
    val more: Int,
    /** When a status flap next changes on its own (a countdown step, kickoff, midnight). */
    val nextChange: Long,
)

class MatchBoardBuilder(private val zone: ZoneId, locale: Locale = Locale.getDefault()) {
    private val board = BoardBuilder(zone, hour12 = true, locale = locale)
    private val weekday = DateTimeFormatter.ofPattern("EEE", Locale.UK)
    private val longDay = DateTimeFormatter.ofPattern("EEEE d MMM", Locale.UK)
    private val month = DateTimeFormatter.ofPattern("MMM", Locale.UK)
    private val clock = DateTimeFormatter.ofPattern("h:mm a", Locale.UK)

    private fun day(t: Long): LocalDate = Instant.ofEpochMilli(t).atZone(zone).toLocalDate()

    /**
     * The status flap. Only the feed says a match is live, at half time or
     * over; before kickoff the app counts down from the fixture time. A
     * kickoff the feed hasn't confirmed yet reads KICK OFF, never LIVE.
     */
    fun status(m: Match, now: Long): Remark {
        val today = day(now)
        val d = day(m.kickoff)
        return when (m.status) {
            MatchStatus.IN_PLAY -> Remark("LIVE", Tone.LIVE)
            MatchStatus.PAUSED -> Remark("HALF TIME", Tone.BOARDING)
            MatchStatus.FINISHED, MatchStatus.AWARDED -> Remark("FULL TIME", Tone.INFO)
            MatchStatus.POSTPONED -> Remark("POSTPONED", Tone.FINAL)
            MatchStatus.SUSPENDED -> Remark("SUSPENDED", Tone.FINAL)
            MatchStatus.CANCELLED -> Remark("CANCELLED", Tone.FINAL)
            else -> when {
                // A later day's fixture: nothing to report yet (the day header says when).
                d.isAfter(today) -> Remark("", Tone.INFO)
                m.kickoff > now -> {
                    val mins = ceil((m.kickoff - now) / MINUTE.toDouble()).toInt()
                    if (mins > 60) Remark("ON TIME", Tone.ON_TIME)
                    else Remark("IN ${roundUp5(mins)} MIN", if (mins <= 5) Tone.FINAL else Tone.BOARDING)
                }
                d == today -> Remark("KICK OFF", Tone.INFO) // past kickoff; the feed hasn't said it's live yet
                else -> Remark("NO RESULT", Tone.PAST)
            }
        }
    }

    private fun roundUp5(m: Int) = ((m + 4) / 5) * 5

    /** The followed club's match in play, else its next one. */
    fun pinned(matches: List<Match>, followed: Int?, now: Long): Match? {
        if (followed == null) return null
        val mine = matches.filter { it.involves(followed) }
        // "Live" only counts within a match's length of kickoff: an old match left
        // IN_PLAY by stale data isn't your club's current match.
        return mine.filter { it.status.live && it.kickoff > now - 4 * 60 * MINUTE }.minByOrNull { it.kickoff }
            ?: mine.filter { it.status.upcoming && (it.kickoff > now || day(it.kickoff) == day(now)) }.minByOrNull { it.kickoff }
    }

    /**
     * Your club's match on top, then today's matches, upcoming fixtures and
     * recent results (newest first). On a day without matches the results
     * come before the fixtures: on a Monday, the weekend's scores lead. Each
     * new day starts with a header line.
     */
    fun order(matches: List<Match>, followed: Int?, now: Long): List<MatchRow> {
        val today = day(now)
        val pin = pinned(matches, followed, now)
        fun section(m: Match) = day(m.kickoff).let { if (it == today) Section.TODAY else if (it.isAfter(today)) Section.UPCOMING else Section.RECENT }
        fun row(m: Match): MatchRow {
            val z = Instant.ofEpochMilli(m.kickoff).atZone(zone)
            val d = z.toLocalDate()
            val short = if (d == today.plusDays(1)) "TOMORROW" else (weekday.format(z) + " " + z.dayOfMonth + " " + month.format(z)).uppercase()
            return MatchRow(m, board.boardTime(m.kickoff), status(m, now), section(m), m.id == pin?.id,
                pinnedTeam = if (m.id == pin?.id) followed else null,
                shortDay = if (d.isAfter(today)) short else "",
                dayTime = (weekday.format(z).uppercase() + " " + z.dayOfMonth).padEnd(6))
        }
        val rest = matches.filter { it.id != pin?.id }
        val todays = rest.filter { day(it.kickoff) == today }.sortedWith(compareBy({ it.kickoff }, { it.id }))
        val upcoming = rest.filter { day(it.kickoff).isAfter(today) }.sortedWith(compareBy({ it.kickoff }, { it.id }))
        val recent = rest.filter { day(it.kickoff).isBefore(today) }.sortedWith(compareBy({ -it.kickoff }, { it.id }))
        val anyToday = matches.any { day(it.kickoff) == today }
        val body = if (anyToday) todays + upcoming + recent else recent + upcoming
        val out = ArrayList<MatchRow>()
        pin?.let { out += row(it).copy(header = "YOUR CLUB · " + dayWord(day(it.kickoff), today)) }
        var last: LocalDate? = null
        for (m in body) {
            val d = day(m.kickoff)
            out += row(m).copy(header = if (d != last) dayWord(d, today) else null)
            last = d
        }
        return out
    }

    /** "TODAY", "TOMORROW", "YESTERDAY", else "SATURDAY 31 OCT". */
    private fun dayWord(d: LocalDate, today: LocalDate): String = when (d) {
        today -> "TODAY"
        today.plusDays(1) -> "TOMORROW"
        today.minusDays(1) -> "YESTERDAY"
        else -> longDay.format(d).uppercase()
    }

    fun build(state: FeedState, followed: Int?, now: Long, maxRows: Int): MatchBoardModel {
        val rows = if (state.message != null) emptyList() else order(state.matches, followed, now)
        val shown = rows.take(maxRows.coerceAtLeast(1))
        val message = state.message ?: when {
            state.fetchedAt == null && state.error != null -> state.error
            state.fetchedAt == null -> "WAITING FOR THE FIRST UPDATE"
            rows.isEmpty() -> "NO PREMIER LEAGUE MATCHES THIS WEEK"
            else -> null
        }
        // Data from an earlier day says which day: "AS OF SAT 2:39 PM".
        val asOf = state.fetchedAt?.let {
            val z = Instant.ofEpochMilli(it).atZone(zone)
            val dayPart = if (z.toLocalDate() == day(now)) "" else weekday.format(z).uppercase() + " "
            "AS OF " + dayPart + clock.format(z).uppercase()
        }
        val footer = listOfNotNull(asOf, state.error?.takeIf { state.fetchedAt != null }).joinToString(" · ")
        return MatchBoardModel(
            now = now,
            dayLabel = board.dayLabel(now),
            rows = if (message != null) emptyList() else shown,
            message = message,
            footer = footer,
            more = if (message != null) 0 else rows.size - shown.size,
            nextChange = nextChange(state.matches, now),
        )
    }

    /** The next moment a status flap changes without new data: a countdown step, a kickoff, or midnight. */
    fun nextChange(matches: List<Match>, now: Long): Long {
        val midnight = board.dayStart(now, 1)
        var next = midnight
        for (m in matches) {
            if (!m.status.upcoming || m.kickoff <= now || m.kickoff >= midnight) continue
            val rem = m.kickoff - now
            val t = if (rem > 60 * MINUTE) {
                m.kickoff - 60 * MINUTE
            } else {
                // The flap shows the minutes left rounded up to 5: it changes as they drop past a multiple of 5.
                val shown = roundUp5(ceil(rem / MINUTE.toDouble()).toInt())
                m.kickoff - (shown - 5) * MINUTE
            }
            if (t in (now + 1) until next) next = t
        }
        return next
    }
}
