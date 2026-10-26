package com.braachgs.matchboard

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import dayboard.match.Clubs
import java.text.DateFormat
import java.util.Date

/** Your API key, the club you follow, and the state of the last update. */
class SettingsActivity : Activity() {
    private val board = 0xFF0E0E0E.toInt()
    private val card = 0xFF161616.toInt()
    private val ink = 0xFFF4F1E6.toInt()
    private val dim = 0xFFA39E8F.toInt()
    private val amber = 0xFFF2B705.toInt()

    private lateinit var content: LinearLayout
    private val main = Handler(Looper.getMainLooper())
    private val flap by lazy { Widgets.typeface(this) }
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(32))
        }
        setContentView(ScrollView(this).apply { setBackgroundColor(board); addView(content) })
    }

    override fun onResume() {
        super.onResume()
        build()
        if (Store.apiKey(this).isNotEmpty()) Refresh.ensurePeriodic(this)
    }

    private fun build() {
        content.removeAllViews()
        content.addView(text("MATCH BOARD", 30f, ink, flap).apply { letterSpacing = 0.08f })
        content.addView(text("Premier League scores on a split-flap board, for your home screen.", 15f, dim).apply { setPadding(0, dp(4), 0, dp(12)) })

        content.addView(ImageView(this).apply {
            adjustViewBounds = true
            setPadding(0, dp(8), 0, dp(16))
            val w = (resources.configuration.screenWidthDp - 40f).coerceIn(250f, 420f)
            setImageBitmap(Widgets.render(this@SettingsActivity, w, 170f, clock = clock()).bitmap)
            contentDescription = "Preview of the widget"
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

        keySection()
        if (Store.apiKey(this).isNotEmpty()) {
            clubSection()
            tableSection()
            statusSection()
        }

        val placed = Widgets.ids(this).size
        content.addView(button(if (placed == 0) "Add to home screen" else "Add another to home screen", primary = Store.apiKey(this).isNotEmpty()) { pin() }
            .apply { (layoutParams as LinearLayout.LayoutParams).topMargin = dp(24) })
        content.addView(text("Tap a finished match for its highlights on YouTube, or a live or upcoming one for Peacock's Premier League page. " +
            "Tap the board's header to come back here.", 13f, dim).apply { setPadding(0, dp(16), 0, 0) })
        content.addView(text("Updates every 15 minutes. While your club is playing, every minute as long as the screen is on and Battery Saver is off. " +
            "Scores are exactly as football-data.org last sent them; the footer says when that was.", 13f, dim).apply { setPadding(0, dp(8), 0, 0) })
        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: ""
        content.addView(text("Version $version · Data: football-data.org", 12f, dim).apply { setPadding(0, dp(8), 0, 0) })
    }

    private fun cap(s: String) = text(s, 14f, dim, flap).apply { letterSpacing = 0.14f; setPadding(0, dp(24), 0, dp(6)) }

    private fun keySection() {
        content.addView(cap("API KEY"))
        val saved = Store.apiKey(this)
        content.addView(text(
            if (saved.isEmpty()) "Paste your football-data.org API key (free at football-data.org/client/register). It stays on this phone and is only sent to football-data.org."
            else "Key saved, ending …${saved.takeLast(4)}. Paste a new one to replace it.", 13f, dim).apply { setPadding(0, 0, 0, dp(8)) })
        val field = EditText(this).apply {
            hint = if (saved.isEmpty()) "API key" else "New API key"
            setHintTextColor(dim)
            setTextColor(ink)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            isSingleLine = true
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        content.addView(field, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        content.addView(button("Save key", primary = saved.isEmpty()) {
            val key = field.text.toString().trim()
            if (key.length < 16) { toast("That doesn't look like a football-data.org key."); return@button }
            field.setText("")
            Store.setApiKey(this, key)
            toast("Checking the key…")
            worker.execute {
                val teams = Feed.loadTeams(this)
                val err = teams ?: Feed.refresh(this)
                Widgets.updateAll(this)
                Refresh.ensurePeriodic(this)
                Refresh.plan(this)
                main.post {
                    toast(if (err == null) "Key works. Matches loaded." else "Saved, but the update failed: ${err.lowercase()}.")
                    build()
                }
            }
        }.apply { (layoutParams as LinearLayout.LayoutParams).topMargin = dp(8) })
    }

    private fun clubSection() {
        content.addView(cap("YOUR CLUB"))
        content.addView(text("Its next or current match is pinned to the top row, with an amber bar.", 13f, dim).apply { setPadding(0, 0, 0, dp(8)) })
        val teams = Store.teams(this)
        val current = Store.followed(this, Store.feed(this).matches)
        if (teams.isEmpty()) {
            content.addView(text(if (current == 402) "Brentford (until the club list loads)" else "Club $current", 16f, ink))
            content.addView(button("Load clubs", primary = false) {
                worker.execute {
                    val err = Feed.loadTeams(this)
                    main.post { if (err != null) toast("Couldn't load the clubs: ${err.lowercase()}."); build() }
                }
            }.apply { (layoutParams as LinearLayout.LayoutParams).topMargin = dp(8) })
            return
        }
        val names = teams.map { Clubs.name(it) }
        val spinner = Spinner(this).apply {
            adapter = ArrayAdapter(this@SettingsActivity, android.R.layout.simple_spinner_dropdown_item, names)
            setSelection(teams.indexOfFirst { it.id == current }.coerceAtLeast(0), false)
            background = GradientDrawable().apply { setColor(card); cornerRadius = dp(10).toFloat() }
            setPadding(dp(8), dp(10), dp(8), dp(10))
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                    val team = teams[position]
                    if (team.id == Store.savedFollowed(this@SettingsActivity)) return
                    Store.setFollowed(this@SettingsActivity, team.id)
                    worker.execute {
                        Feed.refresh(this@SettingsActivity)
                        Widgets.updateAll(this@SettingsActivity)
                        Refresh.plan(this@SettingsActivity)
                        main.post { build() }
                    }
                }
                override fun onNothingSelected(parent: AdapterView<*>?) {}
            }
        }
        content.addView(spinner, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
    }

    /** The CHAMPIONSHIP tab: which club to highlight. */
    private fun tableSection() {
        content.addView(cap("CHAMPIONSHIP CLUB"))
        content.addView(text("Highlighted on the CHAMPIONSHIP tab (tap the tab names at the top of the widget to switch). Name, short name or code: Wrexham, Boro, WRE.", 13f, dim).apply {
            setPadding(0, 0, 0, dp(8))
        })
        val field = EditText(this).apply {
            setText(Store.tableClub(this@SettingsActivity))
            setTextColor(ink)
            isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
        }
        content.addView(field, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        content.addView(button("Save club", primary = false) {
            Store.setTableClub(this, field.text.toString())
            worker.execute {
                Feed.table(this, Store.apiKey(this), force = Store.tableAt(this) == 0L)
                Widgets.updateAll(this)
                main.post { toast("Saved."); build() }
            }
        }.apply { (layoutParams as LinearLayout.LayoutParams).topMargin = dp(8) })
    }

    private fun statusSection() {
        content.addView(cap("LAST UPDATE"))
        val state = Store.feed(this)
        val at = state.fetchedAt?.let { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(it)) } ?: "not yet"
        val err = state.error?.let { " Latest attempt failed: ${it.lowercase()}." } ?: ""
        content.addView(text("Matches as of $at. ${state.matches.size} matches stored.$err", 14f, if (state.error != null) amber else ink))
        content.addView(button("Update now", primary = false) {
            toast("Updating…")
            worker.execute {
                val e = Feed.refresh(this)
                Widgets.updateAll(this)
                Refresh.plan(this)
                main.post { toast(if (e == null) "Updated." else "Update failed: ${e.lowercase()}."); build() }
            }
        }.apply { (layoutParams as LinearLayout.LayoutParams).topMargin = dp(8) })
    }

    private fun pin() {
        val mgr = AppWidgetManager.getInstance(this)
        if (mgr.isRequestPinAppWidgetSupported) mgr.requestPinAppWidget(ComponentName(this, MatchWidget::class.java), null, null)
        else toast("Long-press your home screen, tap Widgets, then find Match Board.")
    }

    private fun clock(): String =
        android.text.format.DateFormat.format(if (android.text.format.DateFormat.is24HourFormat(this)) "HH:mm" else "h:mm", System.currentTimeMillis()).toString()

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    private fun text(s: String, sizeSp: Float, color: Int, face: Typeface? = null) = TextView(this).apply {
        text = s
        setTextColor(color)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        if (face != null) typeface = face
    }

    private fun button(label: String, primary: Boolean, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        setTextColor(if (primary) 0xFF111111.toInt() else ink)
        background = GradientDrawable().apply {
            cornerRadius = dp(24).toFloat()
            if (primary) setColor(amber) else { setColor(0); setStroke(dp(1), dim) }
        }
        minHeight = dp(48)
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
    }
}
