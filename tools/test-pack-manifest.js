// 打包清单守卫（P3）：electron-builder 的 build.files 是一份手写的 include/
// exclude glob 列表——上一轮改造刚把它从"整棵 src/agent/** 排除"收窄成"只排
// runtime/assets 两棵子树"（见 src/agent/runtime/package.json 的 description），
// 但这份收窄本身完全靠人工保证：往后任何一次给 build.files 加一条更宽的
// exclude glob（哪怕本意只是想多排掉 assets 下的某个子目录），都可能不小心把
// server.js 真正 `import` 需要的某个 src/** 文件也一起排除掉——那种 bug 只有
// 在打包产物里跑 `node server.js` 时才会以 ERR_MODULE_NOT_FOUND 现身，日常
// `npm run check` 的其余步骤全部跑在源码树上，完全测不到。
//
// 这里用静态导入图 + minimatch 做一次几秒钟的机械核验，不真正打包：从
// server.js 出发，只走相对路径的 ESM 静态 import/export-from/动态 import()
// （bare specifier 一律当 npm 包跳过，不递归进 node_modules），收集所有落在
// src/** 下、真正会被 require 到的文件；再用与 electron-builder 相同的
// "按顺序逐条 pattern 累积 include/exclude"语义重放 package.json 的
// build.files，断言这些文件全部仍在打包范围内。
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
