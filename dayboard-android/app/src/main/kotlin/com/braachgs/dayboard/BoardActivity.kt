package com.braachgs.dayboard

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Day Board itself: the web app's board, reading every account on this phone
 * through [PhoneBridge] instead of Google sign-in. The page comes from GitHub
 * Pages (and its offline cache), so board changes arrive without a new APK.
 */
class BoardActivity : Activity() {
    private lateinit var web: WebView
    private val main = Handler(Looper.getMainLooper())

    /** Tells the page the calendar store changed (a sync landed, or another app edited it). */
    private val notifyPage = Runnable {
        web.evaluateJavascript("window.DayBoardPhoneChanged && window.DayBoardPhoneChanged()", null)
    }
    private val observer = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) {
            main.removeCallbacks(notifyPage)
            main.postDelayed(notifyPage, 1_500)
        }
    }
    private val pushToWidgets = Runnable { worker.execute { updateSafely(applicationContext) } }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this).apply {
            setBackgroundColor(0xFF161616.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = true
            addJavascriptInterface(PhoneBridge(this@BoardActivity) {
                main.removeCallbacks(pushToWidgets)
                main.postDelayed(pushToWidgets, 500)
            }, "DayBoardPhone")
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                // The calendar bridge is only for Day Board's own pages: anything
                // else (video calls, maps, links in notes) opens in its own app.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (isBoard(request.url)) return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    return true
                }
            }
        }
        setContentView(web)
        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(WidgetUpdater.WEB_APP)
        askForCalendar()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onStart() {
        super.onStart()
        if (CalendarSource.hasPermission(this)) {
            contentResolver.registerContentObserver(CalendarContract.CONTENT_URI, true, observer)
        }
        notifyPage.run() // back from another app: fetch again
    }

    override fun onStop() {
        super.onStop()
        runCatching { contentResolver.unregisterContentObserver(observer) }
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        web.destroy()
        super.onDestroy()
    }

    @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    fun askForCalendar() {
        val missing = arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 2)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (CalendarSource.hasPermission(this)) {
            runCatching { contentResolver.unregisterContentObserver(observer) }
            contentResolver.registerContentObserver(CalendarContract.CONTENT_URI, true, observer)
            web.reload()
            pushToWidgets.run()
        }
    }

    companion object {
        private val BOARD = Uri.parse(WidgetUpdater.WEB_APP)

        fun isBoard(url: Uri): Boolean =
            url.scheme == "https" && url.host == BOARD.host && (url.path ?: "").startsWith(BOARD.path ?: "/")
    }
}
