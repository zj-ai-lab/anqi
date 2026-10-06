import AppKit
import WebKit

@MainActor final class Launcher: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private var status: NSTextField!
    private let root: URL
    private var allowedOrigin: String = ""
    private var launcherProcess: Process?
    init(root: URL) { self.root = root; super.init() }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu=NSMenu(); let appMenu=NSMenu(); let rootItem=NSMenuItem(); rootItem.submenu=appMenu; menu.addItem(rootItem)
        appMenu.addItem(withTitle:"重新打开案齐", action:#selector(reloadApp), keyEquivalent:"r").target=self
        appMenu.addItem(NSMenuItem.separator());appMenu.addItem(withTitle:"退出启动器", action:#selector(NSApplication.terminate(_:)), keyEquivalent:"q")
        NSApp.mainMenu=menu
        window=NSWindow(contentRect:NSRect(x:0,y:0,width:1280,height:850),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title="案齐 · 本地版";window.center();window.minSize=NSSize(width:420,height:540)
        let config=WKWebViewConfiguration(); config.websiteDataStore = .default()
        web=WKWebView(frame:window.contentView!.bounds,configuration:config); web.autoresizingMask=[.width,.height];web.navigationDelegate=self;web.uiDelegate=self
        window.contentView!.addSubview(web)
        status=NSTextField(labelWithString:"正在检查案齐服务并创建启动前备份…");status.frame=NSRect(x:32,y:400,width:1000,height:50);status.font=NSFont.systemFont(ofSize:18);status.autoresizingMask=[.width];window.contentView!.addSubview(status)
        window.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true); start()
    }
    private func start() {
        if launcherProcess?.isRunning == true { return }
        let task=Process();launcherProcess=task;task.executableURL=URL(fileURLWithPath:"/usr/bin/python3");task.arguments=[root.appendingPathComponent("tools/desktop-start.py").path];task.currentDirectoryURL=root
        let output=Pipe(), errors=Pipe();task.standardOutput=output;task.standardError=errors
        task.terminationHandler={ [weak self] process in
            let data=output.fileHandleForReading.readDataToEndOfFile();let err=errors.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async { [weak self] in
                guard let self else{return}
                self.launcherProcess=nil
                guard process.terminationStatus==0,
                      let result=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
                      let file=result["runtime_file"] as? String,
                      let runtimeData=try? Data(contentsOf:URL(fileURLWithPath:file)),
                      let runtime=(try? JSONSerialization.jsonObject(with:runtimeData)) as? [String:String],
                      let address=runtime["url"],let url=URL(string:address),url.host=="127.0.0.1",
                      let token=runtime["token"],
                      let cookie=HTTPCookie(properties:[.domain:"127.0.0.1",.path:"/",.name:"anjian_token",.value:token,.expires:Date().addingTimeInterval(86400),HTTPCookiePropertyKey("HttpOnly"):"TRUE"]) else {
                    self.status.stringValue="案齐启动失败："+(String(data:err,encoding:.utf8) ?? "请查看启动日志");return
                }
                self.allowedOrigin="http://127.0.0.1:"+(url.port.map(String.init) ?? "80")
                self.web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
                    DispatchQueue.main.async { self?.status.isHidden=true;self?.web.load(URLRequest(url:url)) }
                }
            }
        }
        do {try task.run()}catch {status.stringValue="启动器无法运行：\(error.localizedDescription)"}
    }
    @objc private func reloadApp(){start()}
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool)->Bool {window.makeKeyAndOrderFront(nil);if web.url==nil {start()};return true}
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool {true}
    private func localDialog(_ frame:WKFrameInfo)->Bool {
        let origin=frame.securityOrigin
        return frame.isMainFrame && origin.protocol+"://"+origin.host+":"+String(origin.port)==allowedOrigin
    }
    func webView(_ webView:WKWebView,runJavaScriptConfirmPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(Bool)->Void){
        guard localDialog(frame) else{completionHandler(false);return}
        let alert=NSAlert();alert.messageText="案齐操作确认";alert.informativeText=message
        alert.addButton(withTitle:"确认");alert.addButton(withTitle:"取消")
        alert.beginSheetModal(for:window){response in completionHandler(response == .alertFirstButtonReturn)}
    }
    func webView(_ webView:WKWebView,runJavaScriptAlertPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping()->Void){
        guard localDialog(frame) else{completionHandler();return}
        let alert=NSAlert();alert.messageText="案齐";alert.informativeText=message;alert.addButton(withTitle:"知道了")
        alert.beginSheetModal(for:window){_ in completionHandler()}
    }
    func webView(_ webView:WKWebView,runJavaScriptTextInputPanelWithPrompt prompt:String,defaultText:String?,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(String?)->Void){
        guard localDialog(frame) else{completionHandler(nil);return}
        let alert=NSAlert();alert.messageText="案齐";alert.informativeText=prompt
        let input=NSTextField(frame:NSRect(x:0,y:0,width:400,height:28));input.stringValue=defaultText ?? "";alert.accessoryView=input
        alert.addButton(withTitle:"确认");alert.addButton(withTitle:"取消")
        alert.beginSheetModal(for:window){response in completionHandler(response == .alertFirstButtonReturn ? input.stringValue:nil)}
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard localDialog(frame) else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
    func webView(_ webView:WKWebView, decidePolicyFor navigationAction:WKNavigationAction, decisionHandler:@escaping(WKNavigationActionPolicy)->Void){
        guard let url=navigationAction.request.url else{decisionHandler(.cancel);return}
        if url.scheme=="about" {decisionHandler(.allow);return}
        let origin=(url.scheme ?? "")+"://"+(url.host ?? "")+":"+String(url.port ?? (url.scheme=="https" ? 443:80))
        if origin==allowedOrigin{decisionHandler(.allow)}else {if ["https","http"].contains(url.scheme ?? ""){NSWorkspace.shared.open(url)};decisionHandler(.cancel)}
    }
    func webView(_ webView:WKWebView,createWebViewWith configuration:WKWebViewConfiguration,for navigationAction:WKNavigationAction,windowFeatures:WKWindowFeatures)->WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        let origin = (url.scheme ?? "") + "://" + (url.host ?? "") + ":" + String(url.port ?? (url.scheme == "https" ? 443 : 80))
        if origin == allowedOrigin {
            // Keep local authentication in this webview; an external redirect is
            // opened by the navigation delegate without exporting the local cookie.
            webView.load(navigationAction.request)
        } else if ["https", "http"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}
@main struct Main {
    @MainActor static func main() {
        let app=NSApplication.shared
        guard let root=Bundle.main.resourceURL?.appendingPathComponent("runtime") else{fatalError("缺少运行程序")}
        let launcher=Launcher(root:root)
        app.setActivationPolicy(.regular);app.delegate=launcher;withExtendedLifetime(launcher) { app.run() }
    }
}
