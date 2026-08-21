// 打包清单守卫（P3→R2）：electron-builder 的 build.files 是一份手写的 include/
// exclude glob 列表——早先改造把它从"整棵 src/agent/** 排除"收窄成"只排
// runtime/assets 两棵子树"，这份收窄本身完全靠人工保证：往后任何一次给
// build.files 加一条更宽的 exclude glob（哪怕本意只是想多排掉 assets 下的某个
// 子目录），都可能不小心把 server.js 真正 `import` 需要的某个 src/** 文件也一起
// 排除掉——那种 bug 只有在打包产物里跑 `node server.js` 时才会以
// ERR_MODULE_NOT_FOUND 现身，日常 `npm run check` 的其余步骤全部跑在源码树上，
// 完全测不到。
//
// 这里用静态导入图 + minimatch 做一次几秒钟的机械核验，不真正打包：从
// server.js 出发，只走相对路径的 ESM 静态 import/export-from/动态 import()
// （bare specifier 一律当 npm 包跳过，不递归进 node_modules），收集所有落在
// src/** 下、真正会被 require 到的文件；再用与 electron-builder 相同的
// "按顺序逐条 pattern 累积 include/exclude"语义重放 package.json 的
// build.files，断言这些文件全部仍在打包范围内。
//
// R2（AI 助理 beta）追加两条独立核验：
//
// ① runtime/assets 这两棵子树虽然被 build.files 排除出 app 本体（不进 asar/
// 不进 Contents/Resources/app），但并非"不参与打包"——build.extraResources 把
// src/agent 整棵复制到 Contents/Resources/agent-runtime/，src/agent/supervisor.js
// 的 resolveAgentSubdir() 打包模式下正是按这个固定的 "agent-runtime/<name>"
// 相对路径去 process.resourcesPath 下找。这两处（electron-builder 配置与
// supervisor.js 的路径解析）各自独立手写，一旦有人改了任意一侧的目录名/层级
// 而没同步改另一侧，打包版会静默回退到"打包目录不存在→当成 dev 环境→用
// __dirname 相对路径"分支——不存在文件也不报错，只是 AI 助理在打包版里永远
// 走不到 spawn（cordis 配置/技能目录缺失），且没有任何一步会失败到能在
// `npm run check` 里现身。
//
// ② electron-builder 的 extraResources 复制对 node_modules 有一条硬编码特例
// （app-builder-lib 的 util/filter.js createFilter()）：条目相对 from 的路径一旦
// 字面恰好等于 "node_modules"（即 node_modules 直接是 from 的顶层子目录），
// 会被无条件返回 false、整棵子树连同内容一起跳过——这是给"files"主拷贝步骤
// 预留的特例（假设 node_modules 由专门的依赖解析逻辑处理），extraResources 走
// 的是同一份通用 copyDir/walk，完全没有绕过这条规则的办法。这里曾经真的把
// from 直接设成 "src/agent/runtime"（node_modules 是它的直接子目录），实测
// 结果是 dist 产物的 agent-runtime/runtime/ 只剩 package.json/package-lock.json，
// 247MB 的 node_modules 整棵消失、没有任何报错或警告——只有真正跑一次
// electron-builder 打包才会现形，日常 `npm run check` 全绿。现在 extraResources
// 改成 from 指向 src/agent（node_modules 相对它是 "runtime/node_modules"，不再
// 字面等于 "node_modules"），下面对每个 extraResources 条目机械核验它的 from
// 目录下不存在字面顶层子目录 "node_modules"，防止未来又被改回这个坑。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimatch } from 'minimatch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const buildFiles = pkg.build?.files;
assert.ok(Array.isArray(buildFiles) && buildFiles.length > 0, 'package.json 的 build.files 必须是非空数组');

// extraResources 与 supervisor.js 的 resolveAgentSubdir() 之间的机械核验（见上方
// R2 ① 注释）：必须存在一条 from:"src/agent" to:"agent-runtime" 的条目——
// supervisor.js 按 "agent-runtime/runtime"、"agent-runtime/assets" 去
// process.resourcesPath 下找，这里的 "to" 必须与之精确对应；这是唯一一处两边
// 共享的约定，任何一侧改名都会在这里现形，而不是留到打包产物里静默失效。
const extraResources = pkg.build?.extraResources;
assert.ok(Array.isArray(extraResources) && extraResources.length > 0, 'package.json 的 build.extraResources 必须是非空数组（runtime/assets 随包分发）');
const agentEntry = extraResources.find((e) => e && e.from === 'src/agent');
assert.ok(agentEntry, 'build.extraResources 缺少 from:"src/agent" 条目——src/agent/supervisor.js 的 resolveAgentSubdir() 打包模式下会找不到 runtime/assets');
assert.equal(agentEntry.to, 'agent-runtime', `build.extraResources 里 from:"src/agent" 的 to 必须是 "agent-runtime"（与 supervisor.js 的 process.resourcesPath 拼接约定一致），实际是 "${agentEntry.to}"`);

// R2 ② 注释所述的 node_modules 硬编码坑：对每个 extraResources 条目，"from" 目录
// 本身不得是一个 npm 包根——是的话，一次 npm install/ci 就会在它的直接子目录下
// 长出字面名为 "node_modules" 的目录，electron-builder 会把它整棵静默跳过。
//
// 判据用 "from 目录下是否存在 package.json"，不用 "from 目录下是否存在
// node_modules"：后者曾经是这里的实现，但 node_modules 从不提交进仓库（本来就被
// .gitignore 忽略、且只在本机手动跑过一次 npm ci 之后才会出现），在一次全新
// clone / CI checkout（从未跑过 npm ci --ignore-scripts 装 runtime 依赖）上这棵
// 目录天然不存在——用它当判据时，这条断言在唯一真正会把坑带进发行产物的环境
// （CI、全新 clone）里必然放行，只在开发者本机凑巧手动装过依赖时才会生效，等于
// 专为防这个坑写的断言在它最需要生效的地方是空转的。package.json 是 git 追踪的
// 文件，不管有没有跑过 npm install 都存在，判据不随本机磁盘状态漂移。
for (const entry of extraResources) {
  if (!entry || typeof entry.from !== 'string') continue;
  const packageJsonAtFrom = path.join(REPO_ROOT, entry.from, 'package.json');
  assert.ok(
    !fs.existsSync(packageJsonAtFrom),
    `build.extraResources 条目 from:"${entry.from}" 的目录下存在 package.json（是一个 npm 包根）——一次 npm install/ci 会在它的直接子目录下长出字面名为 "node_modules" 的目录，electron-builder 的 extraResources 复制会把它整棵静默跳过（app-builder-lib 的 createFilter()：相对 from 的路径恰好等于 "node_modules" 时无条件返回 false，不报错也不警告）。请把 "from" 指向更高一级目录，让 node_modules 变成 "xxx/node_modules" 这样的相对路径（不再字面等于 "node_modules"），再用 filter 精确圈定要复制的子树。`
  );
}

// 只认这几种可静态识别、不跨越表达式的 import 写法——这份代码库统一走这几种
// 风格（见既有 src/**/*.js 的既有写法），不追求覆盖任意合法 JS 语法，只求对
// 真实用到的写法零漏判。
const FROM_IMPORT_RE = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gs;
const BARE_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const RESOLVABLE_EXT = ['', '.js', '.mjs', '.cjs', '/index.js'];

function extractSpecifiers(source) {
  const specs = new Set();
  for (const re of [FROM_IMPORT_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) specs.add(m[1]);
  }
  return specs;
}

function resolveRelativeImport(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // 裸说明符：npm 包/node:内置，不追踪
  const base = spec.startsWith('/') ? path.join(REPO_ROOT, spec) : path.resolve(path.dirname(fromFile), spec);
  for (const ext of RESOLVABLE_EXT) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// BFS：从 server.js 出发，只在能读成文本的 .js/.mjs/.cjs 文件里继续找 import——
// 二进制/JSON/其它资源文件不含 import 语句，读到即止不再展开。
const entry = path.join(REPO_ROOT, 'server.js');
assert.ok(fs.existsSync(entry), 'server.js 必须存在于仓库根目录');
const visited = new Set([entry]);
const queue = [entry];
const unresolved = [];

while (queue.length) {
  const file = queue.shift();
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    continue; // 非文本文件（理论上不会进队列，防御性兜底）
  }
  for (const spec of extractSpecifiers(source)) {
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const resolved = resolveRelativeImport(file, spec);
    if (!resolved) {
      unresolved.push(`${path.relative(REPO_ROOT, file)} -> ${spec}`);
      continue;
    }
    if (visited.has(resolved)) continue;
    visited.add(resolved);
    if (/\.(js|mjs|cjs)$/.test(resolved)) queue.push(resolved);
  }
}

assert.equal(
  unresolved.length, 0,
  `打包守卫无法解析以下相对 import（新增文件/改名后请检查本探针的解析规则是否需要跟进）：\n${unresolved.join('\n')}`
);

// electron-builder 的 files 语义：按顺序逐条 pattern 累积 include（无 '!'）/
// exclude（'!' 前缀），后面的 pattern 覆盖前面的判断——与 .gitignore 的"后写
// 的规则优先"是同一套心智模型，这里原样重放，不引入第二套语义。
function includedByBuildFiles(relPath, patterns) {
  let included = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (minimatch(relPath, pattern.slice(1), { dot: true })) included = false;
    } else if (minimatch(relPath, pattern, { dot: true })) {
      included = true;
    }
  }
  return included;
}

const srcFilesReached = [...visited]
  .map((abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/'))
  .filter((rel) => rel.startsWith('src/'));

assert.ok(srcFilesReached.length > 10, `导入图遍历结果异常地少（${srcFilesReached.length} 个 src/** 文件）——探针本身可能没有正确递归，请检查`);

const excludedButReachable = srcFilesReached.filter((rel) => !includedByBuildFiles(rel, buildFiles));

assert.deepEqual(
  excludedButReachable, [],
  `以下 src/** 文件被 server.js 的静态 import 图实际用到，但 package.json 的 build.files 会把它们排除在打包产物之外——electron-builder 出包后 node server.js 会在 listen 之前 ERR_MODULE_NOT_FOUND：\n${excludedButReachable.join('\n')}`
);

console.log(`打包清单守卫：server.js 可达的 ${srcFilesReached.length} 个 src/** 文件全部未被 build.files 排除`);
