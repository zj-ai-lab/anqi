// electron-builder afterSign 钩子：显式 ad-hoc 深度重签（免费方案，Developer ID 暂不上）。
//
// 为什么存在：无证书时 electron-builder 直接跳过签名，app 保留 Electron 出厂 linker 签名
// （Identifier=Electron，CDHash 与全世界同版本未签名 Electron app 共享——含 Adload 恶意家族）。
// Apple 已撤销该共享 CDHash，用户首开弹「将对你的电脑造成伤害…移到废纸篓」且无「仍要打开」
// 通道（2026-08-04 下载 2.1.4 DMG 实测，spctl 判词 `code has been revoked`，见 CHANGES §三十八）。
// 重签成本 app 独有 CDHash 后，降级为常规「无法验证开发者」流程，落地页「仍要打开」指引可用。
//
// ⚠️ 不加 --options runtime：hardened runtime 要配 JIT entitlements，ad-hoc 阶段加了必崩。
// ⚠️ Developer ID 到位（Secrets 配了 CSC_LINK）后本钩子自动跳过——真签名在 afterSign 之前
//    已落，这里再 ad-hoc 会把真签名覆盖掉。
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const EXPECT_ID = 'asia.fdonglawyer.anjian';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败 (exit ${r.status})\n${r.stderr || r.stdout}`);
  }
  return (r.stderr || '') + (r.stdout || ''); // codesign 的信息输出走 stderr
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK) {
    console.log('adhoc-sign: 检测到 CSC_LINK（真证书），跳过 ad-hoc 重签');
    return;
  }
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  run('codesign', ['--force', '--deep', '--sign', '-', appPath]);

  // 验证三连——任何一条不满足都要让构建整体变红，绝不静默把「revoked 二进制」发出去：
  // ① 签名存在且为 adhoc；② 不再是出厂 linker-signed；③ Identifier 是我们的 appId。
  const info = run('codesign', ['-dv', '--verbose=2', appPath]);
  if (!/Signature=adhoc/.test(info)) throw new Error('adhoc-sign: 重签后签名缺失\n' + info);
  if (/linker-signed/.test(info)) throw new Error('adhoc-sign: 仍是出厂 linker 签名（重签未生效）\n' + info);
  if (!info.includes(`Identifier=${EXPECT_ID}`)) {
    throw new Error(`adhoc-sign: Identifier 不是 ${EXPECT_ID}（重签未覆盖主执行档）\n` + info);
  }
  run('codesign', ['--verify', '--deep', '--strict', appPath]);
  console.log(`adhoc-sign: ${appPath} 已 ad-hoc 深度重签并通过校验（Identifier=${EXPECT_ID}）`);
};
