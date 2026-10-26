package dayboard.match

import java.time.Instant

/** football-data.org v4 match statuses. */
enum class MatchStatus {
    SCHEDULED, TIMED, IN_PLAY, PAUSED, FINISHED, POSTPONED, SUSPENDED, CANCELLED, AWARDED, UNKNOWN;

    val live get() = this == IN_PLAY || this == PAUSED
    val done get() = this == FINISHED || this == AWARDED
    val upcoming get() = this == SCHEDULED || this == TIMED

    companion object {
        // LIVE is an older alias some feeds still send for a match in play.
        fun of(s: String?): MatchStatus = when (s) {
            "LIVE" -> IN_PLAY
            null -> UNKNOWN
            else -> entries.firstOrNull { it.name == s } ?: UNKNOWN
        }
    }
}

data class Team(val id: Int, val name: String, val shortName: String, val tla: String)

enum class Winner { HOME, AWAY, DRAW }

data class Match(
    val id: Long,
    /** Kickoff, UTC millis. */
    val kickoff: Long,
    val status: MatchStatus,
    val home: Team,
    val away: Team,
    /** The score as the feed last reported it; null when it reported none. Never filled in by the app. */
    val homeScore: Int?,
    val awayScore: Int?,
    val winner: Winner?,
) {
    fun involves(teamId: Int) = home.id == teamId || away.id == teamId
}

/** Reads football-data.org v4 responses. */
object FootballData {
    const val BASE = "https://api.football-data.org/v4"

    fun parseMatches(json: String): List<Match> =
        Json.parse(json).obj()?.get("matches").list().mapNotNull { parseMatch(it.obj()) }

    fun parseMatch(m: Map<String, Any?>?): Match? {
        m ?: return null
        val id = m.long("id") ?: return null
        val kickoff = m.str("utcDate")?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() } ?: return null
        val home = parseTeam(m["homeTeam"].obj()) ?: return null
        val away = parseTeam(m["awayTeam"].obj()) ?: return null
        val score = m["score"].obj()
        // During a match v4 keeps the running score in fullTime.
        val ft = score?.get("fullTime").obj()
        val winner = when (score.str("winner")) {
            "HOME_TEAM" -> Winner.HOME
            "AWAY_TEAM" -> Winner.AWAY
            "DRAW" -> Winner.DRAW
            else -> null
        }
        return Match(id, kickoff, MatchStatus.of(m.str("status")), home, away, ft.int("home"), ft.int("away"), winner)
    }

    fun parseTeam(t: Map<String, Any?>?): Team? {
        t ?: return null
        val id = t.int("id") ?: return null
        val name = t.str("name") ?: t.str("shortName") ?: return null
        return Team(id, name, t.str("shortName") ?: name, t.str("tla") ?: name.take(3).uppercase())
    }

    /** The clubs in a /competitions/PL/teams response, by short name. */
    fun parseTeams(json: String): List<Team> =
        Json.parse(json).obj()?.get("teams").list().mapNotNull { parseTeam(it.obj()) }.sortedBy { Clubs.name(it) }

    /** The API's error message, if [json] is one. */
    fun errorMessage(json: String?): String? =
        runCatching { Json.parse(json ?: "").obj().str("message") }.getOrNull()
}

/** How club names read on the board. */
object Clubs {
    // football-data.org's short names, where a fan would say it differently.
    private val names = mapOf(
        "Brighton Hove" to "Brighton",
        "Wolverhampton" to "Wolves",
        "Nottingham" to "Nott'm Forest",
        "Ipswich Town" to "Ipswich",
        "Leicester City" to "Leicester",
        "Leeds United" to "Leeds",
        "Sheffield Utd" to "Sheff Utd",
    )
    // Shorter still, when a narrow board can't fit the name.
    private val compact = mapOf(
        "Crystal Palace" to "Palace",
        "Nott'm Forest" to "Forest",
        "Aston Villa" to "Villa",
        "Bournemouth" to "B'mouth",
        "Southampton" to "Saints",
        "Man United" to "Man Utd",
        "Sunderland" to "S'land",
        "Tottenham" to "Spurs",
        "Newcastle" to "Newcastle",
        "Middlesbrough" to "Boro",
        "Sheffield Wed" to "Sheff Wed",
        "Sheff Utd" to "Sheff Utd",
        "Preston NE" to "Preston",
        "Birmingham" to "Brum",
        "Portsmouth" to "Pompey",
        "West Brom" to "West Brom",
    )

    fun name(t: Team): String = names[t.shortName] ?: t.shortName

    // Words a club name can lose and still be unmistakable: Coventry City -> Coventry.
    private val suffix = Regex("\\s+(City|Town|United|Utd|Athletic|Albion|Rovers|Wanderers|County|FC|AFC)$", RegexOption.IGNORE_CASE)

    /**
     * The name in at most [cells] flaps: full, then a common short form,
     * then without a generic last word (City, Town, United...), and only
     * then the three-letter code.
     */
    fun fit(t: Team, cells: Int): String {
        val full = name(t)
        if (full.length <= cells) return full
        val short = compact[full]
        if (short != null && short.length <= cells) return short
        var bare = full
        while (true) {
            val next = bare.replace(suffix, "")
            if (next == bare || next.isBlank()) break
            bare = next
            if (bare.length <= cells) return bare
        }
        return t.tla.take(cells)
    }
}
