package dayboard.match

import dayboard.core.BoardBuilder
import dayboard.core.Flap
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
    /** Kickoff " 3:00P" (12-hour, local); a past day's result shows its day, "SAT 25". */
    val time: String,
    val status: Remark,
    val section: Section,
    /** The followed club's next or current match, pinned to the top. */
    val pinned: Boolean,
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
    private val dayFormat = DateTimeFormatter.ofPattern("EEE d MMM", Locale.UK)
    private val weekday = DateTimeFormatter.ofPattern("EEE", Locale.UK)
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
                d.isAfter(today.plusDays(1)) -> Remark(Flap.clean(dayFormat.format(Instant.ofEpochMilli(m.kickoff).atZone(zone))).trim(), Tone.INFO)
                d.isAfter(today) -> Remark("TOMORROW", Tone.INFO)
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
        return mine.filter { it.status.live }.minByOrNull { it.kickoff }
            ?: mine.filter { it.status.upcoming && (it.kickoff > now || day(it.kickoff) == day(now)) }.minByOrNull { it.kickoff }
    }

    /** Today's matches, then upcoming, then recent results (newest first); the pinned match on top. */
    fun order(matches: List<Match>, followed: Int?, now: Long): List<MatchRow> {
        val today = day(now)
        val pin = pinned(matches, followed, now)
        fun row(m: Match, s: Section) = MatchRow(m, time(m, s), status(m, now), s, m.id == pin?.id)
        val rest = matches.filter { it.id != pin?.id }
        val todays = rest.filter { day(it.kickoff) == today }.sortedWith(compareBy({ it.kickoff }, { it.id })).map { row(it, Section.TODAY) }
        val upcoming = rest.filter { day(it.kickoff).isAfter(today) }.sortedWith(compareBy({ it.kickoff }, { it.id })).map { row(it, Section.UPCOMING) }
        val recent = rest.filter { day(it.kickoff).isBefore(today) }.sortedWith(compareBy({ -it.kickoff }, { it.id })).map { row(it, Section.RECENT) }
        val top = pin?.let {
            val d = day(it.kickoff)
            listOf(row(it, if (d == today) Section.TODAY else if (d.isAfter(today)) Section.UPCOMING else Section.RECENT))
        } ?: emptyList()
        return top + todays + upcoming + recent
    }

    private fun time(m: Match, s: Section): String =
        if (s == Section.RECENT) {
            val z = Instant.ofEpochMilli(m.kickoff).atZone(zone)
            (weekday.format(z).uppercase() + " " + z.dayOfMonth).padEnd(6)
        } else board.boardTime(m.kickoff)

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
