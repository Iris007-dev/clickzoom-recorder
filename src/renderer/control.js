/**
 * control.js —— 悬浮控制条
 * 只干两件事：显示计时、点"结束"通知主窗口停止录制。
 */
(function () {
  'use strict';
  const time = document.getElementById('time');
  const stop = document.getElementById('stop');

  window.api.onControlTick((t) => {
    time.textContent = t;
  });

  stop.addEventListener('click', () => {
    window.api.controlStop();
  });
})();
