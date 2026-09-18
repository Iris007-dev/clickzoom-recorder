/**
 * app.js —— 控制面板逻辑（界面 <-> 录制器 的胶水层）
 */
(function () {
  'use strict';

  const el = (id) => document.getElementById(id);

  const ui = {
    status: el('status'),
    dot: el('statusDot'),
    timer: el('timer'),
    playback: el('playback'),
    frameShell: el('frameShell'),
    preview: el('preview'),
    reviewInfo: el('reviewInfo'),
    btnSave: el('btnSave'),
    btnDiscard: el('btnDiscard'),
    bgSwatches: el('bgSwatches'),
    padRange: el('padRange'),
    padOut: el('padOut'),
    radRange: el('radRange'),
    radOut: el('radOut'),
    screenGrid: el('screenGrid'),
    windowGrid: el('windowGrid'),
    emptyHint: el('emptyHint'),
    btnRefreshSources: el('btnRefreshSources'),
    btnRecord: el('btnRecord'),
    btnHide: el('btnHide'),
    chkMic: el('chkMic'),
    chkSys: el('chkSys'),
    chkClickRing: el('chkClickRing'),
    cursorStyle: el('cursorStyle'),
    cursorColors: el('cursorColors'),
    cursorSize: el('cursorSize'),
    cursorSizeOut: el('cursorSizeOut'),
    chkHidePanel: el('chkHidePanel'),
    fpsSelect: el('fpsSelect'),
    qualitySelect: el('qualitySelect'),
  };

  let sources = [];
  let screens = [];
  let windows = [];
  let displays = [];
  let currentSourceId = ''; // 当前选中的那个屏幕/窗口
  let region = null; // {x,y,w,h} 物理像素
  let recorder = null;
  let recording = false;
  let lastMouse = { x: 0, y: 0 };
  let isMini = false;
  let pendingBlob = null; // 录完还没决定存不存的那段视频
  let pendingUrl = null;

  /* ---------- 画面外框（背景色 / 内边距 / 圆角） ----------
   * 这三个值会在录制时直接画进 canvas，所以是"烧"在视频里的。
   * 选完会记在本地，下次打开软件还是这套。 */
  const FRAME_KEY = 'clickzoom-frame';
  const frame = { bgColor: '#8b6cf5', padding: 50, radius: 10 };

  function loadFrame() {
    try {
      const raw = localStorage.getItem(FRAME_KEY);
      if (raw) Object.assign(frame, JSON.parse(raw));
    } catch (e) {
      /* 读不到就用默认值 */
    }
  }

  function saveFrame() {
    try {
      localStorage.setItem(FRAME_KEY, JSON.stringify(frame));
    } catch (e) {
      /* ignore */
    }
  }

  function applyFrameUi() {
    ui.padRange.value = String(frame.padding);
    ui.radRange.value = String(frame.radius);
    ui.padOut.textContent = frame.padding + 'px';
    ui.radOut.textContent = frame.radius + 'px';
    Array.from(ui.bgSwatches.children).forEach((b) => {
      b.classList.toggle('active', String(b.dataset.color).toLowerCase() === frame.bgColor.toLowerCase());
    });
    paintIdlePreview();
    syncFrameShell();
  }

  // 没在录的时候，预览区画一张示意图，让调参数时能马上看到外框长什么样
  function paintIdlePreview() {
    if (recording) return;
    const c = el('preview');
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#14171c';
    ctx.fillRect(0, 0, c.width, c.height);
  }

  /**
   * 把当前的外框参数换算成预览区的 CSS。
   * 关键是要按比例：预览里画面只有几百像素宽，而实际视频有一两千像素，
   * 直接拿像素值当 padding 会看起来完全不对。
   */
  function syncFrameShell() {
    if (!ui.frameShell) return;
    const pad = frame.padding;
    const showing = document.body.classList.contains('reviewing');
    const target = (showing ? ui.playback : ui.preview) || ui.preview;
    if (!target) return;
    const vw = showing && ui.playback.videoWidth ? ui.playback.videoWidth : 1920;

    // CSS 的 padding 百分比是相对元素宽度算的，正好等于 pad / 总宽
    ui.frameShell.style.background = frame.bgColor;
    ui.frameShell.style.padding = ((pad / (vw + pad * 2)) * 100).toFixed(3) + '%';

    const dispW = target.clientWidth || 320;
    const rad = ((frame.radius * dispW) / vw).toFixed(1) + 'px';
    ui.preview.style.borderRadius = rad;
    ui.playback.style.borderRadius = rad;
  }

  function bindFrameControls() {
    ui.bgSwatches.addEventListener('click', (e) => {
      const b = e.target.closest('.sw');
      if (!b) return;
      frame.bgColor = b.dataset.color;
      applyFrameUi();
      saveFrame();
    });
    ui.padRange.addEventListener('input', () => {
      frame.padding = parseInt(ui.padRange.value, 10) || 0;
      ui.padOut.textContent = frame.padding + 'px';
      saveFrame();
      paintIdlePreview();
      syncFrameShell();
    });
    ui.radRange.addEventListener('input', () => {
      frame.radius = parseInt(ui.radRange.value, 10) || 0;
      ui.radOut.textContent = frame.radius + 'px';
      saveFrame();
      paintIdlePreview();
      syncFrameShell();
    });
  }

  /* ---------- 鼠标效果（样式 / 颜色 / 大小） ---------- */
  const CURSOR_KEY = 'clickzoom-cursor';
  const cursor = { style: 'arrow', color: '#ffffff', size: 40 };

  function loadCursor() {
    try {
      const raw = localStorage.getItem(CURSOR_KEY);
      if (raw) Object.assign(cursor, JSON.parse(raw));
    } catch (e) {
      /* 读不到就用默认 */
    }
  }

  function saveCursor() {
    try {
      localStorage.setItem(CURSOR_KEY, JSON.stringify(cursor));
    } catch (e) {
      /* ignore */
    }
  }

  function applyCursorUi() {
    ui.cursorStyle.value = cursor.style;
    ui.cursorSize.value = String(cursor.size);
    ui.cursorSizeOut.textContent = cursor.size + 'px';
    Array.from(ui.cursorColors.children).forEach((b) => {
      b.classList.toggle('active', String(b.dataset.color).toLowerCase() === cursor.color.toLowerCase());
    });

    // 用系统鼠标（或不画）时，颜色和大小无从谈起，灰掉免得误导
    const custom = cursor.style !== 'system' && cursor.style !== 'none';
    ui.cursorColors.style.opacity = custom ? '1' : '0.35';
    ui.cursorColors.style.pointerEvents = custom ? '' : 'none';
    ui.cursorSize.disabled = !custom;
    ui.cursorSizeOut.style.opacity = custom ? '1' : '0.35';
  }

  function bindCursorControls() {
    ui.cursorStyle.addEventListener('change', () => {
      cursor.style = ui.cursorStyle.value;
      applyCursorUi();
      saveCursor();
    });
    ui.cursorColors.addEventListener('click', (e) => {
      const b = e.target.closest('.sw');
      if (!b) return;
      cursor.color = b.dataset.color;
      applyCursorUi();
      saveCursor();
    });
    ui.cursorSize.addEventListener('input', () => {
      cursor.size = parseInt(ui.cursorSize.value, 10) || 13;
      ui.cursorSizeOut.textContent = cursor.size + 'px';
      saveCursor();
    });
  }

  // 小条模式：窗口缩小的同时，界面也要跟着精简，否则按钮会被挤出可视区
  async function setMiniMode(on) {
    isMini = on;
    document.body.classList.toggle('mini', on);
    await window.api.setMini(on);
  }
  let timerId = null;
  let startAt = 0;

  /* ---------- 滑块与显示联动 ---------- */
  function bindSlider(id, outId, fmt) {
    const s = el(id);
    const o = el(outId);
    const sync = () => {
      o.textContent = fmt(parseFloat(s.value));
    };
    s.addEventListener('input', sync);
    sync();
  }

  function readCamera() {
    return {
      zoomScale: parseFloat(el('zoomScale').value),
      inMs: parseInt(el('inMs').value, 10),
      holdMs: parseInt(el('holdMs').value, 10),
      outMs: parseInt(el('outMs').value, 10),
    };
  }

  function setStatus(text) {
    ui.status.textContent = text;
  }

  function fmtTime(ms) {
    const total = Math.floor(ms / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  /* ---------- 初始化 ---------- */
  async function init() {
    bindSlider('zoomScale', 'zoomScaleOut', (v) => v.toFixed(1) + 'x');
    bindSlider('inMs', 'inMsOut', (v) => v + 'ms');
    bindSlider('holdMs', 'holdMsOut', (v) => v + 'ms');
    bindSlider('outMs', 'outMsOut', (v) => v + 'ms');

    await loadSources();
    displays = await window.api.getDisplays();
    if (!sources.length) setStatus('没有找到可用的屏幕源');

    // 鼠标位置：只要录着就持续喂给录制器（画光圈 + 备用热键要用）
    window.api.onMouseMove((e) => {
      lastMouse = { x: e.x, y: e.y };
      if (recorder) recorder.setMouse(e.x, e.y);
    });

    window.api.onMouseError((msg) => {
      setStatus('鼠标监视器异常：' + msg + '（可用 Ctrl+Alt+Z 手动放大）');
    });

    window.api.onHotkeyZoom(() => {
      if (recording && recorder) recorder.triggerZoom(lastMouse.x, lastMouse.y);
    });

    window.api.onSelftest((opts) => runSelfTest(opts));

    // 鼠标点击：这是触发镜头推近的信号
    window.api.onMouseClick((e) => {
      if (recording && recorder && e.button === 0) {
        recorder.setMouse(e.x, e.y); // 点击位置也是最新的鼠标位置
        recorder.pressCursor(); // 让指针"按下去"一下
        recorder.triggerZoom(e.x, e.y);
      }
    });

    if (window.api.onHotkeyToggle) {
      window.api.onHotkeyToggle(() => toggle());
    }

    console.log('CZR-INIT-OK sources=' + sources.length + ' displays=' + displays.length);

    ui.btnRecord.addEventListener('click', toggle);
    ui.btnRefreshSources.addEventListener('click', async () => {
      setStatus('正在刷新可录界面…');
      await loadSources();
      setStatus('列表已刷新，挑一个要录的界面');
    });
    ui.btnHide.addEventListener('click', () => window.api.hidePanel());
    ui.btnSave.addEventListener('click', saveCurrent);
    ui.btnDiscard.addEventListener('click', discardCurrent);

    window.addEventListener('resize', syncFrameShell);

    loadFrame();
    applyFrameUi();
    bindFrameControls();
    loadCursor();
    applyCursorUi();
    bindCursorControls();
    setReviewMode(false);
  }

  // 切换「实时预览」和「回放」两种状态
  function setReviewMode(on) {
    document.body.classList.toggle('reviewing', on);
    ui.btnSave.hidden = !on;
    ui.btnDiscard.hidden = !on;
    ui.btnHide.hidden = on;
    ui.reviewInfo.hidden = !on; // 没录的时候不显示那行时长/大小
    setTimeout(syncFrameShell, 0); // 等 display 切完再量宽度
    if (!on) {
      ui.btnRecord.textContent = '开始录制';
      ui.timer.hidden = false;
    } else {
      ui.btnRecord.textContent = '重新录制';
      ui.timer.hidden = true;
    }
  }

  /* ---------- 可录界面列表（带缩略图） ---------- */

  async function loadSources() {
    const src = await window.api.getSources();
    screens = src.screens || [];
    windows = src.windows || [];
    sources = screens.concat(windows);

    // 之前选的那个还在吗？不在了就退回第一个
    if (!sources.some((s) => s.id === currentSourceId)) {
      currentSourceId = sources.length ? sources[0].id : '';
    }
    renderSourceGrid();
    syncScopeUi();
  }

  function makeCard(s) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'src-card' + (s.id === currentSourceId ? ' active' : '');
    card.dataset.id = s.id;
    card.title = s.name || s.id;

    if (s.thumbnail) {
      const img = document.createElement('img');
      img.src = s.thumbnail;
      img.alt = '';
      card.appendChild(img);
    }
    const name = document.createElement('span');
    name.className = 'src-name';
    name.textContent = s.name || s.id;
    card.appendChild(name);

    card.addEventListener('click', () => selectSource(s.id));
    return card;
  }

  function renderSourceGrid() {
    ui.screenGrid.innerHTML = '';
    screens.forEach((s) => ui.screenGrid.appendChild(makeCard(s)));

    ui.windowGrid.innerHTML = '';
    windows.forEach((s) => ui.windowGrid.appendChild(makeCard(s)));
    ui.emptyHint.hidden = windows.length > 0;
  }

  function selectSource(id) {
    currentSourceId = id;
    Array.from(document.querySelectorAll('.src-card')).forEach((c) => {
      c.classList.toggle('active', c.dataset.id === id);
    });
    syncScopeUi();
  }

  // 选中的是不是"某个应用窗口"？
  function isWindowMode() {
    return /^window:/i.test(currentSourceId || '');
  }

  // Electron 的窗口源 id 形如 window:<hwnd>:0
  function currentHwnd() {
    const parts = String(currentSourceId).split(':');
    if (parts[0] !== 'window') return null;
    const n = parseInt(parts[1], 10);
    return Number.isNaN(n) ? null : n;
  }

  function syncScopeUi() {
    // 选了具体窗口，就天生只录那一个界面，不用再指定范围
    if (isWindowMode()) region = null;
  }

  /* ---------- 开始 / 停止 ---------- */
  async function toggle() {
    if (recording) await stop();
    else await start();
  }

  function matchDisplay(sourceId) {
    const s = sources.find((x) => x.id === sourceId);
    if (s && s.displayId != null) {
      const d = displays.find((x) => String(x.id) === String(s.displayId));
      if (d) return d.size;
    }
    const p = displays.find((d) => d.primary);
    return p ? p.size : null;
  }

  async function start() {
    if (!sources.length) {
      setStatus('没有可用的屏幕源');
      return;
    }
    clearReview(); // 开新的一段，上一段的回放就作废旧案
    ui.btnRecord.disabled = true;
    setStatus('正在启动…');

    // 窗口模式：先问清楚这个窗口在屏幕上的位置，
    // 否则点击放大时没法把鼠标的屏幕坐标换算进窗口画面
    let winRect = null;
    if (isWindowMode()) {
      const hwnd = currentHwnd();
      if (hwnd != null) {
        setStatus('正在读取窗口位置…');
        const r = await window.api.getWindowRect(hwnd);
        if (r && r.ok) {
          winRect = { x: r.x, y: r.y, width: r.width, height: r.height };
        } else {
          setStatus('读不到窗口位置，点击放大的落点可能不准');
        }
      }
    }

    try {
      const cam = readCamera();
      recorder = new window.CZR.ScreenRecorder(el('preview'));

      // 预览静止状态下先画一帧黑底，避免闪烁
      await recorder.start({
        sourceId: currentSourceId,
        region: region,
        winRect: winRect, // 窗口模式下用来换算鼠标坐标
        display: matchDisplay(currentSourceId),
        fps: parseInt(ui.fpsSelect.value, 10),
        bitrate: parseInt(ui.qualitySelect.value, 10),
        maxWidth: 1920,
        // 外框不在这里传：它改成录完再调，由预览层和保存时的合成负责
        zoomScale: cam.zoomScale,
        inMs: cam.inMs,
        holdMs: cam.holdMs,
        outMs: cam.outMs,
        mic: ui.chkMic.checked,
        systemAudio: ui.chkSys.checked,
        cursorStyle: cursor.style,
        cursorColor: cursor.color,
        cursorSize: cursor.size,
        clickRing: ui.chkClickRing.checked,
      });

      recording = true;
      // 先要一次鼠标当前位置：万一用户开录后先不动鼠标，
      // 监视器的心跳还没到，指针就会画到左上角去
      try {
        const cp0 = await window.api.getCursorPos();
        if (cp0 && (cp0.x || cp0.y)) recorder.setMouse(cp0.x, cp0.y);
      } catch (e) {
        /* 拿不到就先不管，监视器很快会送来位置 */
      }
      // 第二个参数：录制开始时把面板挪出屏幕，让它别闯进画面
      window.api.setRecording(true, ui.chkHidePanel.checked);
      startAt = Date.now();
      timerId = setInterval(() => {
        const text = fmtTime(Date.now() - startAt);
        ui.timer.textContent = text;
        window.api.setTrayTitle('ClickZoom — 录制中 ' + text);
      }, 250);

      ui.btnRecord.textContent = '停止录制';
      ui.btnRecord.classList.add('recording');
      ui.dot.classList.add('on');
      ui.screenGrid.style.pointerEvents = 'none';
      ui.windowGrid.style.pointerEvents = 'none';

      setStatus(
        recorder.systemAudioFailed
          ? '录制中（系统声音没抓到，这台设备可能不支持）'
          : ui.chkHidePanel.checked
          ? '录制中 — 面板已让开，点鼠标试镜头；Ctrl+Alt+R 停止，托盘图标可找回'
          : '录制中 — 点一下鼠标试试镜头'
      );
    } catch (err) {
      console.error(err);
      recorder = null;
      setStatus('启动失败：' + (err && err.message ? err.message : err));
    } finally {
      ui.btnRecord.disabled = false;
    }
  }

  // 只收尾、不弹保存对话框（自测模式要用）
  async function stopRaw() {
    if (!recorder) return null;
    if (isMini) await setMiniMode(false);
    const blob = await recorder.stop();
    recording = false;
    recorder = null;
    window.api.setRecording(false);
    clearInterval(timerId);
    timerId = null;

    ui.btnRecord.textContent = '开始录制';
    ui.btnRecord.classList.remove('recording');
    ui.dot.classList.remove('on');
    ui.screenGrid.style.pointerEvents = '';
    ui.windowGrid.style.pointerEvents = '';
    return blob;
  }

  /* ---------- 回看：录完先在软件里看，满意了再保存 ---------- */
  function showReview(blob) {
    pendingBlob = blob;
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    pendingUrl = URL.createObjectURL(blob);
    ui.playback.src = pendingUrl;
    setReviewMode(true);
    ui.reviewInfo.textContent = (blob.size / 1048576).toFixed(1) + ' MB';
    // 时长要等元数据加载完才知道
    ui.playback.onloadedmetadata = () => {
      const d = ui.playback.duration;
      if (d && isFinite(d)) {
        ui.reviewInfo.textContent = fmtTime(d * 1000) + ' · ' + (blob.size / 1048576).toFixed(1) + ' MB';
      }
      syncFrameShell();
    };
    ui.playback.load();
  }

  function clearReview() {
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
    pendingUrl = null;
    pendingBlob = null;
    ui.playback.pause();
    ui.playback.removeAttribute('src');
    ui.playback.load();
    setReviewMode(false);
    paintIdlePreview();
  }

  /**
   * 把「画面 + 外框」合成成一段新视频。
   * 外框是录完之后才调的，所以保存这一步要用 canvas 重画一遍再录下来 ——
   * 耗时约等于视频本身长度，几秒的演示视频等一下就好。
   */
  async function composeWithFrame(blob, onProgress) {
    const pad = frame.padding;
    const radius = frame.radius;

    const v = document.createElement('video');
    v.src = URL.createObjectURL(blob);
    v.volume = 0; // 别突然出声；音轨数据仍然保留
    v.playsInline = true;
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error('视频读不出来'));
    });

    const cw = v.videoWidth;
    const ch = v.videoHeight;
    const W = cw + pad * 2;
    const H = ch + pad * 2;

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const stream = canvas.captureStream(30);
    // 把原视频的声音也带过去
    try {
      v.captureStream()
        .getAudioTracks()
        .forEach((t) => stream.addTrack(t));
    } catch (e) {
      /* 没声音就算了 */
    }

    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(
      (m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)
    );
    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: parseInt(ui.qualitySelect.value, 10) || 8000000,
    });
    const chunks = [];
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    const finished = new Promise((res) => {
      rec.onstop = res;
    });

    const paint = () => {
      ctx.fillStyle = frame.bgColor;
      ctx.fillRect(0, 0, W, H);
      ctx.save();
      if (radius > 0) {
        ctx.beginPath();
        ctx.roundRect(pad, pad, cw, ch, radius);
        ctx.clip();
      }
      ctx.drawImage(v, pad, pad, cw, ch);
      ctx.restore();
    };

    let raf = 0;
    const loop = () => {
      if (v.ended) return;
      paint();
      if (onProgress && v.duration) onProgress(v.currentTime, v.duration);
      raf = requestAnimationFrame(loop);
    };

    v.onended = () => {
      cancelAnimationFrame(raf);
      setTimeout(() => {
        try {
          rec.stop();
        } catch (e) {
          /* ignore */
        }
      }, 200);
    };

    paint();
    rec.start(500);
    await v.play();
    loop();
    await finished;

    v.pause();
    URL.revokeObjectURL(v.src);

    const out = new Blob(chunks, { type: mime });
    if (!out.size) throw new Error('合成结果为空');
    return out;
  }

  async function saveCurrent() {
    if (!pendingBlob) return;
    ui.btnSave.disabled = true;

    let outBlob = pendingBlob;
    let note = '';
    if (frame.padding > 0 || frame.radius > 0) {
      setStatus('正在把外框合成进视频…');
      try {
        outBlob = await composeWithFrame(pendingBlob, (t, d) => {
          setStatus('生成中 ' + t.toFixed(0) + '/' + d.toFixed(0) + ' 秒…（外框是后加的，要重跑一遍）');
        });
        note = '（已套用外框）';
      } catch (e) {
        console.error(e);
        setStatus('外框合成失败，已按原样保存：' + (e && e.message ? e.message : e));
        outBlob = pendingBlob;
      }
    }

    const buf = await outBlob.arrayBuffer();
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '-');
    const res = await window.api.saveVideo(buf, `clickzoom-${stamp}.webm`);
    ui.btnSave.disabled = false;

    if (res && res.ok) {
      setStatus(`已保存：${res.filePath}${note}（${(outBlob.size / 1048576).toFixed(1)} MB）`);
      window.api.showInFolder(res.filePath);
      clearReview();
    } else if (res && res.canceled) {
      setStatus('取消保存了，回放还留着，想存随时再点「保存」');
    } else {
      setStatus('保存失败：' + (res && res.error ? res.error : '未知错误'));
    }
  }

  function discardCurrent() {
    clearReview();
    setStatus('已丢掉，可以重新录');
  }

  async function stop() {
    if (!recorder) return;
    if (isMini) await setMiniMode(false); // 收工时把面板展开，好看回放
    ui.btnRecord.disabled = true;
    setStatus('正在收尾…');

    const blob = await stopRaw();
    recording = false;
    recorder = null;
    window.api.setRecording(false);
    clearInterval(timerId);
    timerId = null;

    ui.btnRecord.textContent = '开始录制';
    ui.btnRecord.classList.remove('recording');
    ui.dot.classList.remove('on');
    ui.screenGrid.style.pointerEvents = '';
    ui.windowGrid.style.pointerEvents = '';

    if (!blob || blob.size === 0) {
      setStatus('没有录到内容');
      ui.btnRecord.disabled = false;
      return;
    }

    // 不直接存盘：先摆到播放器里让人看一眼
    showReview(blob);
    setStatus('录完了 — 在播放器里看看效果，满意就点「保存」');
    ui.btnRecord.disabled = false;
  }

  /* ---------- 自动自检（npm run selftest） ----------
   * 无人值守录 3 秒，中途模拟两次点击，检查：有没有画面、镜头推近了没、文件产出没。
   * 结果会打到终端，前缀 CZR-SELFTEST。
   */
  function sampleNonBlack() {
    const c = el('preview');
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4 * 499) {
      total++;
      if (data[i] > 12 || data[i + 1] > 12 || data[i + 2] > 12) nonBlack++;
    }
    return total ? nonBlack / total : 0;
  }

  async function runSelfTest(opts) {
    opts = opts || {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const report = { ok: false, stage: 'init' };
    let finished = false;

    // 死线：不管卡在哪一步，到点都把当前状态吐出来再退出，免得无人值守时挂死
    const deadline = setTimeout(() => {
      if (finished) return;
      report.error = report.error || ('timeout at stage=' + report.stage);
      console.log('CZR-SELFTEST ' + JSON.stringify(report));
      window.api.quitApp();
    }, 25000);

    try {
      report.stage = 'start';
      // 自测就要走真实路径：面板照样挪出屏幕，看看录制有没有被节流
      ui.chkHidePanel.checked = true;

      // 自检时可以指定指针样式（用来验证"系统光标有没有被盖住"）
      if (opts.cursorStyle) {
        cursor.style = opts.cursorStyle;
        applyCursorUi();
      }

      // 有窗口就优先验窗口模式（只录某个界面，其他界面不进画面）
      report.windowsCount = windows.length;
      if (!opts.forceScreen && windows.length) selectSource(windows[0].id);
      report.mode = isWindowMode() ? 'window' : 'screen';

      await start();
      if (!recorder) throw new Error('录制器没起来');
      report.stage = 'recording';

      report.videoW = recorder.video.videoWidth;
      report.videoH = recorder.video.videoHeight;
      report.canvasW = el('preview').width;
      report.canvasH = el('preview').height;

      const d = displays.find((x) => x.primary) || displays[0];
      const dw = d ? d.size.width : report.videoW;
      const dh = d ? d.size.height : report.videoH;

      let maxScale = 1;
      const sampler = setInterval(() => {
        if (recorder) maxScale = Math.max(maxScale, recorder.zoom.scale);
      }, 25);

      await sleep(500);
      const framesAtStart = recorder.frames; // 此刻面板已在屏幕外，开始数帧
      recorder.triggerZoom(dw * 0.35, dh * 0.4);
      await sleep(1100);
      // 第二次的放大中心对准当前光标：这样快照中央就是鼠标所在处，
      // 一眼就能看出指针有没有被录进画面
      let aim = { x: dw * 0.7, y: dh * 0.6 };
      try {
        const cp = await window.api.getCursorPos();
        if (cp && (cp.x || cp.y)) aim = cp;
      } catch (e) {
        /* 拿不到就用默认落点 */
      }
      recorder.triggerZoom(aim.x, aim.y);

      // 此刻正处于 2x 保持阶段，抓一张快照，肉眼确认镜头确实推近了
      await sleep(500);
      const snap = await window.api.saveImageTo(el('preview').toDataURL('image/jpeg', 0.72), 'czr-selftest-zoom.jpg');
      report.snapshotPath = snap && snap.filePath ? snap.filePath : null;

      await sleep(1200);

      report.framesDrawn = recorder.frames - framesAtStart;
      report.nonBlackRatio = Number(sampleNonBlack().toFixed(3));
      clearInterval(sampler);
      report.maxScale = Number(maxScale.toFixed(3));

      report.stage = 'stopping';
      const blob = await stopRaw();
      report.stage = 'review';
      report.blobBytes = blob ? blob.size : 0;
      if (blob && blob.size > 0) {
        // 回放功能：录完的这段要能真的被播放器读出来
        showReview(blob);
        await sleep(1800);
        report.reviewReady = ui.playback.readyState >= 2;
        report.reviewW = ui.playback.videoWidth;
        report.reviewH = ui.playback.videoHeight;

        // 顺手验一下"保存时合成外框"这条路能不能走通
        report.stage = 'compose';
        const keepFrame = { padding: frame.padding, radius: frame.radius, bgColor: frame.bgColor };
        frame.padding = 40;
        frame.radius = 10;
        frame.bgColor = '#8b6cf5';
        try {
          const framed = await composeWithFrame(blob, null);
          report.composeBytes = framed ? framed.size : 0;
          report.composeOk = !!(framed && framed.size > 1000);
        } catch (e) {
          report.composeOk = false;
          report.composeErr = String((e && e.message) || e);
        }
        Object.assign(frame, keepFrame);

        report.stage = 'saving';
        const buf = await blob.arrayBuffer();
        const res = await window.api.saveVideoTo(buf, 'czr-selftest.webm');
        report.savedPath = res && res.filePath ? res.filePath : null;
        report.savedBytes = res && res.bytes ? res.bytes : 0;
        // framesDrawn 是关键：面板挪出屏幕后还在出帧，说明没被浏览器节流
        // reviewReady 说明录出来的文件能被播放器打开，回放功能可用
        report.ok = !!(
          res &&
          res.ok &&
          report.nonBlackRatio > 0.05 &&
          report.maxScale > 1.5 &&
          report.framesDrawn > 20 &&
          report.reviewReady &&
          report.composeOk
        );
      }
    } catch (e) {
      report.error = String(e && e.message ? e.message : e);
    }
    finished = true;
    clearTimeout(deadline);
    report.stage = 'done';
    console.log('CZR-SELFTEST ' + JSON.stringify(report));
    setTimeout(() => window.api.quitApp(), 400);
  }

  init().catch((e) => {
    console.error(e);
    setStatus('初始化失败：' + (e && e.message ? e.message : e));
  });
})();
