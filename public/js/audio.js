/* 十三支 · 音效与背景音乐（纯 Web Audio API，无外部音频文件） */
(() => {
  'use strict';

  const LS_KEY = 't13_audio';

  // 简单的五声音阶（C 大调五声），便于旋律不刺耳
  const SCALE = [
    261.63, 293.66, 329.63, 392.00, 440.00, // C4 D4 E4 G4 A4
    523.25, 587.33, 659.25, 783.99, 880.00  // C5 D5 E5 G5 A5
  ];

  // 背景音乐旋律（五声音阶，16 步循环）
  const BGM_PATTERN = [
    0, 7, 4, 7, 2, 7, 4, 7,
    5, 9, 7, 9, 4, 7, 2, 0
  ];
  const BGM_BPM = 88;
  const STEP_MS = (60 / BGM_BPM / 2) * 1000; // 八分音符

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.masterGain = null;
      this.bgmGain = null;
      this.sfxGain = null;

      this.bgmOn = true;
      this.sfxOn = true;
      this.masterVol = 0.6;
      this.bgmVol = 0.35;
      this.sfxVol = 0.6;

      this.bgmTimer = null;
      this.bgmStep = 0;
      this.bgmPlaying = false;

      this._resumeBound = null;
      this._loaded = false;
      this._loadPrefs();
    }

    _loadPrefs() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const p = JSON.parse(raw);
        if (typeof p.bgmOn === 'boolean') this.bgmOn = p.bgmOn;
        if (typeof p.sfxOn === 'boolean') this.sfxOn = p.sfxOn;
        if (typeof p.masterVol === 'number') this.masterVol = p.masterVol;
        if (typeof p.bgmVol === 'number') this.bgmVol = p.bgmVol;
        if (typeof p.sfxVol === 'number') this.sfxVol = p.sfxVol;
      } catch (_) {}
    }

    _savePrefs() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          bgmOn: this.bgmOn, sfxOn: this.sfxOn,
          masterVol: this.masterVol, bgmVol: this.bgmVol, sfxVol: this.sfxVol
        }));
      } catch (_) {}
    }

    /** 在用户首次交互时调用，创建/恢复 AudioContext */
    ensure() {
      if (!this.ctx) {
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return false;
          this.ctx = new AC();
        } catch (_) {
          return false;
        }
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.masterVol;
        this.masterGain.connect(this.ctx.destination);

        this.bgmGain = this.ctx.createGain();
        this.bgmGain.gain.value = this.bgmOn ? this.bgmVol : 0;
        this.bgmGain.connect(this.masterGain);

        this.sfxGain = this.ctx.createGain();
        this.sfxGain.gain.value = this.sfxOn ? this.sfxVol : 0;
        this.sfxGain.connect(this.masterGain);
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return !!this.ctx;
    }

    /** 绑定到 document，任何首次用户手势都会恢复音频上下文 */
    bindResume() {
      if (this._resumeBound) return;
      this._resumeBound = () => {
        this.ensure();
        if (this.bgmOn) this.startBGM();
        // 只需要一次，之后不再移除（低开销）
      };
      ['click', 'keydown', 'touchstart'].forEach((ev) =>
        document.addEventListener(ev, this._resumeBound, { once: true, passive: true })
      );
    }

    // ---------- 音量 / 开关 ----------
    setMasterVol(v) {
      this.masterVol = Math.max(0, Math.min(1, v));
      if (this.masterGain) this.masterGain.gain.value = this.masterVol;
      this._savePrefs();
    }
    setBgmVol(v) {
      this.bgmVol = Math.max(0, Math.min(1, v));
      if (this.bgmGain) this.bgmGain.gain.value = this.bgmOn ? this.bgmVol : 0;
      this._savePrefs();
    }
    setSfxVol(v) {
      this.sfxVol = Math.max(0, Math.min(1, v));
      if (this.sfxGain) this.sfxGain.gain.value = this.sfxOn ? this.sfxVol : 0;
      this._savePrefs();
    }
    toggleBGM(on) {
      this.bgmOn = typeof on === 'boolean' ? on : !this.bgmOn;
      if (this.bgmGain) this.bgmGain.gain.value = this.bgmOn ? this.bgmVol : 0;
      if (this.bgmOn) this.startBGM();
      else this.stopBGM();
      this._savePrefs();
      return this.bgmOn;
    }
    toggleSFX(on) {
      this.sfxOn = typeof on === 'boolean' ? on : !this.sfxOn;
      if (this.sfxGain) this.sfxGain.gain.value = this.sfxOn ? this.sfxVol : 0;
      this._savePrefs();
      return this.sfxOn;
    }

    // ---------- 背景音乐 ----------
    startBGM() {
      if (!this.ensure() || !this.bgmOn) return;
      if (this.bgmPlaying) return;
      this.bgmPlaying = true;
      this.bgmStep = 0;
      const tick = () => {
        if (!this.bgmPlaying) return;
        const note = BGM_PATTERN[this.bgmStep % BGM_PATTERN.length];
        if (note > 0) this._playBgmNote(SCALE[note % SCALE.length], STEP_MS / 1000 * 1.6);
        this.bgmStep++;
      };
      tick();
      this.bgmTimer = setInterval(tick, STEP_MS);
    }

    stopBGM() {
      this.bgmPlaying = false;
      if (this.bgmTimer) {
        clearInterval(this.bgmTimer);
        this.bgmTimer = null;
      }
    }

    _playBgmNote(freq, dur) {
      if (!this.ctx || !this.bgmGain) return;
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(this.bgmGain);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }

    // ---------- 音效 ----------
    _blip({ freq = 440, type = 'sine', dur = 0.12, vol = 0.5, slideTo = null, delay = 0 }) {
      if (!this.sfxOn) return;
      if (!this.ensure() || !this.sfxGain) return;
      const t = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + dur + 0.03);
    }

    // 出牌：清脆的“啪”
    cardPlay() {
      this._blip({ freq: 880, type: 'square', dur: 0.08, vol: 0.35, slideTo: 520 });
    }
    // 发牌：短促的多张连发
    deal() {
      for (let i = 0; i < 4; i++) {
        this._blip({ freq: 700 - i * 60, type: 'triangle', dur: 0.05, vol: 0.25, delay: i * 0.06 });
      }
    }
    // 不要 / Pass
    pass() {
      this._blip({ freq: 220, type: 'sine', dur: 0.14, vol: 0.3, slideTo: 150 });
    }
    // 撞：响亮的双音
    bump() {
      this._blip({ freq: 660, type: 'square', dur: 0.1, vol: 0.45 });
      this._blip({ freq: 990, type: 'square', dur: 0.14, vol: 0.45, delay: 0.08 });
    }
    // 收牌：柔和的叠音
    collect() {
      this._blip({ freq: 520, type: 'sine', dur: 0.18, vol: 0.3, slideTo: 780 });
    }
    // 胜利：上行琶音
    win() {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => this._blip({ freq: f, type: 'triangle', dur: 0.22, vol: 0.4, delay: i * 0.1 }));
    }
    // 失败：下行
    lose() {
      const notes = [523.25, 392.0, 329.63, 261.63];
      notes.forEach((f, i) => this._blip({ freq: f, type: 'sine', dur: 0.24, vol: 0.35, delay: i * 0.12 }));
    }
    // 按钮点击
    click() {
      this._blip({ freq: 620, type: 'square', dur: 0.05, vol: 0.2 });
    }
    // 错误提示
    error() {
      this._blip({ freq: 200, type: 'sawtooth', dur: 0.18, vol: 0.3, slideTo: 120 });
    }
    // 轮到自己：提示音
    myTurn() {
      this._blip({ freq: 740, type: 'triangle', dur: 0.1, vol: 0.3 });
      this._blip({ freq: 988, type: 'triangle', dur: 0.12, vol: 0.3, delay: 0.09 });
    }
  }

  window.Audio = new AudioEngine();
  window.Audio.bindResume();
})();
