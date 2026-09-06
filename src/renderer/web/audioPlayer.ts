/**
 * HTML5 <audio> 播放器适配器，模拟 window.electron.player 接口面。
 *
 * 面向浏览器的最简实现：
 * - 音量 0-100 映射到 audio.volume（叠加用 setNormalizationGain 传入的增益）
 * - fade / playWithFade / pauseWithFade 用 rAF 做音量斜坡
 * - 换源、播放/暂停/结束/错误等事件转发为引擎期望的通道
 * - DSP / 音效 / 输出设备等桌面端能力一律空实现
 */

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type Listener<T> = (payload: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  on(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(payload: T): void {
    this.listeners.forEach((fn) => fn(payload));
  }
}

export class WebAudioPlayer {
  private audio: HTMLAudioElement | null = null;
  private sourceUrl = '';
  private trackSeq = 0;
  private volumeValue = 100;
  private gainFactor = 1;
  private fadeFrame: number | null = null;

  private readonly timeUpdateEmitter = new Emitter<number>();
  private readonly seekedEmitter = new Emitter<number>();
  private readonly durationEmitter = new Emitter<number>();
  private readonly fileLoadedEmitter = new Emitter<{
    path?: string;
    seq?: number;
    trackSeq?: number;
    generation?: number;
  }>();
  private readonly stateEmitter = new Emitter<{
    playing?: boolean;
    paused?: boolean;
    trackSeq?: number;
    generation?: number;
  }>();
  private readonly endEmitter = new Emitter<string>();
  private readonly errorEmitter = new Emitter<{ message: string }>();
  private readonly noopEmitter = new Emitter<unknown>();

  private ensureAudio(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.preload = 'auto';
    audio.autoplay = false;
    const apply = () => this.applyVolume();
    audio.addEventListener('timeupdate', () => this.timeUpdateEmitter.emit(audio.currentTime));
    audio.addEventListener('seeked', () => {
      this.seekedEmitter.emit(audio.currentTime);
      this.timeUpdateEmitter.emit(audio.currentTime);
    });
    audio.addEventListener('durationchange', () => this.durationEmitter.emit(audio.duration || 0));
    audio.addEventListener('loadeddata', () =>
      this.fileLoadedEmitter.emit({
        path: this.sourceUrl || (audio.currentSrc as string) || undefined,
        seq: this.trackSeq > 0 ? this.trackSeq : undefined,
        trackSeq: this.trackSeq > 0 ? this.trackSeq : undefined,
      }),
    );
    audio.addEventListener('play', () =>
      this.stateEmitter.emit({ playing: true, trackSeq: this.trackSeq }),
    );
    audio.addEventListener('pause', () => {
      if (audio.ended) return;
      this.stateEmitter.emit({ paused: true, trackSeq: this.trackSeq });
    });
    audio.addEventListener('ended', () => this.endEmitter.emit('eof'));
    audio.addEventListener('error', () =>
      this.errorEmitter.emit({ message: '播放失败' }),
    );
    this.audio = audio;
    apply();
    return audio;
  }

  private applyVolume(): void {
    if (!this.audio) return;
    this.audio.volume = clamp01((this.volumeValue / 100) * this.gainFactor);
  }

  private fadeResolve: (() => void) | null = null;

  private cancelFadeFrame(): void {
    if (this.fadeFrame !== null) {
      window.cancelAnimationFrame(this.fadeFrame);
      this.fadeFrame = null;
    }
    const pending = this.fadeResolve;
    this.fadeResolve = null;
    pending?.();
  }

  private async startFadeTo(to: number, durationMs: number): Promise<void> {
    this.cancelFadeFrame();
    const from = this.volumeValue;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      this.fadeResolve = resolve;
      const step = (now: number) => {
        if (this.fadeFrame === null) return resolve();
        const elapsed = now - start;
        const progress = durationMs <= 0 ? 1 : clamp01(elapsed / durationMs);
        this.volumeValue = from + (to - from) * progress;
        this.applyVolume();
        if (progress < 1) {
          this.fadeFrame = window.requestAnimationFrame(step);
        } else {
          this.fadeFrame = null;
          this.fadeResolve = null;
          resolve();
        }
      };
      this.fadeFrame = window.requestAnimationFrame(step);
    });
  }

  // ── 事件订阅（全部返回退订函数） ──

  onTimeUpdate(fn: Listener<number | { time?: number }>): () => void {
    return this.timeUpdateEmitter.on((time) => fn(time));
  }
  onSeeked(fn: Listener<number>): () => void {
    return this.seekedEmitter.on(fn);
  }
  onSeekStateChange(fn: Listener<unknown>): () => void {
    return this.noopEmitter.on(fn);
  }
  onPlaybackRestart(fn: Listener<unknown>): () => void {
    return this.noopEmitter.on(fn);
  }
  onDurationChange(fn: Listener<number>): () => void {
    return this.durationEmitter.on(fn);
  }
  onFileLoaded(
    fn: Listener<{ path?: string; seq?: number; trackSeq?: number; generation?: number }>,
  ): () => void {
    return this.fileLoadedEmitter.on(fn);
  }
  onStateChange(
    fn: Listener<{ playing?: boolean; paused?: boolean; trackSeq?: number; generation?: number }>,
  ): () => void {
    return this.stateEmitter.on(fn);
  }
  onCoreStateChange(fn: Listener<unknown>): () => void {
    return this.noopEmitter.on(fn);
  }
  onAoStateChange(fn: Listener<unknown>): () => void {
    return this.noopEmitter.on(fn);
  }
  onPlaybackEnd(fn: Listener<string>): () => void {
    return this.endEmitter.on(fn);
  }
  onStall(fn: Listener<number>): () => void {
    return this.noopEmitter.on(fn as Listener<unknown>);
  }
  onPacketCacheStats(fn: Listener<unknown>): () => void {
    return this.noopEmitter.on(fn);
  }
  onAudioOutputStats(fn: Listener<unknown>): () => void {
    return this.noopEmitter.on(fn);
  }
  onAudioGraphChange(fn: Listener<unknown>): () => void {
    return this.noopEmitter.on(fn);
  }
  onError(fn: Listener<{ message: string }>): () => void {
    return this.errorEmitter.on(fn);
  }
  onAudioDeviceListChanged(fn: Listener<unknown>): () => void {
    return this.noopEmitter.on(fn);
  }

  // ── 命令 API ──

  async available(): Promise<boolean> {
    return 'Audio' in window;
  }

  private async loadSource(url: string): Promise<void> {
    if (!url) return;
    const audio = this.ensureAudio();
    this.trackSeq += 1;
    this.sourceUrl = url;
    audio.src = url;
    audio.load();
  }

  async load(url: string): Promise<void> {
    await this.loadSource(url);
  }

  async loadMkvTrack(url: string, _trackId: number): Promise<void> {
    await this.loadSource(url);
  }

  async switchSource(url: string, _trackId?: number | null): Promise<[number, number] | null> {
    await this.loadSource(url);
    return null;
  }

  async beginNextSourcePreparation(): Promise<number | null> {
    return null;
  }

  async cancelNextSourcePreparation(_requestId: number): Promise<boolean> {
    return false;
  }

  async prepareNextSource(
    _url: string,
    _requestId: number,
    _trackId?: number | null,
    _normalizationGainDb?: number,
  ): Promise<number | null> {
    return null;
  }

  async clearPreparedNextSource(): Promise<void> {}

  async commitPreparedNextSource(_transitionMs?: number): Promise<boolean> {
    return false;
  }

  async getTrackList(_url?: string): Promise<never[]> {
    return [];
  }

  async play(): Promise<void> {
    await this.ensureAudio().play().catch(() => {});
  }

  async pause(): Promise<void> {
    this.cancelFadeFrame();
    this.ensureAudio().pause();
  }

  async stop(): Promise<void> {
    this.cancelFadeFrame();
    const audio = this.ensureAudio();
    audio.pause();
    audio.currentTime = 0;
  }

  async seek(time: number): Promise<void> {
    const audio = this.ensureAudio();
    audio.currentTime = clamp(Number(time) || 0, 0, Number.isFinite(audio.duration) ? audio.duration : Infinity);
  }

  async setVolume(volume: number): Promise<void> {
    this.cancelFadeFrame();
    this.volumeValue = clamp(Number(volume) || 0, 0, 100);
    this.applyVolume();
  }

  async setSpeed(speed: number): Promise<void> {
    this.ensureAudio().playbackRate = clamp(Number(speed) || 1, 0.25, 4);
  }

  async setEqualizer(_gains: number[]): Promise<void> {}

  async setAudioEffect(_options: unknown): Promise<void> {}

  async selectDspProvider(_mode?: 'headphone' | 'speaker'): Promise<null> {
    return null;
  }

  async listDspProviders(): Promise<never[]> {
    return [];
  }

  async inspectDspProvider(_path: string): Promise<null> {
    return null;
  }

  async deleteDspProvider(_providerId: string): Promise<void> {}

  async getAudioGraph(): Promise<null> {
    return null;
  }

  async setAudioGraphParameter(_patch: unknown): Promise<void> {}

  async setAudioGraphPlan(_plan: unknown): Promise<void> {}

  async setAudioOutput(_deviceName: string, _exclusive: boolean): Promise<void> {}

  async getAudioDevices(): Promise<never[]> {
    return [];
  }

  async setNormalizationGain(gainDb: number): Promise<void> {
    const db = clamp(Number(gainDb) || 0, -30, 30);
    this.gainFactor = Math.pow(10, db / 20);
    this.applyVolume();
  }

  async fade(from: number, to: number, durationMs: number): Promise<void> {
    this.volumeValue = clamp(Number(from) || 0, 0, 100);
    this.applyVolume();
    await this.startFadeTo(clamp(Number(to) || 0, 0, 100), Math.max(0, Number(durationMs) || 0));
  }

  async cancelFade(): Promise<void> {
    this.cancelFadeFrame();
  }

  async pauseWithFade(_savedVolume: number, durationMs: number): Promise<void> {
    await this.startFadeTo(0, Math.max(0, Number(durationMs) || 0));
    this.ensureAudio().pause();
  }

  async playWithFade(targetVolume: number, durationMs: number): Promise<void> {
    await this.play();
    await this.startFadeTo(clamp(Number(targetVolume) || 0, 0, 100), Math.max(0, Number(durationMs) || 0));
  }

  async getState(): Promise<{
    playing: boolean;
    paused: boolean;
    duration: number;
    timePos: number;
    volume: number;
    speed: number;
    idle: boolean;
    path: string;
    audioDevice: string;
  } | null> {
    const audio = this.audio;
    if (!audio) return null;
    return {
      playing: !audio.paused && !audio.ended,
      paused: audio.paused,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      timePos: audio.currentTime,
      volume: this.volumeValue,
      speed: audio.playbackRate,
      idle: audio.readyState === 0,
      path: this.sourceUrl,
      audioDevice: 'default',
    };
  }

  async restart(): Promise<boolean> {
    const audio = this.ensureAudio();
    if (audio.src) {
      audio.load();
      await audio.play().catch(() => {});
    }
    return true;
  }

  async setPauseOnDeviceDisconnect(_enabled: boolean): Promise<void> {}

  async setMediaTitle(_title: string): Promise<void> {}

  async setLoopFile(loop: boolean): Promise<void> {
    this.ensureAudio().loop = Boolean(loop);
  }

  async setStallTimeout(_seconds: number): Promise<void> {}

  /** 供 recognize 记录系统音频（浏览器下退化为空流声明） */
  captureStreamForLoopback(): MediaStream | null {
    const audio = this.audio;
    if (audio && typeof (audio as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream === 'function') {
      return (audio as HTMLMediaElement & { captureStream: () => MediaStream }).captureStream();
    }
    return null;
  }
}