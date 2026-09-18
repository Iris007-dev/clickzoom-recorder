/**
 * preload.js —— 安全桥梁
 *
 * 渲染进程里不能用 require（nodeIntegration 关掉了），
 * 所以主进程的能力全部通过 contextBridge 挂到 window.api 上。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getWindowRect: (hwnd) => ipcRenderer.invoke('window-rect', hwnd),
  getCursorPos: () => ipcRenderer.invoke('cursor-pos'),
  controlStop: () => ipcRenderer.send('control:stop'),
  onControlTick: (cb) => {
    const handler = (_e, text) => cb(text);
    ipcRenderer.on('control:tick', handler);
    return () => ipcRenderer.removeListener('control:tick', handler);
  },
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  pickRegion: () => ipcRenderer.invoke('pick-region'),
  regionConfirm: (rect) => ipcRenderer.invoke('region:confirm', rect),
  regionCancel: () => ipcRenderer.invoke('region:cancel'),
  setRecording: (on, hideAway) => ipcRenderer.send('set-recording', on, hideAway),
  hidePanel: () => ipcRenderer.send('hide-panel'),
  restorePanel: () => ipcRenderer.send('restore-panel'),
  setTrayTitle: (text) => ipcRenderer.send('tray:title', text),
  setMini: (mini) => ipcRenderer.invoke('set-mini', mini),
  saveVideo: (buffer, name) => ipcRenderer.invoke('save-video', buffer, name),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),

  onMouseMove: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('mouse:move', handler);
    return () => ipcRenderer.removeListener('mouse:move', handler);
  },
  onHotkeyToggle: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('hotkey:toggle', handler);
    return () => ipcRenderer.removeListener('hotkey:toggle', handler);
  },
  onHotkeyZoom: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('hotkey:zoom', handler);
    return () => ipcRenderer.removeListener('hotkey:zoom', handler);
  },
  saveVideoTo: (buffer, name) => ipcRenderer.invoke('save-video-path', buffer, name),
  saveImageTo: (dataUrl, name) => ipcRenderer.invoke('save-image-path', dataUrl, name),
  quitApp: () => ipcRenderer.send('app:quit'),
  onSelftest: (cb) => {
    const handler = (_e, opts) => cb(opts || {});
    ipcRenderer.on('selftest:start', handler);
    return () => ipcRenderer.removeListener('selftest:start', handler);
  },
  onMouseError: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('mouse:error', handler);
    return () => ipcRenderer.removeListener('mouse:error', handler);
  },
  onMouseClick: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('mouse:click', handler);
    return () => ipcRenderer.removeListener('mouse:click', handler);
  },
});
