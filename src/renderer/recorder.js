/**
 * recorder.js —— 录制核心
 *
 * 数据流：
 *   屏幕流(video) --> 每帧画到 canvas(此时做镜头裁剪/缩放/光圈) --> canvas 捕获流 --> MediaRecorder --> webm
 *
 * 关键点是：放大效果不是在后期加的，而是在"画到 canvas 这一步"实时算出来的，
 * 所以录出来的文件天生就带镜头运动，不需要后期处理。
 */
(function (global) {
  'use strict';

  const CZR = (global.CZR = global.CZR || {});

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  // 亮色填充就配深描边，反之配白描边 —— 保证任何背景上都看得清
  function isLightColor(hex) {
    const h = String(hex || '#111111').replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return false;
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.62;
  }

  // '#rrggbb' -> 'rgba(r,g,b,a)'，用来给光标颜色配不同透明度
  function hexA(hex, alpha) {
    const h = String(hex || '#ffd600').replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    if (Number.isNaN(n)) return 'rgba(255,214,0,' + alpha + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  // 挑一个当前环境真正支持的编码格式，不然 MediaRecorder 会直接抛错
  function pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const m of candidates) {
      if (global.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  class ScreenRecorder {
    /**
     * @param {HTMLCanvasElement} canvas 输出画布（同时也是预览画面）
     */
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });

      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.autoplay = true;

      this.zoom = new CZR.ZoomController();
      this.running = false;
      this.rafId = 0;

      this.chunks = [];
      this.recorder = null;

      // 鼠标状态（源坐标系，物理像素）
      this.mouse = { x: 0, y: 0 };
      this.ripples = [];

      this._streams = [];
      this._audioCtx = null;
      this._onFrame = this._onFrame.bind(this);
    }

    /**
     * @param {Object} cfg
     *   sourceId     屏幕源的 id（整屏）
     *   region       {x,y,w,h} 物理像素；为 null 表示整屏
     *   display      {width,height} 屏幕物理像素尺寸，用来把鼠标坐标换算到画面坐标
     *   fps          录制帧率
     *   zoomScale / inMs / holdMs / outMs   镜头参数
     *   mic          true 时录麦克风
     *   systemAudio  true 时尝试录系统声音
     *   ripple       true 时开启鼠标光圈
     */
    async start(cfg) {
      if (this.running) throw new Error('已经在录了');

      this.cfg = cfg;
      this.winRect = cfg.winRect || null; // 窗口模式才有：窗口在屏幕上的位置
      this.zoom = new CZR.ZoomController({
        zoomScale: cfg.zoomScale,
        inMs: cfg.inMs,
        holdMs: cfg.holdMs,
        outMs: cfg.outMs,
      });
      this.clickRing = cfg.clickRing !== false; // 点击时要不要溅涟漪
      this.cursorStyle = cfg.cursorStyle || 'system';
      this.cursorColor = cfg.cursorColor || '#111111';
      this.cursorSize = Math.max(12, Math.round(cfg.cursorSize || 36)); // 指针高度（px）
      this.pressedUntil = 0; // 点击时给光标一点"按下去"的反馈
      this.ripples = [];

      // ---- 1. 拿屏幕视频流 ----
      // cursor 约束实测有效：'always' = 把系统光标一起录进去；'never' = 不录，
      // 留给下面自己画。用自绘样式时必须关掉，否则会和真实光标重叠成两个。
      const useSystemCursor = this.cursorStyle === 'system';
      // 整屏捕获一定会把系统光标录进去（cursor 约束在 Electron 里无效，实测过）；
      // 窗口捕获则天然不含光标。前者需要我们先把系统光标盖掉再画自己的。
      this.isScreenSource = /^screen:/i.test(cfg.sourceId || '');
      console.log('[rec] stage: requesting screen stream');
      const screenStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: cfg.sourceId,
            minWidth: 640,
            maxWidth: 4096,
            minHeight: 480,
            maxHeight: 4096,
            cursor: useSystemCursor ? 'always' : 'never',
          },
        },
      });
      this._streams.push(screenStream);

      this.video.srcObject = screenStream;
      await new Promise((resolve) => {
        if (this.video.readyState >= 2 && this.video.videoWidth > 0) return resolve();
        this.video.onloadedmetadata = () => resolve();
      });
      await this.video.play().catch(() => {});

      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (!vw || !vh) throw new Error('拿不到画面尺寸，录制中止');
      console.log('[rec] stage: screen ok ' + vw + 'x' + vh);

      // 屏幕物理像素 -> 视频像素 的比例（多数情况下是 1，但高 DPI 屏不是）
      const dw = cfg.display && cfg.display.width ? cfg.display.width : vw;
      const dh = cfg.display && cfg.display.height ? cfg.display.height : vh;
      this.ratioX = vw / dw;
      this.ratioY = vh / dh;

      // ---- 2. 计算有效录制区域（video 像素坐标） ----
      let rx = 0,
        ry = 0,
        rw = vw,
        rh = vh;
      if (cfg.region && cfg.region.w > 0 && cfg.region.h > 0) {
        rx = cfg.region.x * this.ratioX;
        ry = cfg.region.y * this.ratioY;
        rw = cfg.region.w * this.ratioX;
        rh = cfg.region.h * this.ratioY;
        rx = clamp(rx, 0, vw - 1);
        ry = clamp(ry, 0, vh - 1);
        rw = clamp(rw, 1, vw - rx);
        rh = clamp(rh, 1, vh - ry);
      }
      this.region = { x: rx, y: ry, w: rw, h: rh };

      // ---- 3. 输出尺寸：只录画面本身，宽度封顶 1920 ----
      // 背景色 / 内边距 / 圆角**不在这里烧进去** —— 它们要能录完再调：
      // 预览和回放用 CSS 外壳实时呈现，点保存时才用 canvas 合成一遍。
      const maxW = cfg.maxWidth || 1920;
      let outW = Math.round(rw);
      let outH = Math.round(rh);
      if (outW > maxW) {
        outH = Math.round((outH * maxW) / outW);
        outW = maxW;
      }
      outW -= outW % 2; // 编码器要求偶数边长
      outH -= outH % 2;
      this.canvas.width = outW;
      this.canvas.height = outH;

      // ---- 4. 音频：麦克风 + 系统声音 ----
      const audioTracks = [];
      let micStream = null;
      let sysStream = null;

      if (cfg.mic) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: cfg.micDeviceId ? { deviceId: { exact: cfg.micDeviceId } } : true,
          });
          this._streams.push(micStream);
        } catch (e) {
          console.warn('[rec] 麦克风获取失败:', e);
        }
      }

      if (cfg.systemAudio) {
        try {
          sysStream = await navigator.mediaDevices.getUserMedia({
            audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: cfg.sourceId } },
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: cfg.sourceId } },
          });
          this._streams.push(sysStream);
          // 这次调用只是为了拿音轨，视频轨立刻关掉，免得占资源
          sysStream.getVideoTracks().forEach((t) => t.stop());
        } catch (e) {
          console.warn('[rec] 系统声音获取失败（Windows 上并非所有设备都支持）:', e);
          this.systemAudioFailed = true;
        }
      }

      console.log('[rec] stage: audio done mic=' + !!(micStream && micStream.getAudioTracks().length) + ' sys=' + !!(sysStream && sysStream.getAudioTracks().length));

      const hasMic = micStream && micStream.getAudioTracks().length > 0;
      const hasSys = sysStream && sysStream.getAudioTracks().length > 0;

      if (hasMic && hasSys) {
        // 两路声音混合成一条
        this._audioCtx = new (global.AudioContext || global.webkitAudioContext)();
        await this._audioCtx.resume().catch(() => {});
        const dest = this._audioCtx.createMediaStreamDestination();
        this._audioCtx.createMediaStreamSource(micStream).connect(dest);
        this._audioCtx.createMediaStreamSource(sysStream).connect(dest);
        audioTracks.push(...dest.stream.getAudioTracks());
      } else if (hasMic) {
        audioTracks.push(...micStream.getAudioTracks());
      } else if (hasSys) {
        audioTracks.push(...sysStream.getAudioTracks());
      }

      // ---- 5. 把 canvas 变成流，开始录 ----
      const canvasStream = this.canvas.captureStream(cfg.fps || 30);
      this._streams.push(canvasStream);
      audioTracks.forEach((t) => canvasStream.addTrack(t));

      const mimeType = pickMimeType();
      this.chunks = [];
      this.recorder = new MediaRecorder(canvasStream, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: cfg.bitrate || 8000000,
      });
      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };
      this.recorder.start(1000);
      console.log('[rec] stage: recording started, mime=' + (mimeType || 'default'));

      this.running = true;
      this.startedAt = performance.now();
      this.frames = 0; // 帧计数：用来验证面板挪出屏幕后画面是否真的还在出帧
      this._loop();
    }

    /**
     * 屏幕物理坐标 -> 画面像素坐标。
     * 整屏/区域模式按屏幕比例换算；窗口模式要把坐标先减掉窗口左上角。
     */
    _toVideo(x, y) {
      const w = this.winRect;
      if (w && w.width > 0 && w.height > 0) {
        return {
          x: ((x - w.x) / w.width) * this.video.videoWidth,
          y: ((y - w.y) / w.height) * this.video.videoHeight,
        };
      }
      return { x: x * this.ratioX, y: y * this.ratioY };
    }

    /** 外部告诉录制器：鼠标动了 / 鼠标点了 */
    setMouse(x, y) {
      const p = this._toVideo(x, y);
      this.mouse.x = p.x;
      this.mouse.y = p.y;
    }

    triggerZoom(x, y) {
      const r = this.region;
      if (!r) return;
      const p = this._toVideo(x, y);
      const vx = p.x;
      const vy = p.y;
      const nx = clamp((vx - r.x) / r.w, 0, 1);
      const ny = clamp((vy - r.y) / r.h, 0, 1);
      this.zoom.trigger(nx, ny, performance.now());
      if (this.clickRing) this.ripples.push({ x: vx, y: vy, t0: performance.now() });
    }

    _loop() {
      if (!this.running) return;
      this._onFrame();
      this.rafId = requestAnimationFrame(() => this._loop());
    }

    _onFrame() {
      const now = performance.now();
      this.frames++;
      const ctx = this.ctx;
      const W = this.canvas.width;
      const H = this.canvas.height;
      const cw0 = W; // 画面铺满整块 canvas，外框交给预览层/保存时合成
      const ch0 = H;
      const r = this.region;

      const cam = this.zoom.update(now);

      // 镜头裁剪窗口（源坐标系）
      const cw = r.w / cam.scale;
      const ch = r.h / cam.scale;
      const ccx = r.x + cam.cx * r.w;
      const ccy = r.y + cam.cy * r.h;
      const sx = clamp(ccx - cw / 2, r.x, r.x + r.w - cw);
      const sy = clamp(ccy - ch / 2, r.y, r.y + r.h - ch);

      ctx.drawImage(this.video, sx, sy, cw, ch, 0, 0, W, H);

      // 选"系统鼠标"就完全不碰画面，真实光标原样保留；
      // 其余情况（自绘 / 不画）都要先把系统光标处理掉
      if (this.cursorStyle !== 'system') {
        const toOut = (px, py) => ({
          x: ((px - sx) / cw) * cw0,
          y: ((py - sy) / ch) * ch0,
        });

        const m = toOut(this.mouse.x, this.mouse.y);

        if (m.x >= -200 && m.x <= W + 200 && m.y >= -200 && m.y <= H + 200) {
          // 整屏捕获时系统光标一定在画面里 —— 先盖掉它。
          // 注意这一步对"不画鼠标"同样要做，否则用户选了半天还是看得见系统箭头。
          if (this.isScreenSource) {
            this._eraseSystemCursor(ctx, m, cam.scale, W, H, cw0 / cw, this.mouse);
          }
          this._drawCursor(ctx, m.x, m.y, cam.scale);
        }

        if (this.clickRing) {
          this.ripples = this.ripples.filter((rp) => now - rp.t0 < 600);
          for (const rp of this.ripples) {
            const t = (now - rp.t0) / 600;
            const p2 = toOut(rp.x, rp.y);
            ctx.strokeStyle = hexA(this.cursorColor, (1 - t) * 0.9);
            ctx.lineWidth = 4 * (1 - t) + 1;
            ctx.beginPath();
            ctx.arc(p2.x, p2.y, this.cursorSize + t * 42, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }

    /**
     * 把系统光标"擦"掉。
     * 整屏捕获时它必然在画面里，而我们又关不掉它（Electron 没这个开关，实测两条路都无效），
     * 所以只能在我们的指针下面先盖一小块：从"鼠标左边一点"的位置借一条像素横着拉过来。
     * 注意素材要从 video 里取 —— 从 canvas 自取在 GPU 加速下拿不到正确像素。
     * 这块区域很小（几十像素），而且马上会被指针压住，正常看不出来。
     */
    _eraseSystemCursor(ctx, m, zoomScale, W, H, k, srcPt) {
      if (!k || !srcPt) return;

      // 系统光标在视频源里大约 12x19 物理像素；乘 k（源→输出比例）就是它在输出里的尺寸。
      // 留 1.7 倍余量，块开得越小痕迹越不明显。
      const ew = Math.max(14, Math.round(12 * k * 1.7));
      const eh = Math.max(18, Math.round(19 * k * 1.7));
      const x = Math.round(m.x) - 1;
      const y = Math.round(m.y) - 1;
      if (x < 0 || y < 0 || x + ew > W || y + eh > H) return;

      // 从上方借一条像素垂直拉下来。比横向拉自然 —— 横向在文字行上会留下一条明显的横纹。
      const band = 4 / k;
      const srcTop = srcPt.y - (eh + 8) / k;
      const srcLeft = Math.max(0, srcPt.x - (ew + 8) / k);
      if (srcTop < 0) return;
      if (srcTop + band > this.video.videoHeight) return;
      if (srcLeft + (ew + 10) / k > this.video.videoWidth) return;

      ctx.drawImage(this.video, srcLeft, srcTop, (ew + 10) / k, band, x, y, ew, eh);
    }

    /** 鼠标按下时给一点视觉反馈 */
    pressCursor() {
      this.pressedUntil = performance.now() + 170;
    }

    /** 把鼠标指针本身画出来（系统光标是录不到的，只能自己画） */
    _drawCursor(ctx, x, y, zoomScale) {
      const style = this.cursorStyle;
      // 'system' 用的是真实光标，不需要我们画；'none' 是明确不要指针
      if (style === 'none' || style === 'system') return;

      // 尺寸跟着镜头缩放：画面放大时针也变大，才盖得住底下的系统光标
      const s = (this.cursorSize / 20) * (zoomScale || 1); // 20px 高作为基准
      const pressed = performance.now() < this.pressedUntil;
      const k = pressed ? 0.86 : 1; // 按下时缩一点，观众能看出"点了"
      const fill = this.cursorColor;
      const stroke = isLightColor(fill) ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.95)';

      ctx.save();
      ctx.translate(x, y);
      ctx.scale(k, k);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      // 细线型（十字 / I 型）：粗白线打底 + 深色细线，细线才在任何背景上看得见
      if (style === 'crosshair' || style === 'ibeam') {
        const lp = new Path2D();
        if (style === 'crosshair') {
          const r = 8 * s;
          lp.moveTo(0, -r);
          lp.lineTo(0, -r * 0.34);
          lp.moveTo(0, r * 0.34);
          lp.lineTo(0, r);
          lp.moveTo(-r, 0);
          lp.lineTo(-r * 0.34, 0);
          lp.moveTo(r * 0.34, 0);
          lp.lineTo(r, 0);
        } else {
          const hh = 9 * s;
          lp.moveTo(-2.6 * s, -hh);
          lp.lineTo(2.6 * s, -hh);
          lp.moveTo(-2.6 * s, hh);
          lp.lineTo(2.6 * s, hh);
          lp.moveTo(0, -hh);
          lp.lineTo(0, hh);
        }
        ctx.shadowColor = 'rgba(0,0,0,0.3)';
        ctx.shadowBlur = 3 * s;
        ctx.lineWidth = Math.max(1.6, 1.7 * s);
        ctx.strokeStyle = stroke;
        ctx.stroke(lp);
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = Math.max(1, 0.9 * s);
        ctx.strokeStyle = fill;
        ctx.stroke(lp);
        ctx.restore();
        return;
      }

      // 实心形状：各块之间故意留重叠，这样内部不会露出接缝线
      const path = new Path2D();

      if (style === 'hand') {
        // 食指 + 三个卷起来的手指 + 拇指 + 手掌，拼出一个"手"的样子
        path.roundRect(4.6 * s, 0, 3.4 * s, 11.5 * s, 1.7 * s);
        path.roundRect(8.2 * s, 6.2 * s, 3.2 * s, 5.8 * s, 1.6 * s);
        path.roundRect(10.9 * s, 7.3 * s, 2.5 * s, 4.7 * s, 1.25 * s);
        path.roundRect(0.6 * s, 9.4 * s, 3.2 * s, 5.2 * s, 1.6 * s);
        path.roundRect(2.4 * s, 9.0 * s, 10.2 * s, 8.0 * s, 2.6 * s);
      } else if (style === 'dot') {
        path.arc(0, 0, 5 * s, 0, Math.PI * 2);
      } else {
        // 经典箭头轮廓（尖端在左上）
        const pts = [
          [0, 0],
          [0, 16.2],
          [4.3, 12.5],
          [6.7, 19.3],
          [9.6, 17.8],
          [7.0, 11.3],
          [11.7, 11.3],
        ];
        pts.forEach(([px, py], i) => {
          if (i === 0) path.moveTo(px * s, py * s);
          else path.lineTo(px * s, py * s);
        });
        path.closePath();
      }

      // 1) 带阴影填充一次（阴影很轻，只是让指针从背景里"浮"出来一点）
      ctx.shadowColor = 'rgba(0,0,0,0.32)';
      ctx.shadowBlur = 3.5 * s;
      ctx.shadowOffsetY = 0.8 * s;
      ctx.fillStyle = fill;
      ctx.fill(path);

      // 2) 描边：细一点才像真光标，太粗会显得笨重
      ctx.shadowColor = 'transparent';
      ctx.shadowOffsetY = 0;
      ctx.lineWidth = Math.max(1.2, 1.3 * s);
      ctx.strokeStyle = stroke;
      ctx.stroke(path);

      // 3) 再填一次，把描边压在内侧的半边盖掉，只留外圈 —— 复合形状内部才不会有杂线
      ctx.fillStyle = fill;
      ctx.fill(path);

      ctx.restore();
    }

    /** 停止录制，返回 Blob */
    stop() {
      return new Promise((resolve) => {
        if (!this.running || !this.recorder) return resolve(null);
        this.running = false;
        cancelAnimationFrame(this.rafId);

        this.recorder.onstop = () => {
          const blob = new Blob(this.chunks, { type: this.recorder.mimeType || 'video/webm' });
          this._cleanup();
          resolve(blob);
        };
        this.recorder.stop();
      });
    }

    _cleanup() {
      this._streams.forEach((s) => {
        try {
          s.getTracks().forEach((t) => t.stop());
        } catch (e) {
          /* ignore */
        }
      });
      this._streams = [];
      if (this._audioCtx) {
        this._audioCtx.close().catch(() => {});
        this._audioCtx = null;
      }
      this.video.srcObject = null;
    }
  }

  CZR.ScreenRecorder = ScreenRecorder;
})(window);
