#!/usr/bin/env node
// electron-builder 的 build.extraResources 把 src/agent/runtime 整棵目录（含
// node_modules）原样复制进 Contents/Resources/agent-runtime/runtime/，且对
// arm64、x64 两个 mac.target.arch 复制的是**同一棵** node_modules——它不会像
// npm 那样按目标架构挑选 optionalDependencies。而 `npm ci` 只会安装匹配当前
// 宿主（CI runner）os/cpu 的那一份原生可选依赖：这台 macos-latest runner 是
// arm64，`npm ci` 装出来的 node_modules 里只有 @img/sharp-darwin-arm64、
// @koromix/koffi-darwin-arm64，没有 darwin-x64 的对应包。
//
// 结果：arm64 DMG 能正常加载 sharp/koffi，但从同一棵 node_modules 复制出的
// x64 DMG 里，sharp 在 darwin-x64 运行时找不到 @img/sharp-darwin-x64，直接
// `Error: Could not load the "sharp" module using the darwin-x64 runtime`——
// src/agent/assets/anqi.cordis.yml 里的 attachment-local 插件是常挂加载、顶层
// `import sharp from "sharp"`（非懒加载），Intel Mac 用户一开启 AI 助理必崩。
//
// 本脚本在 `npm ci` 之后、`electron-builder` 打包之前跑一次：从
// package-lock.json 里找出所有 "<name>-darwin-arm64" / "<name>-darwin-x64"
// 这一对可选原生依赖家族（sharp 的 sharp-darwin-*、sharp-libvips-darwin-*，
// koffi 的 koffi-darwin-*，以及未来任何遵循同一 npm 生态惯例新增的原生依赖），
// 把宿主 npm ci 没装的那一侧也补装进同一棵 node_modules——不用 `npm install
// --os=--cpu=` 是因为实测（见本仓库审查记录）那条路径会把 npm 判定为
// "同一虚拟 slot 的另一个可选变体"，安装目标架构的同时**删掉**已装的宿主
// 架构（而不是新增），两个架构互斥、正好复现原 bug。这里改用 package-lock.json
// 里已经记录好的 resolved tarball URL + integrity 摘要，直接下载并解包到对应
// node_modules 目录，两侧共存——sharp/koffi 自身的加载器都是按
// process.platform/process.arch 在运行时选对应的原生包（见 sharp 的
// dist/sharp.cjs、koffi 的 src/koffi/indirect.cjs），共存不会造成加载歧义。
//
// 幂等：已存在的目标目录直接跳过，不重复下载。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(REPO_ROOT, 'src', 'agent', 'runtime');
const LOCKFILE = path.join(RUNTIME_DIR, 'package-lock.json');
const NODE_MODULES = path.join(RUNTIME_DIR, 'node_modules');

// electron-builder 的 mac.target.arch 目前是这两个——两个 DMG 都要能独立
// 跑起来，所以两侧都必须在同一棵 node_modules 里存在。
const TARGET_ARCHES = ['arm64', 'x64'];

if (!fs.existsSync(LOCKFILE)) {
  console.error(`ensure-cross-arch-optional-deps: 找不到 ${LOCKFILE}——是否忘了先 npm ci？`);
  process.exit(1);
}
if (!fs.existsSync(NODE_MODULES)) {
  console.error(`ensure-cross-arch-optional-deps: 找不到 ${NODE_MODULES}——请先在 src/agent/runtime 下跑 npm ci --ignore-scripts`);
  process.exit(1);
}

const lock = JSON.parse(fs.readFileSync(LOCKFILE, 'utf8'));
const packages = lock.packages || {};

// key 形如 "node_modules/@img/sharp-darwin-arm64" 或
// "node_modules/koffi-darwin-x64"（无 scope 的情况本仓库暂未用到，但一并
// 支持，不假设一定带 scope）。
const DARWIN_ARCH_RE = /^node_modules\/((?:@[^/]+\/)?)([^/]+)-darwin-(arm64|x64)$/;

// family key -> { scope, base, arches: { arm64: {version, resolved, integrity}, x64: {...} } }
const families = new Map();
for (const [key, entry] of Object.entries(packages)) {
  const m = DARWIN_ARCH_RE.exec(key);
  if (!m) continue;
  const [, scope, base, arch] = m;
  const familyKey = `${scope}${base}`;
  if (!families.has(familyKey)) families.set(familyKey, { scope, base, arches: {} });
  families.get(familyKey).arches[arch] = entry;
}

let installed = 0;
let skipped = 0;

for (const [familyKey, family] of families) {
  const availableArches = Object.keys(family.arches);
  const missingFromLock = TARGET_ARCHES.filter((a) => !availableArches.includes(a));
  if (missingFromLock.length > 0) {
    // 这个家族本身没有覆盖全部目标架构（例如某原生依赖压根不发布 x64
    // 版本）——不是本脚本要处理的情形，跳过，由打包/冒烟阶段的其它核验去发现。
    continue;
  }

  for (const arch of TARGET_ARCHES) {
    const pkgName = `${family.scope}${family.base}-darwin-${arch}`;
    const destDir = path.join(NODE_MODULES, ...pkgName.split('/'));
    if (fs.existsSync(destDir)) {
      skipped += 1;
      continue;
    }

    const entry = family.arches[arch];
    if (!entry.resolved || !entry.integrity) {
      console.error(`ensure-cross-arch-optional-deps: ${pkgName} 在 package-lock.json 里缺少 resolved/integrity，无法安全下载`);
      process.exit(1);
    }

    console.log(`ensure-cross-arch-optional-deps: 补装 ${pkgName}@${entry.version}（宿主 npm ci 只装了当前架构，${arch} 侧缺失）`);
    downloadAndExtract(pkgName, entry, destDir);
    installed += 1;
  }
}

console.log(`ensure-cross-arch-optional-deps: 完成，补装 ${installed} 个跨架构原生依赖包，${skipped} 个已存在（跳过）`);

function downloadAndExtract(pkgName, entry, destDir) {
  const tarballPath = path.join(os.tmpdir(), `${pkgName.replace(/[@/]/g, '_')}-${entry.version}.tgz`);
  // 先解包到 destDir 同级的 staging 目录，成功后再原子 rename 进最终目标——
  // 不直接 mkdir+解包到 destDir 本身：那样一旦下载/校验通过之后、tar 还没
  // 跑完就被打断（进程被杀、磁盘满、tar 本身失败），destDir 会以"已创建但
  // 内容为空或半满"的状态留下来；上面的主循环判断"是否已装过"只用
  // fs.existsSync(destDir)，会把这个半成品误判成"已装好，跳过"，永久盖住这
  // 个坑、下次重跑也发现不了。staging 目录选在 destDir 的父目录下（而不是
  // os.tmpdir()），保证和 destDir 同一文件系统，rename 是原子操作、不会有
  // 跨文件系统 EXDEV 失败的风险。
  const stagingDir = path.join(
    path.dirname(destDir),
    `.ensure-cross-arch-tmp-${path.basename(destDir)}-${process.pid}`,
  );
  try {
    const buf = fetchSync(entry.resolved);
    verifyIntegrity(pkgName, buf, entry.integrity);
    fs.writeFileSync(tarballPath, buf);
    fs.mkdirSync(path.dirname(destDir), { recursive: true }); // scope 目录（如 @img/）可能还不存在
    fs.rmSync(stagingDir, { recursive: true, force: true }); // 清掉可能残留的上次半成品
    fs.mkdirSync(stagingDir, { recursive: true });
    // npm 发布的 tarball 统一是单一顶层目录 "package/"，--strip-components=1
    // 与本仓库 build/ 下手工验证过的做法一致。
    execFileSync('tar', ['-xzf', tarballPath, '-C', stagingDir, '--strip-components=1'], { stdio: 'inherit' });
    fs.renameSync(stagingDir, destDir); // 原子改名：destDir 要么整棵完整出现，要么完全不存在
  } catch (err) {
    // 无论失败在下载、校验、解包还是最后的 rename 哪一步，都不能让
    // destDir/stagingDir 留下不完整的目录挡住下次重试——这里主动清理。
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
    throw err;
  } finally {
    fs.rmSync(tarballPath, { force: true });
  }
}

function verifyIntegrity(pkgName, buf, integrity) {
  // package-lock.json 的 integrity 形如 "sha512-<base64>"，与 npm 自身校验
  // tarball 完整性用的是同一格式（Subresource Integrity）。
  const m = /^sha512-(.+)$/.exec(integrity);
  if (!m) {
    console.error(`ensure-cross-arch-optional-deps: ${pkgName} 的 integrity 格式无法识别："${integrity}"`);
    process.exit(1);
  }
  const expected = m[1];
  const actual = crypto.createHash('sha512').update(buf).digest('base64');
  if (actual !== expected) {
    console.error(`ensure-cross-arch-optional-deps: ${pkgName} 下载内容的 sha512 摘要与 package-lock.json 不符——拒绝安装（可能是网络损坏或供应链问题）`);
    process.exit(1);
  }
}

function fetchSync(url) {
  // 顶层脚本，用 execFileSync 调 curl 换取"同步"语义——脚本整体不需要
  // 并发下载，用 curl 比手写 Node fetch 的 Promise 编排更省事，且 macOS/CI
  // ubuntu 镜像都自带 curl。
  return execFileSync('curl', ['-fsSL', url], { maxBuffer: 1024 * 1024 * 200 });
}
