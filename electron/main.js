// Electron 主进程：把现有 Express + better-sqlite3 后端包成桌面 App，后端代码零改动。
//
// 进程模型：主进程 fork 一个 Node 子进程跑 server.js（监听 OS 分配的随机端口），
// 主窗口 loadURL('http://127.0.0.1:<port>')。后端生命周期与 renderer 解耦，崩溃隔离。
//
// 首启检测：读 userData/config.json
//   未配置 → 引导窗口（选数据目录 / 设密码 / 可选填 API key）→ 写 config.json → 启动
//   已配置 → 注入 env → fork server.js → 健康检查 → 主窗口
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const http = require('node:http');
const { initAutoUpdater } = require('./updater');

// dev 环境（未签名）禁用 sandbox，避免 macOS "Operation not permitted" 刷屏。
// 打包发版后走正规签名 + sandbox；dev 只是绕过本机权限限制。
if (!app.isPackaged) app.commandLine.appendSwitch('no-sandbox');

const IS_DEV = !app.isPackaged;
// 打包后 server.js 在 app.asar.unpacked 里（better-sqlite3 是原生模块，不能进 asar）
const APP_ROOT = IS_DEV
  ? path.resolve(__dirname, '..')
  : path.join(process.resourcesPath, 'app');

let mainWindow = null;
let backendProc = null;

// ── 配置读写（userData/config.json）─────────────────────────────────
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

// ── 选一个空闲端口 ──────────────────────────────────────────────────
// 不用 PORT=0：server.js 打印的是 env PORT 而非 server.address().port，
// PORT=0 时会打印 ":0" 导致主进程拿不到真实端口。预选一个空闲端口传进去即可（后端零改动）。
const net = require('node:net');
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ── fork 后端子进程 ─────────────────────────────────────────────────
// server.js 监听 PORT，stdout 会打印 "anjian listening on :<port>"。
async function startBackend(config) {
  const port = await pickFreePort();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',   // 桌面版后端固定只听本机；Dockerfile 另行显式设为 0.0.0.0
    DB_PATH: path.join(config.dataDir, 'anjian.db'),
    ANJIAN_FILES_ROOT: path.join(config.dataDir, '案件夹'),
    ANJIAN_USER: config.user,
    ANJIAN_PASS_HASH: config.passHash,
    ...(config.deepseekKey ? { DEEPSEEK_API_KEY: config.deepseekKey } : {}),
  };

  return new Promise((resolve, reject) => {
    const proc = fork(path.join(APP_ROOT, 'server.js'), [], {
      env,
      cwd: APP_ROOT,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: IS_DEV ? ['--env-file=' + path.join(APP_ROOT, '.env')] : [],
    });
    backendProc = proc;

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (IS_DEV) process.stdout.write(text);
    });
    proc.stderr.on('data', (chunk) => {
      process.stderr.write(`[backend] ${chunk}`);
    });
    proc.on('exit', (code) => {
      if (backendProc === proc) backendProc = null;
      reject(new Error(`后端退出（code ${code}）`));
    });

    // 轮询 /healthz 直到就绪（最多等 15 秒——首启要跑 migration + 节假日装载）
    const waitReady = async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await healthzOk(port)) return resolve(port);
        await sleep(300);
      }
      reject(new Error('后端健康检查超时（15s）'));
    };
    waitReady().catch(reject);
  });
}

function healthzOk(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 主窗口 ──────────────────────────────────────────────────────────
function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 390,
    title: '案齐',
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hiddenInset',
    }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // ── 给 macOS 红绿灯让位（只住 Electron 侧，网页版一像素不动）────────────
  // titleBarStyle:'hiddenInset' 让网页内容顶到 y=0，而 nav.js 注入的 .topnav 也是
  // sticky top:0——结果红绿灯直接压在「案齐」logo 上。这里用 insertCSS 把顶栏左推 80px，
  // 并把顶栏空白处设为可拖拽窗口（交互元素逐类排除，否则点不动导航/按钮/下拉/输入框）。
  //
  // 🔴 必须每次 dom-ready 重注入：本应用是多页站（今日/案件/日历/费用…都是整页加载），
  // insertCSS 的作用域是当前文档，只注一次的话点一下导航样式就没了。
  // 补丁刻意不进 public/css/style.css——那会让浏览器访问的网页版也多出 80px 左边距。
  if (process.platform === 'darwin') {
    // !important 是必须的：style.css 的 `.topnav{padding: 0 var(--page-pad)}` 是**简写**，
    // 与注入规则同特异性（0,1,0），简写会把 padding-left 一并重置——实测不加就完全不生效。
    const TRAFFIC_LIGHT_CSS = '.topnav{padding-left:80px!important;-webkit-app-region:drag}'
      + '.topnav a,.topnav button,.topnav select,.topnav input{-webkit-app-region:no-drag}';
    mainWindow.webContents.on('dom-ready', () => {
      mainWindow.webContents.insertCSS(TRAFFIC_LIGHT_CSS);
    });
  }

  // 外链在系统浏览器打开，不抢 App 内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // 打包后启动自动更新检查（dev 跳过）
  initAutoUpdater(mainWindow);
}

// ── 引导窗口 ────────────────────────────────────────────────────────
function createOnboardingWindow() {
  onboardingWin = new BrowserWindow({
    width: 560,
    height: 620,
    resizable: false,
    title: '案齐 · 初始设置',
    minimizable: false,
    maximizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  onboardingWin.loadFile(path.join(__dirname, 'onboarding.html'));
  onboardingWin.on('closed', () => {
    onboardingWin = null;
    // 引导没完成就关窗 = 放弃启动
    if (!readConfig()) app.quit();
  });
  return onboardingWin;
}

// ── IPC：引导页调用 ────────────────────────────────────────────────
// 选数据目录（原生文件夹选择器，renderer 无权直接调）
const DATA_DIR_NAME = '案齐数据';

ipcMain.handle('onboarding:chooseDir', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: path.join(app.getPath('home'), 'Documents', DATA_DIR_NAME),
  });
  if (result.canceled) return null;
  const picked = result.filePaths[0];
  // 永远在用户选的位置下面**建一个子目录**再放数据——用户选「桌面」时，
  // anjian.db 和「案件夹」不能平铺到桌面上。已经选中同名目录（含默认路径）则不再套娃。
  return path.basename(picked) === DATA_DIR_NAME ? picked : path.join(picked, DATA_DIR_NAME);
});

// 共享纯密码模块，不 import 后端——避免级联 import db.js 在引导阶段就连库。
const { hashPassword } = require('../src/lib/password-hash.cjs');
ipcMain.handle('onboarding:hash', (_evt, password) => {
  return hashPassword(password);
});

// 保存配置并完成引导：写 config → 启动后端 → 开主窗口 → 关引导窗
let onboardingWin = null;
ipcMain.handle('onboarding:complete', async (_evt, config) => {
  // 数据目录多半是上一步现拼出来的子目录，还不存在——先建出来，
  // 否则后端连库就会在 ENOENT 上失败。（用户手输路径的情况也一并兜住。）
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
  } catch (e) {
    dialog.showErrorBox('无法创建数据目录', `${config.dataDir}\n\n${e.message || e}`);
    return false;
  }
  writeConfig(config);
  try {
    const port = await startBackend(config);
    createMainWindow(port);
    if (onboardingWin && !onboardingWin.isDestroyed()) onboardingWin.close();
    return true;
  } catch (e) {
    dialog.showErrorBox('案齐启动失败', e.message || String(e));
    app.quit();
    return false;
  }
});

// ── App 生命周期 ────────────────────────────────────────────────────
// 单实例锁：防止多开导致端口/数据竞争
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const config = readConfig();
    if (!config) {
      createOnboardingWindow();
    } else {
      try {
        const port = await startBackend(config);
        createMainWindow(port);
      } catch (e) {
        dialog.showErrorBox('案齐启动失败', e.message || String(e));
        app.quit();
      }
    }
  });

  // macOS 下关掉所有窗口不退出（dock 常驻）；其它平台退出
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const config = readConfig();
      if (config) {
        startBackend(config).then(createMainWindow).catch((e) => {
          dialog.showErrorBox('案齐启动失败', e.message);
          app.quit();
        });
      } else {
        createOnboardingWindow();
      }
    }
  });

  // 退出时 kill 后端子进程（否则成为孤儿进程占着端口）
  app.on('before-quit', () => {
    if (backendProc) {
      backendProc.kill();
      backendProc = null;
    }
  });
}
