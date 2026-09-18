/**
 * mouse-monitor.js —— 全局鼠标监视器
 *
 * 为什么不用 uiohook / iohook 这类原生模块？
 * 因为它们要 node-gyp 编译，Node 版本一变就要重新编译，小白环境十有八九装不上。
 * 这里改成：开一个 PowerShell 子进程，轮询 Windows 系统 API，把事件用纯文本吐出来。
 * 代价是多了几毫秒延迟，好处是零依赖、永远装得上。
 */
const { spawn } = require('child_process');
const path = require('path');
const { app } = require('electron');

/**
 * 精简子进程环境。
 *
 * 踩过的坑：PowerShell 的 Add-Type 会拉起 csc.exe 编译 C#，而 Windows 的进程环境块
 * 上限是 65535 字节。某些宿主环境（IDE 内置终端等）会注入巨大的环境变量，
 * 于是编译直接失败，报"环境块不能多于 65535 个字节"。
 * 对策：只喂给 PowerShell 几个它真正需要的变量。
 */
function minimalEnv() {
  const keep = [
    'SystemRoot',
    'SystemDrive',
    'windir',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'ComSpec',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'OS',
  ];
  const env = {};
  keep.forEach((k) => {
    if (process.env[k]) env[k] = process.env[k];
  });
  env.PATH = 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
  return env;
}

class MouseMonitor {
  constructor() {
    this.proc = null;
    this.listeners = { click: [], move: [], error: [] };
    this.last = { x: 0, y: 0 };
    this.ready = false; // 收到子进程第一行 READY 才算就绪
  }

  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
    return this;
  }

  _emit(event, payload) {
    (this.listeners[event] || []).forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error('[mouse] listener error:', e);
      }
    });
  }

  start() {
    if (this.proc) return;
    const script = path.join(__dirname, 'mouse-monitor.ps1');

    this.proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: minimalEnv() }
    );

    let buf = '';
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this._parse(line);
      }
    });

    this.proc.stderr.on('data', (chunk) => {
      console.error('[mouse] stderr:', chunk.toString('utf8').trim());
    });

    this.proc.on('exit', (code) => {
      console.warn('[mouse] monitor exited, code =', code);
      this.proc = null;
    });

    this.proc.on('error', (err) => {
      console.error('[mouse] failed to start:', err);
      this.proc = null;
    });

    // 进程退出时务必清掉子进程，否则会留下孤儿 powershell
    app.on('before-quit', () => this.stop());
  }

  _parse(line) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'READY') {
      this.ready = true;
      return;
    }
    if (parts[0] === 'ERR') {
      this.ready = false;
      this._emit('error', line.slice(4).trim());
      return;
    }
    if (parts[0] === 'CLICK') {
      const button = parts[1] === '1' ? 1 : 0;
      const x = parseInt(parts[2], 10);
      const y = parseInt(parts[3], 10);
      if (!Number.isNaN(x) && !Number.isNaN(y)) {
        this.last = { x, y };
        this._emit('click', { button, x, y });
      }
    } else if (parts[0] === 'MOVE') {
      const x = parseInt(parts[1], 10);
      const y = parseInt(parts[2], 10);
      if (!Number.isNaN(x) && !Number.isNaN(y)) {
        this.last = { x, y };
        this._emit('move', { x, y });
      }
    }
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch (e) {
      /* ignore */
    }
    this.proc = null;
  }
}

module.exports = { MouseMonitor, minimalEnv };
