package com.braachgs.matchboard

import android.content.Context
import android.util.Log
import dayboard.match.FootballData
import dayboard.match.MatchBoardBuilder
import java.time.LocalDate
import java.time.ZoneId

/**
 * Fetches Premier League matches. A full update takes two requests (the past
 * week and the coming week, each within the API's date-range limit); a live
 * update fetches only today's matches. The free plan allows 10 requests a
 * minute.
 */
object Feed {
    private fun matches(from: LocalDate, to: LocalDate) = "/competitions/PL/matches?dateFrom=$from&dateTo=$to"

    /** Returns null on success, else the failure's footer label. Never touches stored scores on failure. */
    fun refresh(c: Context, liveOnly: Boolean = false): String? {
        val key = Store.apiKey(c)
        if (key.isEmpty()) return "NO API KEY"
        val zone = ZoneId.systemDefault()
        val today = LocalDate.now(zone)
        return try {
            if (liveOnly) {
                Store.put(c, Store.TODAY, Api.get(matches(today, today), key), System.currentTimeMillis())
            } else {
                Store.put(c, Store.NEXT, Api.get(matches(today, today.plusDays(7)), key), System.currentTimeMillis())
                Store.put(c, Store.PAST, Api.get(matches(today.minusDays(7), today.minusDays(1)), key), System.currentTimeMillis())
                clubNext(c, key, zone)
            }
            table(c, key)
            null
        } catch (e: ApiError) {
            Log.w("MatchBoard", "update failed: ${e.label}: ${e.message}")
            Store.setError(c, e.label)
            e.label
        } catch (e: Exception) {
            Log.w("MatchBoard", "update failed", e)
            Store.setError(c, "UPDATE FAILED")
            "UPDATE FAILED"
        }
    }

    /**
     * Your club's next match when it's beyond the coming week (an
     * international break): at most every six hours, and only then.
     */
    private fun clubNext(c: Context, key: String, zone: ZoneId) {
        val now = System.currentTimeMillis()
        val state = Store.feed(c, now)
        val club = Store.followed(c, state.matches)
        if (MatchBoardBuilder(zone).pinned(state.matches, club, now) != null) return
        if (now - Store.clubFetchedAt(c) < 6 * 60 * 60 * 1000L) return
        Store.setClubFetchedAt(c, now)
        runCatching {
            Store.put(c, Store.CLUB, Api.get("/teams/$club/matches?competitions=PL&status=SCHEDULED,TIMED&limit=3", key), now)
        }.onFailure { Log.w("MatchBoard", "club fixtures: ${it.message}") }
    }

    /**
     * The Championship table, at most every 30 minutes. A failure here is
     * the table tab's own: it never marks the match board stale.
     */
    fun table(c: Context, key: String, force: Boolean = false) {
        if (!force && System.currentTimeMillis() - Store.tableAt(c) < 30 * 60_000L) return
        try {
            Store.putTable(c, Api.get("/competitions/ELC/standings", key), System.currentTimeMillis())
        } catch (e: ApiError) {
            Log.w("MatchBoard", "table failed: ${e.label}: ${e.message}")
            Store.setTableError(c, e.label)
        } catch (e: Exception) {
            Log.w("MatchBoard", "table failed", e)
            Store.setTableError(c, "UPDATE FAILED")
        }
    }

    /** The Premier League's clubs, for the picker. */
    fun loadTeams(c: Context): String? = try {
        Store.setTeams(c, Api.get("/competitions/PL/teams", Store.apiKey(c)))
        if (Store.savedFollowed(c) == null) Store.setFollowed(c, Store.followed(c))
        null
    } catch (e: ApiError) {
        e.label
    } catch (e: Exception) {
        "UPDATE FAILED"
    }

    /** Parses as the board will, to check a stored response is usable. */
    fun count(json: String): Int = runCatching { FootballData.parseMatches(json).size }.getOrDefault(0)
}
