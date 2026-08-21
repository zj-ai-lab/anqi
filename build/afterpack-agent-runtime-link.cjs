// electron-builder afterPack 钩子：在 afterSign 的 ad-hoc 深度重签之前，把
// agent-runtime/assets/node_modules 这条指向 agent-runtime/runtime/node_modules
// 的符号链接直接建在打包产物里。
//
// 背景：package.json 的 build.extraResources 把 src/agent/runtime 与
// src/agent/assets 复制进同一个父目录 Contents/Resources/agent-runtime/
// {runtime,assets}/，但 filter 显式排除了 assets/node_modules（见
// package.json 里那条 "!assets/node_modules{,/**/*}"）——不排除的话，因为
// dev 仓库里这一条是 src/agent/supervisor.js 的 ensureAssetsNodeModulesLink()
// 在每次 start() 时才运行时创建的符号链接，electron-builder 的拷贝对"源
// 目录里可能压根不存在，或存在但指向仓库以外目标"的悬空链接处理不可靠。
//
// 之前的实现让 supervisor.js 在打包模式下也照样在每次 start() 前"运行时
// 确保"这条链接——问题是打包模式下 ASSETS_DIR 指向的是已签名 app 资源树的
// 一部分：build/adhoc-sign.cjs 的 afterSign 钩子会用 `codesign --deep --sign -`
// 把当时目录树的全部内容签名封存，运行时再写入/改动这份资源会撕开
// `codesign --verify --deep --strict` 的资源封条（"a sealed resource is
// missing or invalid"）——真实复现：打包冒烟第一次跑 AI 助理之后，重新校验
// 签名当场报这个错，且案件夹绝对路径（含当事人姓名）作为 session 目录名
// 也顺带写进了发行包本体（session root 路径问题另在 server.js/
// electron/main.js 修复，与这里的符号链接是两个独立坑）。
//
// 现在改成在这里（afterPack，还没签名）创建这条链接：紧接着的 afterSign
// 会把这条链接一起纳入签名，运行时（supervisor.js 的
// ensureAssetsNodeModulesLink()）在打包模式下就只需要只读校验，不需要再写
// 入已签名资源——见该函数里 AGENT_DIR_IS_PACKAGED 分支的注释。
//
// 只处理 darwin：package.json 的 mac.target 是当前唯一出包 target，
// Windows/Linux 的 resourcesPath 布局也不一样，不能照抄这份路径拼接。
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const agentRuntimeDir = path.join(appPath, 'Contents', 'Resources', 'agent-runtime');
  const assetsDir = path.join(agentRuntimeDir, 'assets');
  const runtimeNodeModules = path.join(agentRuntimeDir, 'runtime', 'node_modules');
  const link = path.join(assetsDir, 'node_modules');

  if (!fs.existsSync(assetsDir)) {
    throw new Error(
      `afterpack-agent-runtime-link: 打包产物里缺少 ${assetsDir}——`
      + 'build.extraResources 复制是否失败？',
    );
  }
  if (!fs.existsSync(runtimeNodeModules)) {
    throw new Error(
      `afterpack-agent-runtime-link: 打包产物里缺少 ${runtimeNodeModules}——`
      + 'src/agent/runtime/node_modules 是否在 npm run dist 之前装过'
      + '（cd src/agent/runtime && npm ci --ignore-scripts）？这正是此前 247MB 依赖'
      + '静默消失同一类坑：extraResources 复制"成功"完全不代表依赖真的在里面。',
    );
  }

  // 幂等：link 目前不该存在（filter 已排除拷贝），但防御性清掉任何意外
  // 残留（符号链接/目录/文件皆可能），再重建。
  try {
    fs.rmSync(link, { recursive: true, force: true });
  } catch {
    // 忽略——rmSync 在目标不存在时本身就是无操作。
  }

  fs.symlinkSync('../runtime/node_modules', link, 'dir');

  // 建完立刻自证：codesign 之前的最后机会，链接指向错了在这里就报错，好过
  // 留到冒烟才在 codesign --verify 或 Node 的 ERR_MODULE_NOT_FOUND 上现形。
  const resolvedTarget = path.resolve(assetsDir, fs.readlinkSync(link));
  if (resolvedTarget !== runtimeNodeModules) {
    throw new Error(
      `afterpack-agent-runtime-link: 链接建好后自证失败，指向 ${resolvedTarget}，`
      + `期望 ${runtimeNodeModules}`,
    );
  }
  console.log(`afterpack-agent-runtime-link: ${link} -> ../runtime/node_modules（afterSign 重签前建好）`);
};
