// Electron 主进程：把现有 Express + better-sqlite3 后端包成桌面 App，后端代码零改动。
//
// 进程模型：主进程 fork 一个 Node 子进程跑 server.js（监听 OS 分配的随机端口），
// 主窗口 loadURL('http://127.0.0.1:<port>')。后端生命周期与 renderer 解耦，崩溃隔离。
//
// 首启检测：读 userData/config.json
//   未配置 → 引导窗口（选数据目录 / 设密码 / 可选填 API key）→ 写 config.json → 启动
//   已配置 → 注入 env → fork server.js → 健康检查 → 主窗口
const { app, BrowserWindow, Menu, MenuItem, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const http = require('node:http');
const { initAutoUpdater } = require('./updater');
const {
  buildBackendEnv, defaultFilesRoot, filesRootFor, filesRootProblem, shouldRedirectTestUserData,
} = require('./backend-env');
const { shouldPreventClose } = require('./window-policy');

// dev 环境（未签名）禁用 sandbox，避免 macOS "Operation not permitted" 刷屏。
// 打包发版后走正规签名 + sandbox；dev 只是绕过本机权限限制。
if (!app.isPackaged) app.commandLine.appendSwitch('no-sandbox');

// 仅测试用 userData 隔离开关：打包冒烟需要验证「默认 disabled / 引导流程 / 首启」
// 等行为，但绝不能碰开发者本机真实的 userData/config.json 与其指向的真实数据目录
// （里面可能是真实案件夹）。ANJIAN_TEST_USERDATA 未设置时行为与此前完全一致
// （app.getPath('userData') 走 Electron 默认规则）；只有显式设置这个环境变量、
// 指向一个调用方自建的临时目录时，才会覆盖 userData 路径——必须在 app 触碰任何
// 路径之前调用 app.setPath('userData', ...)，所以紧跟在文件顶部。
//
// 单独一个环境变量不够：任何本地非特权进程都能
// `launchctl setenv ANJIAN_TEST_USERDATA <攻击者选定的路径>`，且对之后启动的
// 全部 GUI 应用生效（不需要提权）——生产 DMG 若只认这一个变量，等于给了本机
// 任意进程一个不需要提权就能重定向 config.json（存 passHash 与 dataDir）读取
// 位置的开关：攻击者可以预置自己已知的凭据，再拿受害者真实 dataDir 去打回环
// API。command-line switch 不存在这个问题——Chromium/Electron 的命令行参数
// 只能通过启动这个进程时的 argv 传入，`launchctl setenv` 只影响环境变量继承，
// 不能给已安装应用的后续启动注入 argv（不经过修改 .app 本体或改变启动方式）。
// 这里要求两者同时出现才生效：env 变量给出目标路径，argv 开关充当"这次启动
// 确实是调用方主动构造的测试调用"的凭证，环境变量单独出现时静默忽略（保留
// 默认行为，不报错——沿用之前"未设置等价不生效"的调用惯例，只是把触发条件
// 从"设置了这一个变量"收紧成"两者都在"）。判断逻辑本身抽到 ./backend-env.js
// （不 require('electron')，可以在裸 node 下单测——见
// tools/test-electron-backend-env.js），这里只是把真实的 app.commandLine.hasSwitch
// 接进去。
if (shouldRedirectTestUserData(process.env, (name) => app.commandLine.hasSwitch(name))) {
  app.setPath('userData', process.env.ANJIAN_TEST_USERDATA);
}

const IS_DEV = !app.isPackaged;
// 打包后 server.js 在 app.asar.unpacked 里（better-sqlite3 是原生模块，不能进 asar）
const APP_ROOT = IS_DEV
  ? path.resolve(__dirname, '..')
  : path.join(process.resourcesPath, 'app');

let mainWindow = null;
let backendProc = null;
let quitting = false;

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
  // AI 助理 sidecar（agent_enabled=true 时）的 DSH 子进程要靠 X-Anjian-Key
  // 回调 /internal/agent-proposals；DESIGN.md 原先「Electron 显式回环并带账
  // 号/hash，可不启用 internal 面」的前提是没有任何东西需要走 /internal——
  // sidecar 落地后这个前提不再成立，桌面版必须也配一份 ANJIAN_INTERNAL_KEY，
  // 否则 supervisor.start() 会在 internal_key_missing 上直接短路，AI 助理在
  // 桌面版永远起不来。这里每次启动随机生成一份，只活在这一次后端子进程的
  // env 里，不写 config.json/磁盘、不持久化——重启即换新值，不需要用户感知。
  const internalKey = crypto.randomBytes(32).toString('hex');
  // env 的具体拼接（含 DB_PATH/ANJIAN_FILES_ROOT/ANJIAN_AGENT_SESSION_ROOT 这
  // 三条必须落在用户 dataDir 下的路径——AI 助理 session transcript 那一条同
  // DB_PATH 是同一个模式：src/agent/supervisor.js 的默认值是 __dirname 相对
  // 路径，打包后会解析进 Contents/Resources/app 这份已签名的 app 资源树本体，
  // 而不是用户的 dataDir）抽到 ./backend-env.js，逻辑本身不 require('electron')，
  // 可以在裸 node 下直接单测（tools/test-electron-backend-env.js）——这里只是
  // 传入真实的 process.env/config/port/internalKey。
  const env = buildBackendEnv({ baseEnv: process.env, config, port, internalKey });

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

// 结束当前后端子进程并等它真的退出（改案件文件夹位置时要换一套 env 重启）。
function stopBackend() {
  return new Promise((resolve) => {
    const proc = backendProc;
    if (!proc) return resolve();
    // 正常是 SIGTERM 后几百毫秒内退出；5 秒还没退就强杀，绝不让新旧两个后端同时开着同一个库。
    const timer = setTimeout(() => { proc.kill('SIGKILL'); }, 5000);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    proc.kill();
  });
}

async function showBackend(config) {
  const port = await startBackend(config);
  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
    mainWindow.show();
  } else {
    createMainWindow(port);
  }
}

// ── 案件文件夹位置（菜单「案件文件夹位置…」）────────────────────────────
// 只换文件根的位置，不搬任何文件；「一个案件 = 根下面的一个子文件夹」不变。
// 位置把关在 ./backend-env.js 的 filesRootProblem()（可单测）；这里只负责原生
// 对话框、写 config.json 和按新 env 重启后端。新位置起不来就原样退回旧位置。
let changingFilesRoot = false;

function realPathOrNull(target) {
  try { return fs.realpathSync.native(target); } catch { return null; }
}

async function chooseFilesRoot() {
  if (changingFilesRoot) return;
  const config = readConfig();
  if (!config || !backendProc) return; // 首次引导还没完成，没有可改的位置
  changingFilesRoot = true;
  try {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const ask = (options) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    const current = filesRootFor(config);
    const fallback = defaultFilesRoot(config);
    const isCustom = current !== fallback;
    const buttons = isCustom ? ['选择文件夹…', '恢复默认位置', '取消'] : ['选择文件夹…', '取消'];
    const entry = await ask({
      type: 'info',
      message: '案件文件夹位置',
      detail: `现在：${current}\n\n案齐在这个文件夹下面为每个案件对应一个子文件夹。`
        + '如果你已经有一套案卷文件夹，可以把位置改到它们所在的上一级文件夹，之后在案件里直接选用已有文件夹。',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
    });
    if (entry.response === buttons.length - 1) return;

    let target = fallback;
    if (entry.response === 0) {
      const options = {
        title: '选择放案卷的文件夹',
        defaultPath: current,
        properties: ['openDirectory', 'createDirectory'],
      };
      const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || !picked.filePaths.length) return;
      target = realPathOrNull(picked.filePaths[0]);
      const problem = target === null
        ? '这个文件夹打不开，请换一个。'
        : filesRootProblem({
          picked: target,
          dataDir: realPathOrNull(config.dataDir) || config.dataDir,
          homeDir: realPathOrNull(app.getPath('home')) || app.getPath('home'),
          appRoot: realPathOrNull(APP_ROOT) || APP_ROOT,
        });
      if (problem) {
        await ask({ type: 'warning', message: '不能用这个位置', detail: problem, buttons: ['好'] });
        return;
      }
    }
    if (target === current) return;

    const confirmed = await ask({
      type: 'question',
      message: '更改案件文件夹位置？',
      detail: `新位置：${target}\n\n`
        + '· 案齐不会移动、复制或删除任何文件。\n'
        + '· 已有案件会按文件夹名到新位置下找同名文件夹；找不到的，案件文件页会提示重新选择。\n'
        + '· 案齐后台会重启一次，正在进行的 AI 助理对话会中断。',
      buttons: ['更改并重启', '取消'],
      defaultId: 0,
      cancelId: 1,
    });
    if (confirmed.response !== 0) return;

    const nextConfig = { ...config };
    if (target === fallback) delete nextConfig.filesRoot; else nextConfig.filesRoot = target;
    await stopBackend();
    try {
      writeConfig(nextConfig);
      await showBackend(nextConfig);
    } catch (error) {
      writeConfig(config);
      await stopBackend();
      try {
        await showBackend(config);
      } catch (restoreError) {
        dialog.showErrorBox('案齐启动失败', restoreError.message || String(restoreError));
        app.quit();
        return;
      }
      dialog.showErrorBox('没能更改案件文件夹位置', `已恢复原来的位置。\n\n${error.message || error}`);
    }
  } finally {
    changingFilesRoot = false;
  }
}

// 在 Electron 默认菜单的第一个菜单（macOS 是「案齐」应用菜单）里加一项，其余菜单原样保留。
function installFilesRootMenu() {
  const item = { label: '案件文件夹位置…', click: () => { chooseFilesRoot(); } };
  const menu = Menu.getApplicationMenu();
  const host = menu?.items?.[0]?.submenu;
  if (!host) {
    // 默认菜单拿不到时（理论上不会发生）自己搭一份最小菜单，保证入口一定存在。
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [item, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));
    return;
  }
  host.insert(1, new MenuItem({ type: 'separator' }));
  host.insert(2, new MenuItem(item));
  Menu.setApplicationMenu(menu);
}

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
  mainWindow.on('close', (event) => {
    if (shouldPreventClose(process.platform, quitting)) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

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
    installFilesRootMenu();
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
    if (mainWindow && process.platform === 'darwin') {
      mainWindow.show();
    } else if (BrowserWindow.getAllWindows().length === 0) {
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
    quitting = true;
    if (backendProc) {
      backendProc.kill();
      backendProc = null;
    }
  });
}
