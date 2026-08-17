// 自动更新：通过 GitHub provider 读取 zj-ai-lab/anqi 的 latest-mac.yml → 有新版弹原生 dialog → 打开浏览器下载 DMG。
//
// 只在打包后运行（app.isPackaged）；dev 模式跳过。
//
// 为什么不用 autoUpdater.downloadUpdate() 静默更新（MVP 阶段两个硬阻塞）：
//   1. 未签名 app 在 macOS 上会被 Squirrel.Mac/Gatekeeper 拒绝安装更新；
//   2. electron-updater 在 macOS 下载更新要求 zip target，目前只发 dmg，
//      downloadUpdate() 必报 "ZIP file not provided"——用户点了下载却毫无反应。
// 所以现在走「提示 → 浏览器下载对应架构 DMG → 手动覆盖安装」。
// 签名（Developer ID + 公证）落地后：package.json mac.target 加 zip，这里换回 downloadUpdate()。
const { autoUpdater } = require('electron-updater');
const { dialog, shell } = require('electron');

const RELEASE_URL = 'https://github.com/zj-ai-lab/anqi/releases/latest';
const DOWNLOAD_BASE = `${RELEASE_URL}/download/`;

let started = false;

// latest-mac.yml 的 files[].url 形如 anqi-2.6.0-arm64.dmg。
// 挑当前架构的 dmg；挑不到退回第一个 dmg，再退回 Release 页面。
function dmgUrlFor(info) {
  const files = info?.files || [];
  const dmgs = files.filter((file) => file.url && file.url.endsWith('.dmg'));
  const match = dmgs.find((file) => file.url.includes(process.arch)) || dmgs[0];
  return match ? new URL(match.url, DOWNLOAD_BASE).toString() : RELEASE_URL;
}

function initAutoUpdater(mainWindow) {
  if (started || !require('electron').app.isPackaged) return;
  started = true;

  // 日志：更新事件写到 console（打包后进 userData/logs）
  autoUpdater.logger = console;
  autoUpdater.autoDownload = false; // 只借 checkForUpdates 读 latest-mac.yml，不走内置下载

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `案齐 ${info.version} 已发布`,
      detail: '将在浏览器中下载新版安装包（DMG）。\n下载完成后打开它，把新版拖进「应用程序」覆盖旧版即可；你的数据在自选的数据目录里，不受影响。',
      buttons: ['去下载', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) shell.openExternal(dmgUrlFor(info));
    });
  });

  autoUpdater.on('update-not-available', () => {
    // 静默——当前就是最新版，不打扰用户
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err?.message || err);
  });

  // 启动后 10 秒检查（给后端启动和窗口加载让路）
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      console.error('[updater] check failed:', e?.message || e);
    });
  }, 10000);
}

module.exports = { initAutoUpdater };
