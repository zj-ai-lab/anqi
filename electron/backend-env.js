// 从 electron/main.js 抽出的两段纯逻辑（不 require('electron')，可以在裸 node
// 进程里直接单测）——main.js 本身因为顶层 `require('electron')` 在非 Electron
// 运行时会直接崩，`tools/check.sh` 此前对 electron/main.js 完全零覆盖（见
// 仓库审查记录）。这里只搬运逻辑本身，不改变任何行为：main.js 继续在真实
// Electron 环境里调用这两个函数，唯一区别是逻辑现在能被 tools/test-electron-backend-env.js
// 在裸 node 下直接断言。
'use strict';

const path = require('node:path');

// ── 案件文件夹位置（ANJIAN_FILES_ROOT）──────────────────────────────
// 默认是 <dataDir>/案件夹。用户可以在菜单「案件文件夹位置…」里把它整体指到
// 电脑上已有的案卷总文件夹（config.filesRoot，绝对路径）。只换「根」的位置：
// 「一个案件 = 根下面的一个子文件夹」这条不变，后端与 AI 助理沙箱的目录边界
// （案件夹必须在文件根之内）原样成立。
const DEFAULT_FILES_DIR_NAME = '案件夹';

function defaultFilesRoot(config) {
  return path.join(config.dataDir, DEFAULT_FILES_DIR_NAME);
}

// config.filesRoot 缺省、为空或不是绝对路径（手改坏了）时一律回到默认位置，
// 绝不把相对路径交给后端——那会解析到后端 cwd，也就是 app 资源树本体。
function filesRootFor(config) {
  const custom = typeof config.filesRoot === 'string' ? config.filesRoot.trim() : '';
  return custom && path.isAbsolute(custom) ? path.resolve(custom) : defaultFilesRoot(config);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// 用户在系统文件夹选择器里选了一个位置之后的把关。入参都应是已解析过符号链接的
// 绝对路径（main.js 负责 realpath）。返回 null 表示可以用，否则返回给人看的原因。
function filesRootProblem({ picked, dataDir, homeDir, appRoot }) {
  if (typeof picked !== 'string' || !path.isAbsolute(picked)) return '请选择一个文件夹。';
  const target = path.resolve(picked);
  const data = path.resolve(dataDir);
  if (target === defaultFilesRoot({ dataDir: data })) return null;
  if (target === path.parse(target).root) return '不能把整块磁盘当作案件文件夹的位置。';
  if (homeDir && isInside(target, path.resolve(homeDir))) {
    return '不能选个人文件夹本身或它的上级——那样文稿、下载等都会被当成案件夹。请选一个专门放案卷的文件夹。';
  }
  if (isInside(target, data)) {
    return '这个位置里包含案齐的数据目录（数据库就在里面），不能当作案件文件夹的位置。请选一个专门放案卷的文件夹。';
  }
  if (isInside(data, target)) {
    return '不能选案齐数据目录里的其他文件夹。';
  }
  if (appRoot && (isInside(path.resolve(appRoot), target) || isInside(target, path.resolve(appRoot)))) {
    return '不能选案齐程序自身所在的位置。';
  }
  return null;
}

// startBackend() 喂给 fork(server.js) 子进程的完整 env——DB_PATH 与
// ANJIAN_AGENT_SESSION_ROOT 必须落在用户 dataDir 下；ANJIAN_FILES_ROOT 默认也在
// dataDir 下，用户改过位置时取 filesRootFor() 的结果（已保证是绝对路径）。
// 三条路径全部在这里拼接，同一处遗漏会让数据库、案件夹和 AI 助理 session
// transcript 三者中的任意一个写回已签名的 app 资源树本体而不是用户数据
// 目录（这正是本仓库审查记录里 F1 阻断的病灶之一）。
function buildBackendEnv({ baseEnv, config, port, internalKey }) {
  return {
    ...baseEnv,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1', // 桌面版后端固定只听本机；Dockerfile 另行显式设为 0.0.0.0
    DB_PATH: path.join(config.dataDir, 'anjian.db'),
    ANJIAN_FILES_ROOT: filesRootFor(config),
    // 让页面知道自己跑在桌面版里：案件工作区选择器据此提示「位置可在菜单里更改」。
    // 只是一个布尔标记，不向页面暴露任何本机绝对路径。
    ANJIAN_DESKTOP: '1',
    ANJIAN_AGENT_SESSION_ROOT: path.join(config.dataDir, 'agent-sessions'),
    ANJIAN_USER: config.user,
    ANJIAN_PASS_HASH: config.passHash,
    ANJIAN_INTERNAL_KEY: internalKey,
    // 标记这份 key 是本进程自动生成、不是用户显式配置——src/middleware/auth.js
    // 的 internalAuth() 看到这个标记时，把这份随机 key 能打开的 /internal 面
    // 收窄到 AI 助理自己需要的几个端点，不因为桌面版每次启动都要有这份 key
    // 才能跑 AI 助理，就顺带打开整套面向外部自动化的 /internal 读面。
    ANJIAN_INTERNAL_KEY_SOURCE: 'electron-auto',
    ...(config.deepseekKey ? { DEEPSEEK_API_KEY: config.deepseekKey } : {}),
  };
}

// 见 electron/main.js 顶部大段注释：单独一个 ANJIAN_TEST_USERDATA 环境变量不
// 够——任何本地非特权进程都能 `launchctl setenv` 把它注入到之后启动的任意
// GUI 应用，等于给了本机任意进程一个不需要提权就能重定向 userData（存
// config.json 的 passHash 与 dataDir）的开关。这里要求同时出现一个只能通过
// 启动这个进程时的 argv 传入的 command-line switch，`hasSwitch` 由调用方注入
// （真实 Electron 环境传 `app.commandLine.hasSwitch`），保持这段判断本身与
// Electron 运行时解耦、可单测。
const TEST_USERDATA_ACK_SWITCH = 'anjian-test-userdata-ack';

function shouldRedirectTestUserData(env, hasSwitch) {
  return Boolean(env.ANJIAN_TEST_USERDATA) && Boolean(hasSwitch(TEST_USERDATA_ACK_SWITCH));
}

module.exports = {
  buildBackendEnv,
  defaultFilesRoot,
  filesRootFor,
  filesRootProblem,
  shouldRedirectTestUserData,
  TEST_USERDATA_ACK_SWITCH,
};
