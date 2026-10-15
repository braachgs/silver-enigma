package dayboard.core

import kotlin.math.ceil
import kotlin.math.max

const val MINUTE = 60_000L

enum class Tone { ON_TIME, BOARDING, FINAL, LIVE, INFO, PAST }

data class Remark(val text: String, val tone: Tone)

/**
 * Departure-board remarks, as the web app's split-flap style: a row only
 * changes at an event's boundaries, so the widget only needs waking then.
 */
object Remarks {
    val ON_TIME = Remark("ON TIME", Tone.ON_TIME)
    val BOARDING = Remark("BOARDING", Tone.BOARDING)
    val FINAL_CALL = Remark("FINAL CALL", Tone.FINAL)
    val NOW = Remark("NOW", Tone.LIVE)
    val DEPARTED = Remark("DEPARTED", Tone.PAST)
    val TOMORROW = Remark("TOMORROW", Tone.INFO)

    /** Whole minutes until [t], rounded up, as the web app counts them. */
    fun minutesUntil(now: Long, t: Long): Int = max(0, ceil((t - now) / MINUTE.toDouble()).toInt())

    fun of(start: Long, end: Long, now: Long): Remark = when {
        end <= now && start < now -> DEPARTED
        start <= now -> NOW
        else -> {
            val m = minutesUntil(now, start)
            when {
                m <= 2 -> FINAL_CALL
                m <= 15 -> BOARDING
                else -> ON_TIME
            }
        }
    }

    /** The next instant after [now] at which [of] gives a different remark, or null. */
    fun nextChange(start: Long, end: Long, now: Long): Long? =
        listOf(start - 15 * MINUTE, start - 2 * MINUTE, start, end).filter { it > now }.minOrNull()
}
