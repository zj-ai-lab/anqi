package com.fdong.anjian

import android.app.Activity
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import java.io.File
import java.net.URI
import java.util.Locale

/**
 * 案齐安卓壳：单 Activity + WebView，由使用者连接自己的案齐服务器。
 *
 * 登录态（`anjian_sess`，HttpOnly、30 天滚动）存在壳自己的 CookieManager 里；外部小组件
 * 可以显式启动本 Activity 并携带站内 URL，但只有与已配置服务器严格同源的地址才会加载。
 *
 * 几条不能改的地方：
 *  - manifest 里 exported=true + singleTask；本类的 [onCreate] 与 [onNewIntent] **都**要读
 *    intent.data 决定 loadUrl，只在 onCreate 读的话第二次点小组件不会换页。
 *  - JS 与 DOM storage 必开：站点皮肤存在 localStorage。
 *  - 下载必须带上 CookieManager 里的 Cookie 头，否则后端返 401。
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var errorView: View
    private lateinit var serverLabel: TextView
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var downloadReceiver: BroadcastReceiver? = null
    private var serverDialog: AlertDialog? = null
    private var configuredOrigin: Origin? = null
    private var pendingIntentUrl: String? = null

    /** 最近一次请求过的同源地址，断网重试时回到它而不是擅自换服务器。 */
    private var lastUrl: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        configuredOrigin = readSavedOrigin()
        webView = buildWebView()
        errorView = buildErrorView()

        val content = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor(BACKGROUND))
            addView(webView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(errorView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        val shell = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor(BACKGROUND))
            fitsSystemWindows = true // targetSdk 36 默认 edge-to-edge，避开状态栏/导航栏
            addView(buildServerBar(), LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(content, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        }
        setContentView(shell)

        updateServerLabel()
        registerDownloadReceiver()
        loadFrom(intent)
    }

    /** singleTask 下，第二次从外部小组件点进来走这里——同样按 intent.data 换页。 */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.let {
            setIntent(it)
            loadFrom(it)
        }
    }

    /** 外部 Intent 只接受与已配置服务器严格同源的站内地址，否则回服务器首页。 */
    private fun loadFrom(intent: Intent?) {
        val origin = configuredOrigin
        if (origin == null) {
            pendingIntentUrl = intent?.data?.toString()
            showServerDialog(required = true)
            return
        }
        val requested = intent?.data?.toString()
        val target = requested?.takeIf { isSameOrigin(it, origin) } ?: origin.url
        lastUrl = target
        showError(false)
        webView.loadUrl(target)
    }

    private fun buildServerBar(): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(6), dp(8), dp(6))
            setBackgroundColor(Color.parseColor(BACKGROUND))
        }
        serverLabel = TextView(this).apply {
            setTextColor(Color.parseColor(TEXT_SECONDARY))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        }
        row.addView(serverLabel, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        row.addView(Button(this).apply {
            text = "服务器"
            minHeight = 0
            minimumHeight = 0
            setPadding(dp(12), dp(6), dp(12), dp(6))
            setOnClickListener { showServerDialog(required = configuredOrigin == null) }
        }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        return row
    }

    private fun showServerDialog(required: Boolean) {
        if (serverDialog?.isShowing == true) return

        val input = EditText(this).apply {
            hint = "https://anqi.example.com"
            setText(configuredOrigin?.url.orEmpty())
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
            selectAll()
        }
        val warning = TextView(this).apply {
            text = "HTTP 明文传输，仅限可信局域网（loopback、RFC1918 或 .local）；其他地址必须 HTTPS。"
            setTextColor(Color.parseColor(TEXT_SECONDARY))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setPadding(0, dp(10), 0, 0)
        }
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4), 0, dp(4), 0)
            addView(input, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(warning, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        val builder = AlertDialog.Builder(this)
            .setTitle(if (required) "连接案齐服务器" else "更换服务器")
            .setMessage("请输入根地址，不要带账号密码、查询参数、片段或子路径。")
            .setView(body)
            .setPositiveButton("保存", null)
        if (!required) builder.setNegativeButton("取消", null)

        val dialog = builder.create().apply {
            setCancelable(!required)
            setCanceledOnTouchOutside(false)
            setOnShowListener {
                getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    val origin = parseOrigin(input.text?.toString().orEmpty())
                    if (origin == null) {
                        input.error = "地址无效；公网必须 HTTPS，HTTP 只允许可信 loopback、RFC1918 或 .local 根地址"
                        return@setOnClickListener
                    }
                    dismiss()
                    applyServer(origin)
                }
            }
            setOnDismissListener { serverDialog = null }
        }
        serverDialog = dialog
        dialog.show()
    }

    private fun applyServer(origin: Origin) {
        val previous = configuredOrigin
        if (previous == origin) {
            pendingIntentUrl = null
            updateServerLabel()
            return
        }
        val switched = previous != null
        configuredOrigin = origin
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_SERVER_ORIGIN, origin.url)
            .apply()
        updateServerLabel()

        val requested = pendingIntentUrl?.takeIf { isSameOrigin(it, origin) }
        pendingIntentUrl = null
        val target = requested ?: origin.url
        val loadTarget = {
            lastUrl = target
            showError(false)
            webView.loadUrl(target)
        }
        if (!switched) {
            loadTarget()
            return
        }

        // 不同实例之间绝不沿用登录态或浏览器存储；清完以后才加载新首页。
        WebStorage.getInstance().deleteAllData()
        webView.clearCache(true)
        webView.clearHistory()
        CookieManager.getInstance().removeAllCookies {
            CookieManager.getInstance().flush()
            runOnUiThread(loadTarget)
        }
    }

    private fun readSavedOrigin(): Origin? {
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val saved = prefs.getString(PREF_SERVER_ORIGIN, null) ?: return null
        val parsed = parseOrigin(saved)
        if (parsed == null) prefs.edit().remove(PREF_SERVER_ORIGIN).apply()
        return parsed
    }

    private fun updateServerLabel() {
        serverLabel.text = configuredOrigin?.url ?: "尚未配置服务器"
    }

    private fun buildWebView(): WebView = WebView(this).also { view ->
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, false)
        }
    }.apply {
        setBackgroundColor(Color.parseColor(BACKGROUND))
        with(settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val origin = configuredOrigin
                if (origin != null && isSameOrigin(request.url.toString(), origin)) return false
                if (!request.isForMainFrame) return true
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    })
                    true
                }.getOrDefault(true)
            }

            override fun onPageFinished(view: WebView, url: String) {
                val origin = configuredOrigin
                if (origin != null && isSameOrigin(url, origin)) lastUrl = url
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (request.isForMainFrame) showError(true)
            }
        }

        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = filePathCallback
                val chooser = runCatching { params.createIntent() }.getOrNull()
                    ?: Intent(Intent.ACTION_GET_CONTENT).apply { type = "*/*" }
                return runCatching {
                    startActivityForResult(chooser, REQ_FILE_CHOOSER)
                    true
                }.getOrElse {
                    fileChooserCallback = null
                    false
                }
            }
        }

        // 下载必须带当前目标 URL 对应的 Cookie 头，后端才认得壳内登录态。
        setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            enqueueDownload(url, userAgent, contentDisposition, mimeType)
        }
    }

    /** 断网 / 站点不可达时的兜底页：一句人话 + 重试。顶部服务器控件仍然可用。 */
    private fun buildErrorView(): View {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor(BACKGROUND))
            visibility = View.GONE
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }
        column.addView(TextView(this).apply {
            text = "连不上案齐"
            setTextColor(Color.parseColor(TEXT))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            gravity = Gravity.CENTER
        })
        column.addView(TextView(this).apply {
            text = "检查服务器地址和网络，或者稍后再试。"
            setTextColor(Color.parseColor(TEXT_SECONDARY))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(24))
        })
        column.addView(Button(this).apply {
            text = "重试"
            layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT)
            setOnClickListener {
                if (lastUrl.isNotBlank()) {
                    showError(false)
                    webView.loadUrl(lastUrl)
                } else {
                    showServerDialog(required = true)
                }
            }
        })
        return column
    }

    private fun showError(show: Boolean) {
        errorView.visibility = if (show) View.VISIBLE else View.GONE
        webView.visibility = if (show) View.GONE else View.VISIBLE
    }

    private fun enqueueDownload(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        val request = runCatching { DownloadManager.Request(Uri.parse(url)) }.getOrNull() ?: return
        val name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType)
        CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
        userAgent?.let { request.addRequestHeader("User-Agent", it) }
        request.setMimeType(mimeType)
        request.setTitle(name)
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        request.setDestinationInExternalFilesDir(this, android.os.Environment.DIRECTORY_DOWNLOADS, name)

        val dm = getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager ?: return
        runCatching { dm.enqueue(request) }
            .onSuccess { Toast.makeText(this, "开始下载 $name", Toast.LENGTH_SHORT).show() }
            .onFailure { Toast.makeText(this, "下载没起来：${it.message}", Toast.LENGTH_LONG).show() }
    }

    /** 下载完成后用 FileProvider 授权外部 app 打开（不做内嵌预览）。 */
    private fun registerDownloadReceiver() {
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
                if (id <= 0) return
                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager ?: return
                val local = dm.getUriForDownloadedFile(id) ?: return
                val path = runCatching { local.path?.let(::File) }.getOrNull()
                val shared = path?.takeIf { it.isFile }?.let { file ->
                    runCatching {
                        FileProvider.getUriForFile(context, "$packageName.fileprovider", file)
                    }.getOrNull()
                } ?: local
                val mime = dm.getMimeTypeForDownloadedFile(id) ?: "*/*"
                val open = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(shared, mime)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                runCatching { startActivity(open) }
                    .onFailure { Toast.makeText(context, "没有能打开这个文件的应用", Toast.LENGTH_LONG).show() }
            }
        }
        downloadReceiver = receiver
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(receiver, filter)
        }
    }

    @Deprecated("Activity 基类没有 ActivityResult API，文件选择只能走这条老路")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_FILE_CHOOSER) return
        val callback = fileChooserCallback ?: return
        fileChooserCallback = null
        callback.onReceiveValue(
            if (resultCode == RESULT_OK) {
                WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            } else {
                null
            },
        )
    }

    @Deprecated("与 Activity 基类保持一致；壳的返回逻辑就是先退网页历史")
    override fun onBackPressed() {
        if (errorView.visibility != View.VISIBLE && webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        serverDialog?.dismiss()
        serverDialog = null
        downloadReceiver?.let { runCatching { unregisterReceiver(it) } }
        downloadReceiver = null
        super.onDestroy()
    }

    /**
     * 只接受根 origin。URI 解析保持严格 ASCII 语法；国际化域名请输入其 Punycode 形式。
     * 不解析 DNS：`.local` 和私网 IP 的许可只由用户输入本身决定。
     */
    private fun parseOrigin(input: String): Origin? {
        val parsed = parseWebAddress(input, rootOnly = true) ?: return null
        if (parsed.scheme == "http" && !isTrustedHttpHost(parsed.host)) return null
        return parsed
    }

    private fun isSameOrigin(url: String, origin: Origin): Boolean {
        val candidate = parseWebAddress(url, rootOnly = false) ?: return false
        return candidate.scheme == origin.scheme &&
            candidate.host == origin.host &&
            candidate.effectivePort == origin.effectivePort
    }

    private fun parseWebAddress(input: String, rootOnly: Boolean): Origin? {
        val text = input.trim()
        if (text.isEmpty() || text.any { it <= ' ' || it == '\\' }) return null
        val uri = runCatching { URI(text) }.getOrNull() ?: return null
        if (!uri.isAbsolute || uri.isOpaque) return null
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        if (scheme != "http" && scheme != "https") return null
        if (uri.rawUserInfo != null || uri.rawAuthority?.contains('@') == true) return null
        if (rootOnly && (uri.rawQuery != null || uri.rawFragment != null)) return null
        if (rootOnly && uri.rawPath !in listOf("", "/")) return null

        val rawHost = uri.host ?: return null
        val host = rawHost.removePrefix("[").removeSuffix("]").lowercase(Locale.ROOT)
        if (host.isEmpty() || host.endsWith('.')) return null
        val port = runCatching { uri.port }.getOrNull() ?: return null
        if (port == 0 || port > 65535) return null

        val authorityHost = if (host.contains(':')) "[$host]" else host
        val expectedAuthority = authorityHost + if (port >= 0) ":$port" else ""
        if (!uri.rawAuthority.equals(expectedAuthority, ignoreCase = true)) return null
        return Origin(scheme, host, port)
    }

    private fun isTrustedHttpHost(host: String): Boolean {
        if (host == "localhost" || host == "::1" || host == "0:0:0:0:0:0:0:1") return true
        if (host.length > ".local".length && host.endsWith(".local")) return true

        val parts = host.split('.')
        if (parts.size != 4) return false
        val octets = parts.map { part ->
            if (part.isEmpty() || (part.length > 1 && part.startsWith('0'))) return false
            part.toIntOrNull()?.takeIf { it in 0..255 } ?: return false
        }
        return octets[0] == 127 ||
            octets[0] == 10 ||
            (octets[0] == 172 && octets[1] in 16..31) ||
            (octets[0] == 192 && octets[1] == 168)
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private data class Origin(val scheme: String, val host: String, val port: Int) {
        val effectivePort: Int get() = if (port >= 0) port else if (scheme == "https") 443 else 80
        val url: String
            get() {
                val renderedHost = if (host.contains(':')) "[$host]" else host
                return "$scheme://$renderedHost${if (port >= 0) ":$port" else ""}"
            }
    }

    private companion object {
        const val PREFS_NAME = "anjian_shell"
        const val PREF_SERVER_ORIGIN = "server_origin"
        const val REQ_FILE_CHOOSER = 1001

        // 与站点的 background_color 一致，冷启动和错误页都不闪白。
        const val BACKGROUND = "#F6F7F8"
        const val TEXT = "#12291F"
        const val TEXT_SECONDARY = "#5A6B62"
    }
}
