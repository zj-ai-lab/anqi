// 引导页逻辑：三步收集配置 → 哈希密码 → 写 config.json → 关窗触发主进程启动后端。
// window.anjianOnboarding 由 preload.js 注入（contextIsolation 安全通道）。
//
// 🔴 局部绑定不能重名叫 anjianOnboarding：contextBridge.exposeInMainWorld 在 global 上建的是
// 不可配置属性，本文件是 classic script，顶层再声明同名 const 会直接抛
// "SyntaxError: Identifier 'anjianOnboarding' has already been declared"——整个脚本解析失败、
// 一个监听器都绑不上，表现为引导页所有按钮点了没反应。（bba4e7b 起一直如此，2.1.1 修复。）
const api = window.anjianOnboarding;
const $ = (id) => document.getElementById(id);

// 默认用户名取系统用户名（Electron 没有 os.userInfo 到 renderer，用 home 目录名兜底）
// 这里先留空让用户自己填，避免猜错。

// 第 1 步：选数据目录
$('pick').addEventListener('click', async () => {
  const dir = await api.chooseDir();
  if (dir) $('dir').value = dir;
  validate();
});

// 实时校验
['dir', 'user', 'pass'].forEach((id) => {
  $(id).addEventListener('input', validate);
});

function validate() {
  const ok = $('dir').value.trim() && $('user').value.trim() && $('pass').value.length >= 4;
  $('submit').disabled = !ok;
  $('err').textContent = '';
}
validate();

// 提交：哈希密码 → 保存配置
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dir = $('dir').value.trim();
  const user = $('user').value.trim();
  const pass = $('pass').value;
  const key = $('key').value.trim();

  if (pass.length < 4) {
    $('err').textContent = '密码至少 4 位';
    return;
  }

  $('submit').disabled = true;
  $('submit').textContent = '正在保存…';
  $('err').textContent = '';

  try {
    // 哈希在主进程跑（不暴露哈希逻辑给 renderer）
    const passHash = await api.hash(pass);
    await api.complete({
      dataDir: dir,
      user,
      passHash,
      deepseekKey: key || '',
      createdAt: new Date().toISOString(),
    });

    // 保存成功：切到「正在初始化」态，关窗让主进程接管启动后端
    $('form').style.display = 'none';
    $('checking').classList.add('show');

    // 主进程的 window-all-closed / 下次 whenReady 会拉起后端 + 主窗口。
    // 这里延迟一下让用户看到提示，然后关窗。
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    $('submit').disabled = false;
    $('submit').textContent = '完成设置，开始使用';
    $('err').textContent = `保存失败：${err.message || err}`;
  }
});
