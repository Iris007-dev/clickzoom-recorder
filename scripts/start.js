/**
 * start.js —— 启动引导
 *
 * 为什么需要它？
 * 某些宿主环境（比如从 IDE 内置终端启动）会注入 ELECTRON_RUN_AS_NODE=1，
 * 这个变量会让 electron.exe 退化成普通 Node：require('electron') 不再返回模块，
 * 而是返回一个 exe 路径字符串，于是 app.whenReady() 直接崩。
 * 这里先把变量清干净，再用正确路径拉起 Electron。
 */
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');

let exePath;
try {
  const e = require('electron');
  exePath = typeof e === 'string' ? e : path.join(root, 'node_modules/electron/dist/electron.exe');
} catch (err) {
  exePath = path.join(root, 'node_modules/electron/dist/electron.exe');
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// 转发额外参数，比如 --selftest / --dev
const child = spawn(exePath, [root, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });

child.on('exit', (code) => process.exit(code == null ? 0 : code));
child.on('error', (err) => {
  console.error('启动 Electron 失败:', err.message);
  console.error('试试手动补装二进制：');
  console.error('  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx electron --version');
  process.exit(1);
});
