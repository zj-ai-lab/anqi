// 从 electron/main.js 抽出的两段纯逻辑（不 require('electron')，可以在裸 node
// 进程里直接单测）——main.js 本身因为顶层 `require('electron')` 在非 Electron
// 运行时会直接崩，`tools/check.sh` 此前对 electron/main.js 完全零覆盖（见
// 仓库审查记录）。这里只搬运逻辑本身，不改变任何行为：main.js 继续在真实
// Electron 环境里调用这两个函数，唯一区别是逻辑现在能被 tools/test-electron-backend-env.js
// 在裸 node 下直接断言。
'use strict';

const path = require('node:path');

// startBackend() 喂给 fork(server.js) 子进程的完整 env——桌面版三条"必须落在
// 用户 dataDir 下"的路径（DB_PATH、ANJIAN_FILES_ROOT、ANJIAN_AGENT_SESSION_ROOT）
// 全部在这里拼接，同一处遗漏会同时影响数据库、案件夹和 AI 助理 session
// transcript 三者中的任意一个都可能写回已签名的 app 资源树本体而不是用户数据
// 目录（这正是本仓库审查记录里 F1 阻断的病灶之一）。
function buildBackendEnv({ baseEnv, config, port, internalKey }) {
  return {
    ...baseEnv,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1', // 桌面版后端固定只听本机；Dockerfile 另行显式设为 0.0.0.0
    DB_PATH: path.join(config.dataDir, 'anjian.db'),
    ANJIAN_FILES_ROOT: path.join(config.dataDir, '案件夹'),
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

module.exports = { buildBackendEnv, shouldRedirectTestUserData, TEST_USERDATA_ACK_SWITCH };
