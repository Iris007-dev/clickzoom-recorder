/**
 * zoom.js —— 镜头缩放状态机
 *
 * 一次点击的完整动作分三段：
 *   idle --(点击)--> zoomIn --(自动)--> hold --(自动)--> zoomOut --> idle
 *
 * 每一帧调用 update(now)，它会返回当前应该使用的镜头参数：
 *   scale : 放大倍数，1 表示原始尺寸
 *   cx,cy : 镜头中心点，归一化坐标 [0,1]，相对于"被录制的那个区域"
 */
(function (global) {
  'use strict';

  // 缓动函数：两头慢、中间快。这是"电影感"的来源，别改成线性。
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function clamp01(t) {
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }

  class ZoomController {
    constructor(options) {
      const o = options || {};
      this.zoomScale = o.zoomScale || 2.0;  // 放大到几倍
      this.inMs = o.inMs || 260;            // 推近用时
      this.holdMs = o.holdMs || 700;        // 停留多久
      this.outMs = o.outMs || 320;          // 拉回用时

      // 当前实际镜头值（每一帧都在变）
      this.scale = 1;
      this.cx = 0.5;
      this.cy = 0.5;

      this.phase = 'idle'; // idle | in | hold | out
      this.t0 = 0;
      this.from = { scale: 1, cx: 0.5, cy: 0.5 };
      this.to = { scale: 1, cx: 0.5, cy: 0.5 };
      this.enabled = true;
    }

    /** 点击触发：把镜头推向 (nx, ny) 这个归一化坐标 */
    trigger(nx, ny, now) {
      if (!this.enabled) return;
      nx = clamp01(nx);
      ny = clamp01(ny);

      // 从"当前这一帧的真实值"出发，这样连续点击也不会跳帧
      this.from = { scale: this.scale, cx: this.cx, cy: this.cy };
      this.to = { scale: this.zoomScale, cx: nx, cy: ny };
      this.phase = 'in';
      this.t0 = now;
    }

    /** 每帧调用，推进状态机并返回当前镜头参数 */
    update(now) {
      if (this.phase === 'idle') {
        return { scale: this.scale, cx: this.cx, cy: this.cy, phase: this.phase };
      }

      if (this.phase === 'in') {
        const e = easeInOutCubic(clamp01((now - this.t0) / this.inMs));
        this.scale = lerp(this.from.scale, this.to.scale, e);
        this.cx = lerp(this.from.cx, this.to.cx, e);
        this.cy = lerp(this.from.cy, this.to.cy, e);
        if (now - this.t0 >= this.inMs) {
          this.phase = 'hold';
          this.t0 = now;
        }
      } else if (this.phase === 'hold') {
        // 停在放大状态不动
        this.scale = this.to.scale;
        this.cx = this.to.cx;
        this.cy = this.to.cy;
        if (now - this.t0 >= this.holdMs) {
          this.from = { scale: this.scale, cx: this.cx, cy: this.cy };
          this.to = { scale: 1, cx: 0.5, cy: 0.5 }; // 拉回全屏中心
          this.phase = 'out';
          this.t0 = now;
        }
      } else if (this.phase === 'out') {
        const e = easeInOutCubic(clamp01((now - this.t0) / this.outMs));
        this.scale = lerp(this.from.scale, this.to.scale, e);
        this.cx = lerp(this.from.cx, this.to.cx, e);
        this.cy = lerp(this.from.cy, this.to.cy, e);
        if (now - this.t0 >= this.outMs) {
          this.phase = 'idle';
          this.scale = 1;
          this.cx = 0.5;
          this.cy = 0.5;
        }
      }

      return { scale: this.scale, cx: this.cx, cy: this.cy, phase: this.phase };
    }

    reset() {
      this.scale = 1;
      this.cx = 0.5;
      this.cy = 0.5;
      this.phase = 'idle';
    }
  }

  global.CZR = global.CZR || {};
  global.CZR.ZoomController = ZoomController;
  global.CZR.easeInOutCubic = easeInOutCubic;
})(window);
