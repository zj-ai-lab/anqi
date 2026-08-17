// preload.js：只给引导页（onboarding.html）用。
// 主窗口（http://127.0.0.1:<port>）加载的是后端静态页，不经过这个 preload。
//
// contextIsolation 开着——renderer 拿不到 require，只能用 window.anjianOnboarding
// 这个经过 contextBridge 暴露的安全接口。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('anjianOnboarding', {
  // 选数据目录（调原生文件夹选择器）
  chooseDir: () => ipcRenderer.invoke('onboarding:chooseDir'),
  // 哈希密码（主进程跑后端的 hashPassword）
  hash: (password) => ipcRenderer.invoke('onboarding:hash', password),
  // 保存配置，完成引导
  complete: (config) => ipcRenderer.invoke('onboarding:complete', config),
});
