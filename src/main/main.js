/**
 * main.js —— Electron 主进程
 *
 * 职责：
 *   1. 造控制面板窗口
 *   2. 跑全局鼠标监视器，把点击/移动事件转发给渲染进程
 *   3. 提供 IPC 接口：枚举屏幕源、框选区域、保存文件、迷你模式
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  dialog,
  shell,
  Menu,
  globalShortcut,
  Tray,
  nativeImage,
} = require('electron');
const { spawn } = require('child_process');
const { MouseMonitor, minimalEnv } = require('./mouse-monitor');

let mainWindow = null;
let regionWindow = null;
let regionResolve = null;
let tray = null;
let controlWindow = null; // 录制时右下角那个"结束"小条
let panelBounds = null; // 录制前窗口的位子，收工时原样放回
const mouse = new MouseMonitor();
let recording = false; // 只有录制中才转发鼠标移动，省点开销

/* ---------------- 面板的隐藏与找回 ----------------
 * 录制时面板必须让出屏幕，否则它自己会被录进去。
 * 这里用"挪到屏幕外"而不是 hide()/minimize()：
 * 后者会让 Chromium 认为窗口不可见，requestAnimationFrame 直接停摆，
 * 录出来就是一潭死水。挪出屏幕不影响渲染循环，同时用户也看不见。
 */
function hidePanelAway() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!panelBounds) panelBounds = mainWindow.getBounds();
  mainWindow.setSkipTaskbar(true);
  mainWindow.setBounds({
    x: -12000,
    y: -12000,
    width: panelBounds.width,
    height: panelBounds.height,
  });
}

function restorePanel() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (panelBounds) mainWindow.setBounds(panelBounds);
  panelBounds = null;
  mainWindow.setSkipTaskbar(false);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* ---------------- 悬浮控制条 ----------------
 * 面板藏起来之后，总得有个"结束"按钮可点。
 * 这个条子开了 setContentProtection(true)：Windows 会把它从屏幕捕获里排除，
 * 所以它大模大样摆在右下角，录出来的画面里却看不到它。
 */
function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 244,
    height: 54,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    title: '录制中',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  controlWindow.loadFile(path.join(__dirname, '..', 'renderer', 'control.html'));
  controlWindow.setContentProtection(true); // ★ 录不进去的关键
  controlWindow.on('closed', () => {
    controlWindow = null;
  });
  controlWindow.hide();
}

function showControlWindow() {
  if (!controlWindow || controlWindow.isDestroyed()) createControlWindow();
  const b = screen.getPrimaryDisplay().bounds;
  // 摆在右下角、任务栏上方一点
  controlWindow.setPosition(Math.round(b.x + b.width - 268), Math.round(b.y + b.height - 122));
  controlWindow.setAlwaysOnTop(true, 'screen-saver');
  controlWindow.show();
}

function hideControlWindow() {
  if (controlWindow && !controlWindow.isDestroyed()) controlWindow.hide();
}

function setupTray() {
  // 图标直接从 Electron 的可执行文件里提取，省得再塞一个图标文件
  let icon = nativeImage.createEmpty();
  try {
    const exe = path.join(__dirname, '..', '..', 'node_modules', 'electron', 'dist', 'electron.exe');
    const extracted = nativeImage.createFromPath(exe);
    if (extracted && !extracted.isEmpty()) icon = extracted;
  } catch (e) {
    /* 提取失败就用空图标，托盘照样能点 */
  }
  tray = new Tray(icon);
  tray.setToolTip('ClickZoom 录屏');
  tray.on('click', () => restorePanel());
  tray.on('double-click', () => restorePanel());
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(recording ? 'ClickZoom — 录制中' : 'ClickZoom 录屏');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: recording ? '停止录制' : '开始录制',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('hotkey:toggle');
          }
        },
      },
      { label: '显示面板', click: () => restorePanel() },
      { label: '隐藏面板', click: () => hidePanelAway() },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 820,
    minWidth: 540,
    minHeight: 560,
    title: 'ClickZoom 录屏',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 关键：禁止后台节流，否则窗口被遮挡时 requestAnimationFrame 会停摆
      backgroundThrottling: false,
    },
  });

  // 把渲染进程的报错转打到终端，排查白屏时非常有用
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log('[renderer]', message, `${sourceId}:${line}`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('[renderer] 页面加载失败:', code, desc);
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    // 面板没了，小控制条和托盘也该收摊
    if (controlWindow && !controlWindow.isDestroyed()) controlWindow.close();
    if (tray) {
      tray.destroy();
      tray = null;
    }
    app.quit();
  });
}

/* ---------------- 鼠标事件转发 ---------------- */

function setupMouse() {
  mouse.on('click', (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mouse:click', e);
    }
  });
  mouse.on('move', (e) => {
    if (recording && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mouse:move', e);
    }
  });
  mouse.on('error', (msg) => {
    console.error('[mouse] 监视器不可用:', msg);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mouse:error', String(msg));
    }
  });
  mouse.start();

  // 兜底检查：PowerShell 首次编译 .NET 类型偶尔会慢，给足时间再判定失败
  setTimeout(() => {
    if (!mouse.ready && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mouse:error', '监视器启动超时，点击放大可能不可用');
    }
  }, 12000);
}

/* ---------------- 区域框选窗口 ---------------- */

function openRegionPicker() {
  return new Promise((resolve) => {
    if (regionWindow) {
      try {
        regionWindow.close();
      } catch (e) {
        /* ignore */
      }
    }
    const display = screen.getPrimaryDisplay();
    const { x, y, width, height } = display.bounds;

    regionWindow = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    regionWindow.loadFile(path.join(__dirname, '..', 'renderer', 'region.html'));
    regionResolve = resolve;

    regionWindow.on('closed', () => {
      regionWindow = null;
      if (regionResolve) {
        regionResolve(null);
        regionResolve = null;
      }
    });
  });
}

/* ---------------- IPC ---------------- */

function setupIpc() {
  // 枚举可选的"录制范围"：整屏 或 某个应用窗口
  ipcMain.handle('get-sources', async () => {
    const shape = (s) => ({
      id: s.id,
      name: s.name,
      displayId: s.display_id,
      thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null,
    });

    const [screens, windows] = await Promise.all([
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } }),
      desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 240, height: 140 } }),
    ]);

    // 挑出真正值得录的窗口：
    //   - 缩略图为空 = 抓不到画面
    //   - 名字里带 GUID（CFTodoWindow_{...} 这类）= 系统的隐藏窗口
    //   - 任务栏的托盘溢出弹窗 = 系统内部窗口，不是用户的界面
    //   - 自己 = 选中自己就是无限套娃
    const junk = (w) =>
      w.thumbnail.isEmpty() ||
      /\{[0-9A-Fa-f-]{36}\}/.test(w.name) ||
      w.name.startsWith('系统托盘溢出窗口') ||
      /^(System tray overflow window|Program Manager)/i.test(w.name) ||
      /clickzoom/i.test(w.name);

    return {
      screens: screens.map(shape),
      windows: windows.filter((w) => !junk(w)).map(shape),
    };
  });

  // 查询某个窗口在屏幕上的位置和大小（物理像素），用来把鼠标坐标换算进窗口画面
  ipcMain.handle('window-rect', (_e, hwnd) => {
    return new Promise((resolve) => {
      const script = path.join(__dirname, 'window-rect.ps1');
      const p = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-hwnd', String(hwnd)],
        { windowsHide: true, env: minimalEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let out = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.on('error', () => resolve({ ok: false, error: 'spawn failed' }));
      p.on('close', () => {
        const parts = out.trim().split(/\s+/);
        if (parts.length === 4 && parts.every((v) => v !== '' && !Number.isNaN(parseInt(v, 10)))) {
          const [l, t, r, b] = parts.map((v) => parseInt(v, 10));
          resolve({ ok: true, x: l, y: t, width: r - l, height: b - t });
        } else {
          resolve({ ok: false, raw: out.trim() });
        }
      });
    });
  });

  // 显示器信息（物理像素尺寸 + 缩放比），用来把鼠标坐标换算到画面坐标
  ipcMain.handle('get-displays', () => {
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      size: { width: d.size.width, height: d.size.height },
      scaleFactor: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id,
    }));
  });

  ipcMain.handle('pick-region', async () => {
    const r = await openRegionPicker();
    return r;
  });

  ipcMain.handle('region:confirm', (_e, rectCss) => {
    if (!regionResolve) return;
    const display = screen.getPrimaryDisplay();
    const sf = display.scaleFactor || 1;
    // CSS(DIP) 坐标 -> 物理像素坐标，与 PowerShell 拿到的鼠标坐标同一坐标系
    const region = {
      x: Math.round((display.bounds.x + rectCss.x) * sf),
      y: Math.round((display.bounds.y + rectCss.y) * sf),
      w: Math.round(rectCss.w * sf),
      h: Math.round(rectCss.h * sf),
    };
    regionResolve(region);
    regionResolve = null;
    if (regionWindow && !regionWindow.isDestroyed()) regionWindow.close();
  });

  ipcMain.handle('region:cancel', () => {
    if (regionResolve) {
      regionResolve(null);
      regionResolve = null;
    }
    if (regionWindow && !regionWindow.isDestroyed()) regionWindow.close();
  });

  ipcMain.on('set-recording', (_e, on, hideAway) => {
    recording = !!on;
    if (recording) {
      if (hideAway !== false) hidePanelAway();
      showControlWindow(); // 面板让开了，但"结束"按钮要留在屏幕上
    } else {
      restorePanel();
      hideControlWindow();
    }
    refreshTray();
  });

  // 小控制条上的"结束"按钮
  ipcMain.on('control:stop', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hotkey:toggle');
    }
  });

  // 当前光标位置（物理像素）：自检时用它当放大中心，好检查光标有没有被录进去
  ipcMain.handle('cursor-pos', () => {
    if (mouse.last && (mouse.last.x || mouse.last.y)) return mouse.last;
    const d = screen.getPrimaryDisplay();
    const p = screen.getCursorScreenPoint();
    const sf = d.scaleFactor || 1;
    return { x: Math.round(p.x * sf), y: Math.round(p.y * sf) };
  });

  ipcMain.on('hide-panel', () => hidePanelAway());
  ipcMain.on('restore-panel', () => restorePanel());

  // 录制计时：托盘提示和悬浮控制条都要显示
  ipcMain.on('tray:title', (_e, text) => {
    const t = String(text);
    if (tray) tray.setToolTip(t);
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('control:tick', t.replace(/^.*录制中\s*/, ''));
    }
  });

  ipcMain.handle('set-mini', (_e, mini) => {
    if (!mainWindow) return false;
    if (mini) {
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
      mainWindow.setSize(340, 152);
      mainWindow.setResizable(false);
    } else {
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setSize(620, 820);
      mainWindow.setResizable(true);
    }
    return true;
  });

  // 保存视频：渲染进程把 ArrayBuffer 传过来，主进程落盘
  ipcMain.handle('save-video', async (_e, buffer, suggestedName) => {
    const dir = app.getPath('videos') || os.homedir();
    const defaultPath = path.join(dir, suggestedName || 'clickzoom.webm');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '保存录屏',
      defaultPath,
      filters: [{ name: '视频', extensions: ['webm', 'mp4'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      await fs.promises.writeFile(filePath, Buffer.from(buffer));
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // 自测专用：不弹对话框，直接写固定路径
  ipcMain.handle('save-video-path', async (_e, buffer, name) => {
    const filePath = path.join(app.getPath('temp'), name || 'czr-selftest.webm');
    try {
      await fs.promises.writeFile(filePath, Buffer.from(buffer));
      const stat = await fs.promises.stat(filePath);
      return { ok: true, filePath, bytes: stat.size };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  // 自测专用：把 canvas 快照存成图片，便于肉眼确认效果
  ipcMain.handle('save-image-path', async (_e, dataUrl, name) => {
    const filePath = path.join(app.getPath('temp'), name || 'czr-snapshot.jpg');
    try {
      const base64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
      await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'));
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.on('app:quit', () => app.quit());

  ipcMain.handle('show-in-folder', (_e, filePath) => {
    if (filePath) shell.showItemInFolder(filePath);
  });
}

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createMainWindow();
  setupIpc();
  setupMouse();
  setupTray();
  createControlWindow();

  // 全局热键：窗口缩成小条、甚至失去焦点时也能一键开始/停止
  globalShortcut.register('CommandOrControl+Alt+R', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hotkey:toggle');
    }
  });

  // 备用触发：万一鼠标监视器不可用，用这个键以当前光标位置为中心推近
  globalShortcut.register('CommandOrControl+Alt+Z', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hotkey:zoom');
    }
  });

  // 自测模式：无人值守录 3 秒、中途模拟两次点击，跑完自动退出
  if (process.argv.includes('--selftest')) {
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const cursorArg =
          (process.argv.find((a) => a.startsWith('--cursor=')) || '').split('=')[1] || null;
        mainWindow.webContents.send('selftest:start', {
          forceScreen: process.argv.includes('--selftest-screen'),
          cursorStyle: cursorArg,
        });
      }
    }, 3500);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  mouse.stop();
  app.quit();
});

app.on('before-quit', () => {
  mouse.stop();
});
