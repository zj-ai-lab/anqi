// electron/main.js 之前对 tools/check.sh 零覆盖——顶层 `require('electron')`
// 在裸 node 下会直接抛错（找不到真实 Electron 运行时的 app/BrowserWindow 等
// API），没有任何一步现有自检能碰它。仓库审查记录点名了这一处盲区，尤其是
// (a) startBackend() 产出的 env map 是否真的把 DB_PATH/ANJIAN_FILES_ROOT/
// ANJIAN_AGENT_SESSION_ROOT 三条路径钉死在用户 dataDir 下（这三条只要有一条
// 漏改，对应的数据——数据库/案件夹/AI 助理 session transcript——就会写回
// Contents/Resources/app 这份已签名的 app 资源树本体，反复写入还会撕坏
// codesign --deep 的资源封条），以及 (b) ANJIAN_TEST_USERDATA 的 argv 门是否
// 真的要求 env + switch 同时出现才生效（单独 env 不该重定向 userData）。
//
// electron/backend-env.js 把这两段逻辑抽成不依赖 'electron' 模块的纯函数，
// 这里直接单测，不需要拉起真实 Electron 进程（那部分留给 `run` skill 的手工
// 冒烟——见 docs/CHANGES.md 打包完整性坑记录里的真实 .app 实测）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackendEnv, shouldRedirectTestUserData, TEST_USERDATA_ACK_SWITCH } from '../electron/backend-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ---- buildBackendEnv：三条 dataDir 路径必须真的落在 config.dataDir 下 ----
{
  const config = {
    dataDir: '/Users/test-user/Library/Application Support/anqi',
    user: 'lawyer',
    passHash: 'not-a-real-hash',
  };
  const env = buildBackendEnv({ baseEnv: { PATH: '/usr/bin' }, config, port: 4321, internalKey: 'not-a-real-key' });

  for (const key of ['DB_PATH', 'ANJIAN_FILES_ROOT', 'ANJIAN_AGENT_SESSION_ROOT']) {
    assert.equal(
      env[key]?.startsWith(config.dataDir + path.sep) || env[key] === config.dataDir,
      true,
      `${key} 必须落在 config.dataDir 下，实际是 "${env[key]}"（dataDir="${config.dataDir}"）——` +
      '否则对应数据会写回已签名的 app 资源树本体，而不是用户选的数据目录'
    );
  }
  assert.equal(env.DB_PATH, path.join(config.dataDir, 'anjian.db'));
  assert.equal(env.ANJIAN_FILES_ROOT, path.join(config.dataDir, '案件夹'));
  assert.equal(env.ANJIAN_AGENT_SESSION_ROOT, path.join(config.dataDir, 'agent-sessions'));

  // 三条互不相同——防止将来手滑把其中两个都指向同一个 path.join 调用（复制
  // 粘贴改名忘改参数），那样即使断言"落在 dataDir 下"通过，AI 助理 session
  // transcript 也可能悄悄和案件夹或数据库共用同一个目录。
  const paths = new Set([env.DB_PATH, env.ANJIAN_FILES_ROOT, env.ANJIAN_AGENT_SESSION_ROOT]);
  assert.equal(paths.size, 3, '三条路径必须互不相同');

  assert.equal(env.PORT, '4321');
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.ANJIAN_USER, config.user);
  assert.equal(env.ANJIAN_PASS_HASH, config.passHash);
  assert.equal(env.ANJIAN_INTERNAL_KEY, 'not-a-real-key');
  assert.equal(env.ANJIAN_INTERNAL_KEY_SOURCE, 'electron-auto', '桌面版自动生成的 internal key 必须带这个来源标记，internalAuth() 靠它收窄 /internal 面');
  assert.equal(env.PATH, '/usr/bin', 'baseEnv 必须被展开进结果（宿主 PATH 等继承变量不能丢）');
  assert.equal('DEEPSEEK_API_KEY' in env, false, '未配置 deepseekKey 时不应该凭空出现这个键');

  const envWithKey = buildBackendEnv({
    baseEnv: {}, config: { ...config, deepseekKey: 'sk-not-a-real-key' }, port: 1, internalKey: 'x',
  });
  assert.equal(envWithKey.DEEPSEEK_API_KEY, 'sk-not-a-real-key', '配置了 deepseekKey 时必须透传给子进程');

  console.log('  [1/3] buildBackendEnv()：ok（DB_PATH/ANJIAN_FILES_ROOT/ANJIAN_AGENT_SESSION_ROOT 均在 dataDir 下且互不相同）');
}

// ---- shouldRedirectTestUserData：必须 env + argv 开关同时出现才生效 ----
{
  const hasSwitchTrue = () => true;
  const hasSwitchFalse = () => false;

  assert.equal(
    shouldRedirectTestUserData({}, hasSwitchTrue), false,
    '未设置 ANJIAN_TEST_USERDATA 时，即使 argv 开关存在也不该重定向'
  );
  assert.equal(
    shouldRedirectTestUserData({ ANJIAN_TEST_USERDATA: '/tmp/fake-userdata' }, hasSwitchFalse), false,
    '单独设置 env、没有 argv 开关时绝不能重定向——这正是本仓库审查记录里 F6 的病灶：本地非特权进程能 launchctl setenv 但不能给已安装应用注入 argv'
  );
  assert.equal(
    shouldRedirectTestUserData({ ANJIAN_TEST_USERDATA: '/tmp/fake-userdata' }, hasSwitchTrue), true,
    'env + argv 开关同时出现时才应该重定向'
  );
  assert.equal(
    shouldRedirectTestUserData({ ANJIAN_TEST_USERDATA: '' }, hasSwitchTrue), false,
    '空字符串等价未设置'
  );

  // hasSwitch 必须被问及本模块导出的确切开关名，不是随便什么名字都作数——
  // 防止调用方（main.js）不小心传一个检查错误 switch 名的闭包。
  let queriedName = null;
  shouldRedirectTestUserData({ ANJIAN_TEST_USERDATA: '/tmp/x' }, (name) => { queriedName = name; return true; });
  assert.equal(queriedName, TEST_USERDATA_ACK_SWITCH, `必须查询固定的开关名 "${TEST_USERDATA_ACK_SWITCH}"，实际查询了 "${queriedName}"`);

  console.log('  [2/3] shouldRedirectTestUserData()：ok（env 与 argv 开关必须同时出现，单独 env 不生效）');
}

// ---- server.js 必须真的读 ANJIAN_AGENT_SESSION_ROOT 并传给 AgentSupervisor
//      ----
// 上面两段测的是 electron/main.js 那一侧"产出"这个环境变量；server.js 那一侧
// "消费"它的接线（`sessionRoot: process.env.ANJIAN_AGENT_SESSION_ROOT ||
// undefined`）此前也没有任何测试碰过——server.js 是一个有真实副作用的启动
// 脚本（建 Express app、连接由 DB_PATH 指向的真实 db 文件），仓库里现有测试
// 全部约定成俗地绕开整体 import/fork 它，改测抽出来的独立模块（见
// tools/test-startup-config.js/test-agent-config.js 等）。真正 fork 一次
// server.js 只为了断言这一行，相当于为一行代码新增一整套“真实进程 + 真实
// DB_PATH + 真实登录凭据”的门槛，且仍然测不到"读到的值是否真的传给了
// AgentSupervisor 构造函数"（server.js 不对外暴露这个内部实例）。这里改用
// 对源码做一次机械正则核验：环境变量名与 fallback 写法必须原样都在，字面量
// 改名/拼写错误/丢弃 fallback 都会在这里现形，成本与 tools/test-pack-manifest.js
// 顶部注释里"静态核验优于运行时才现形"是同一个取舍。
{
  const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
  assert.match(
    serverSrc,
    /sessionRoot:\s*process\.env\.ANJIAN_AGENT_SESSION_ROOT\s*\|\|\s*undefined/,
    'server.js 必须把 process.env.ANJIAN_AGENT_SESSION_ROOT（未设置时显式 undefined，让 AgentSupervisor 的构造期默认值接管）' +
    '传给 AgentSupervisor 的 sessionRoot——electron/main.js 的 buildBackendEnv() 只负责产出这个变量，' +
    '真正让它生效的是 server.js 这一侧的消费，两边同一个变量名任何一侧改名/拼错都会让桌面版 session transcript 静默写回 app 资源树本体'
  );
  console.log('  [3/3] server.js 消费 ANJIAN_AGENT_SESSION_ROOT 的接线：ok（变量名与 fallback 写法均未漂移）');
}

console.log('electron backend-env 自检全部通过');
