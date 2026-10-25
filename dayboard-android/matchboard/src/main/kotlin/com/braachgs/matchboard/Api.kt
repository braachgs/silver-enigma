package com.braachgs.matchboard

import dayboard.match.FootballData
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** A failed request, with the short label the board's footer shows. */
class ApiError(val label: String, message: String) : Exception(message)

/** football-data.org v4, with your key in the X-Auth-Token header. */
object Api {
    fun get(path: String, key: String): String {
        if (key.isBlank()) throw ApiError("NO API KEY", "Add your API key first.")
        val c = URL(FootballData.BASE + path).openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 15_000
            c.readTimeout = 20_000
            c.setRequestProperty("X-Auth-Token", key)
            c.setRequestProperty("Accept", "application/json")
            val code = try {
                c.responseCode
            } catch (e: IOException) {
                throw ApiError("OFFLINE", "No connection to football-data.org.")
            }
            val body = runCatching { (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } }.getOrNull() ?: ""
            if (code == 200) return body
            val msg = FootballData.errorMessage(body) ?: "HTTP $code"
            throw when {
                code == 429 -> ApiError("RATE LIMITED", msg)
                code == 403 && msg.contains("restricted", true) -> ApiError("NOT IN YOUR PLAN", msg)
                code == 400 || code == 401 || code == 403 -> ApiError("CHECK API KEY", msg)
                code >= 500 -> ApiError("SERVER ERROR", msg)
                else -> ApiError("UPDATE FAILED", msg)
            }
        } finally {
            c.disconnect()
        }
    }
}
