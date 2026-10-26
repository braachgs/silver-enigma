package com.braachgs.matchboard

import android.content.Context
import dayboard.match.FeedState
import dayboard.match.FootballData
import dayboard.match.Match
import dayboard.match.Standings
import dayboard.match.TableState
import dayboard.match.Team

/**
 * Everything Match Board keeps, in this app's private storage: your API key
 * (only ever sent to football-data.org), the club you follow, and the last
 * response of each request with the time it arrived.
 */
object Store {
    private const val FILE = "matchboard"
    private const val KEY = "api_key"
    private const val FOLLOWED = "followed"
    private const val ERROR = "error"
    private const val TEAMS = "teams"
    private const val CLUB_AT = "club_at"
    const val PAST = "past"
    const val NEXT = "next"
    const val TODAY = "today"
    const val CLUB = "club"
    private val SOURCES = listOf(CLUB, PAST, NEXT, TODAY)
    /** football-data.org's id for Brentford, the default club; the name is checked too. */
    private const val BRENTFORD = 402

    private fun prefs(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun apiKey(c: Context): String = prefs(c).getString(KEY, "")!!.trim()
    fun setApiKey(c: Context, key: String) {
        prefs(c).edit().putString(KEY, key.trim()).remove(ERROR).apply()
    }

    fun savedFollowed(c: Context): Int? = prefs(c).getInt(FOLLOWED, -1).takeIf { it > 0 }
    fun setFollowed(c: Context, id: Int) {
        prefs(c).edit().putInt(FOLLOWED, id).remove(CLUB).remove(CLUB_AT).apply()
    }

    /** The club you picked, else Brentford. */
    fun followed(c: Context, matches: List<Match> = emptyList()): Int =
        savedFollowed(c)
            ?: (teams(c) + matches.flatMap { listOf(it.home, it.away) }).firstOrNull { it.name.contains("Brentford", true) }?.id
            ?: BRENTFORD

    fun teams(c: Context): List<Team> =
        prefs(c).getString(TEAMS, null)?.let { runCatching { FootballData.parseTeams(it) }.getOrNull() } ?: emptyList()
    fun setTeams(c: Context, json: String) { prefs(c).edit().putString(TEAMS, json).apply() }

    fun put(c: Context, source: String, json: String, at: Long) {
        prefs(c).edit().putString("src_$source", json).putLong("at_$source", at).remove(ERROR).apply()
    }
    fun at(c: Context, source: String): Long? = prefs(c).getLong("at_$source", 0).takeIf { it > 0 }

    fun clubFetchedAt(c: Context): Long = prefs(c).getLong(CLUB_AT, 0)
    fun setClubFetchedAt(c: Context, at: Long) { prefs(c).edit().putLong(CLUB_AT, at).apply() }

    // ---------------------------------------------------------------- the table tab

    /** Which tab a widget shows: 0 matches, 1 the Championship table. */
    fun tab(c: Context, widgetId: Int): Int = prefs(c).getInt("tab_$widgetId", 0)
    fun setTab(c: Context, widgetId: Int, tab: Int) { prefs(c).edit().putInt("tab_$widgetId", tab).apply() }

    /** The Championship club to highlight (default Wrexham). */
    fun tableClub(c: Context): String = prefs(c).getString(TABLE_CLUB, null)?.trim()?.ifEmpty { null } ?: "Wrexham"
    fun setTableClub(c: Context, club: String) { prefs(c).edit().putString(TABLE_CLUB, club.trim()).apply() }

    fun putTable(c: Context, json: String, at: Long) {
        prefs(c).edit().putString(TABLE, json).putLong(TABLE_AT, at).remove(TABLE_ERROR).apply()
    }
    fun tableAt(c: Context): Long = prefs(c).getLong(TABLE_AT, 0)
    fun setTableError(c: Context, label: String) { prefs(c).edit().putString(TABLE_ERROR, label).apply() }

    /** The last Championship table fetched, exactly as sent, and how the latest attempt went. */
    fun table(c: Context): TableState {
        if (apiKey(c).isEmpty()) return TableState(emptyList(), null, message = "ADD YOUR API KEY IN MATCH BOARD")
        val p = prefs(c)
        val rows = p.getString(TABLE, null)?.let { runCatching { Standings.parse(it) }.getOrNull() } ?: emptyList()
        return TableState(rows, tableAt(c).takeIf { it > 0 }, error = p.getString(TABLE_ERROR, null))
    }

    private const val TABLE = "elc"
    private const val TABLE_AT = "elc_at"
    private const val TABLE_ERROR = "elc_error"
    private const val TABLE_CLUB = "elc_club"

    fun error(c: Context): String? = prefs(c).getString(ERROR, null)
    fun setError(c: Context, label: String) { prefs(c).edit().putString(ERROR, label).apply() }

    /**
     * What the board shows: every stored response merged, a newer copy of a
     * match replacing an older one. Scores are exactly as the feed last sent
     * them; "as of" is when today's and the coming matches last arrived.
     */
    fun feed(c: Context, now: Long = System.currentTimeMillis()): FeedState {
        if (apiKey(c).isEmpty()) return FeedState(emptyList(), null, message = "ADD YOUR API KEY IN MATCH BOARD")
        val p = prefs(c)
        val byId = LinkedHashMap<Long, Match>()
        val sources = SOURCES.mapNotNull { s -> p.getString("src_$s", null)?.let { Triple(s, it, p.getLong("at_$s", 0)) } }
        for ((_, json, _) in sources.sortedBy { it.third }) {
            runCatching { FootballData.parseMatches(json) }.getOrNull()?.forEach { byId[it.id] = it }
        }
        // Results more than a week old have nothing left to say.
        val matches = byId.values.filter { it.kickoff > now - 8 * DAY }
        val asOf = listOfNotNull(at(c, NEXT), at(c, TODAY)).maxOrNull()
        return FeedState(matches, asOf, error = error(c))
    }

    const val DAY = 24 * 60 * 60 * 1000L
}
