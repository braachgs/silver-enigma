package com.braachgs.dayboard

import android.Manifest
import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

/** Grants calendar access, previews the board, adds the widget, and picks calendars and line codes. */
class MainActivity : Activity() {
    private val board = 0xFF0E0E0E.toInt()
    private val card = 0xFF161616.toInt()
    private val ink = 0xFFF4F1E6.toInt()
    private val dim = 0xFFA39E8F.toInt()
    private val amber = 0xFFF2B705.toInt()

    private lateinit var content: LinearLayout
    private var preview: ImageView? = null
    private val main = Handler(Looper.getMainLooper())
    private val pushToWidgets = Runnable { worker.execute { WidgetUpdater.updateAll(applicationContext) } }

    private val flap by lazy { WidgetUpdater.typeface(this) }
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(20), dp(20), dp(32))
        }
        setContentView(ScrollView(this).apply {
            setBackgroundColor(board)
            addView(content)
        })
    }

    override fun onResume() {
        super.onResume()
        build()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        build()
        pushToWidgets.run()
    }

    private fun build() {
        content.removeAllViews()
        content.addView(text("DAY BOARD", 30f, ink, flap).apply { letterSpacing = 0.08f })
        content.addView(text("Your next calendar events as a split-flap departure board on your home screen.", 15f, dim).apply {
            setPadding(0, dp(4), 0, dp(16))
        })

        val allowed = CalendarSource.hasPermission(this)
        if (!allowed) {
            content.addView(text("The widget reads the calendars already on this phone, every Google account included. Nothing leaves the phone.", 15f, ink).apply {
                setPadding(0, 0, 0, dp(12))
            })
            content.addView(button("Allow calendar access", primary = true) { askForCalendar() })
        }

        preview = ImageView(this).apply {
            adjustViewBounds = true
            setPadding(0, dp(16), 0, dp(16))
        }
        content.addView(preview, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        drawPreview()

        val placed = WidgetUpdater.widgetIds(this).size
        content.addView(button(if (placed == 0) "Add to home screen" else "Add another to home screen", primary = allowed) { pinWidget() })
        if (placed > 0) content.addView(text("On your home screen: $placed widget${if (placed == 1) "" else "s"}. Resize it by long-pressing it.", 13f, dim).apply {
            setPadding(0, dp(6), 0, 0)
        })
        content.addView(button("Open Day Board", primary = false) {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(WidgetUpdater.WEB_APP)))
        }.apply { (layoutParams as? LinearLayout.LayoutParams)?.topMargin = dp(10) })

        if (allowed) calendarSection()

        content.addView(text("Times show your phone's 12- or 24-hour setting. Line colours are your calendar colours. Tap the widget to open Day Board.", 13f, dim).apply {
            setPadding(0, dp(24), 0, 0)
        })
        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: ""
        content.addView(text("Version $version", 12f, dim).apply { setPadding(0, dp(6), 0, 0) })
    }

    private fun calendarSection() {
        content.addView(text("CALENDARS", 14f, dim, flap).apply {
            letterSpacing = 0.14f
            setPadding(0, dp(28), 0, dp(4))
        })
        content.addView(text("Switch a calendar off to keep it off the board. The code is what its line tile says.", 13f, dim).apply {
            setPadding(0, 0, 0, dp(8))
        })
        val hidden = Settings.hiddenCalendars(this)
        val calendars = CalendarSource.calendars(this)
        if (calendars.isEmpty()) content.addView(text("No calendars on this phone yet. Add your Google account in Android Settings > Accounts.", 15f, ink))
        for (cal in calendars) content.addView(calendarRow(cal, cal.id !in hidden))
    }

    private fun calendarRow(cal: PhoneCalendar, shown: Boolean): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(10), dp(8), dp(10))
            background = GradientDrawable().apply { setColor(card); cornerRadius = dp(10).toFloat() }
        }
        val swatch = View(this).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(cal.color or 0xFF000000.toInt()) }
        }
        row.addView(swatch, LinearLayout.LayoutParams(dp(14), dp(14)).apply { marginEnd = dp(12) })
        val names = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        names.addView(text(cal.name.ifBlank { "(no name)" }, 16f, ink))
        if (cal.account.isNotBlank() && cal.account != cal.name) names.addView(text(cal.account, 12f, dim))
        row.addView(names, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))

        val code = EditText(this).apply {
            setText(Settings.customCode(this@MainActivity, cal.id) ?: "")
            hint = dayboard.core.Flap.code(cal.name)
            setHintTextColor(dim)
            setTextColor(ink)
            typeface = flap
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            gravity = Gravity.CENTER
            filters = arrayOf(InputFilter.LengthFilter(3), InputFilter.AllCaps())
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            isSingleLine = true
            contentDescription = "Line code for ${cal.name}"
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable?) {
                    Settings.setCode(this@MainActivity, cal.id, s?.toString() ?: "")
                    changed()
                }
            })
        }
        row.addView(code, LinearLayout.LayoutParams(dp(64), WRAP_CONTENT))

        val toggle = Switch(this).apply {
            isChecked = shown
            contentDescription = "Show ${cal.name} on the widget"
            setOnCheckedChangeListener { _, on ->
                Settings.setShown(this@MainActivity, cal.id, on)
                changed()
            }
        }
        row.addView(toggle)
        return row.also {
            it.layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) }
        }
    }

    /** Redraw the preview now, and the widgets shortly after the last change. */
    private fun changed() {
        drawPreview()
        main.removeCallbacks(pushToWidgets)
        main.postDelayed(pushToWidgets, 700)
    }

    private fun drawPreview() {
        val view = preview ?: return
        val widthDp = resources.configuration.screenWidthDp - 40f
        val (bitmap, _) = WidgetUpdater.render(this, widthDp.coerceIn(220f, 420f), 160f, clock = currentClock())
        view.setImageBitmap(bitmap)
        view.contentDescription = "Preview of the widget"
    }

    private fun currentClock(): String =
        android.text.format.DateFormat.format(if (android.text.format.DateFormat.is24HourFormat(this)) "HH:mm" else "h:mm", System.currentTimeMillis()).toString()

    private fun askForCalendar() {
        if (checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED) return
        val askedBefore = getSharedPreferences("app", MODE_PRIVATE).getBoolean("asked", false)
        if (askedBefore && !shouldShowRequestPermissionRationale(Manifest.permission.READ_CALENDAR)) {
            // Android won't ask again: open this app's settings page instead.
            Toast.makeText(this, "Tap Permissions, then Calendar, then Allow.", Toast.LENGTH_LONG).show()
            startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            return
        }
        getSharedPreferences("app", MODE_PRIVATE).edit().putBoolean("asked", true).apply()
        requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR), 1)
    }

    private fun pinWidget() {
        val mgr = AppWidgetManager.getInstance(this)
        if (mgr.isRequestPinAppWidgetSupported) {
            mgr.requestPinAppWidget(ComponentName(this, BoardWidget::class.java), null, null)
        } else {
            Toast.makeText(this, "Long-press your home screen, tap Widgets, then find Day Board.", Toast.LENGTH_LONG).show()
        }
    }

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
