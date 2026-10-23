/**
 * Lowers the site's own audio while a translation plays and restores it afterwards.
 * The volume we last wrote is remembered; a `volumechange` that differs from everything we recently wrote means the
 * user (or the site) changed the volume, so that value is respected and ducking stops (no fight with the site slider).
 * Both directions can be ramped (D22: 250 ms release); the saved value is the exact user volume and is written back
 * verbatim when the ramp ends.
 */
export class Ducker {
  private readonly media: HTMLMediaElement;
  /** the user's volume while ducked (or while a restore ramp runs) */
  private saved: number | null = null;
  private restoring = false;
  private ramp: ReturnType<typeof setInterval> | null = null;
  /** values we wrote lately: `volumechange` events are async and may report an older value of a ramp */
  private written: number[] = [];

  private readonly onVolumeChange = (): void => {
    if (this.saved === null) return;
    const v = this.media.volume;
    if (this.written.some((w) => Math.abs(w - v) < 1e-4)) return;
    this.cancelRamp();
    this.saved = null;
    this.restoring = false;
    this.written = [];
  };

  constructor(media: HTMLMediaElement) {
    this.media = media;
    media.addEventListener('volumechange', this.onVolumeChange);
  }

  /** true while the original is lowered (or on its way back) by us */
  get active(): boolean {
    return this.saved !== null;
  }

  /** the user's volume that restore() will write back, if ducked */
  get userVolume(): number | null {
    return this.saved;
  }

  private write(v: number): void {
    const x = Math.min(1, Math.max(0, v));
    this.written.push(x);
    if (this.written.length > 24) this.written.shift();
    this.media.volume = x;
  }

  private cancelRamp(): void {
    if (this.ramp !== null) clearInterval(this.ramp);
    this.ramp = null;
  }

  private rampTo(to: number, ms: number, done?: () => void): void {
    this.cancelRamp();
    const from = this.media.volume;
    if (ms <= 0 || Math.abs(to - from) < 0.005) {
      this.write(to);
      done?.();
      return;
    }
    const steps = Math.max(2, Math.ceil(ms / 25));
    let i = 0;
    this.ramp = setInterval(() => {
      i++;
      if (i >= steps) {
        this.cancelRamp();
        this.write(to);
        done?.();
      } else {
        this.write(from + ((to - from) * i) / steps);
      }
    }, 25);
  }

  duck(originalVolume: number, rampMs = 0): void {
    if (this.saved === null) this.saved = this.media.volume;
    this.restoring = false;
    // never raise the original above what the user had chosen
    const target = Math.min(Math.min(1, Math.max(0, originalVolume)), this.saved);
    this.rampTo(target, rampMs);
  }

  restore(rampMs = 0): void {
    if (this.saved === null) return;
    const volume = this.saved;
    if (rampMs <= 0) {
      this.cancelRamp();
      this.saved = null;
      this.restoring = false;
      this.write(volume);
      this.written = [];
      return;
    }
    if (this.restoring) return;
    this.restoring = true;
    this.rampTo(volume, rampMs, () => {
      this.saved = null;
      this.restoring = false;
      this.written = [];
    });
  }

  dispose(): void {
    this.cancelRamp();
    this.media.removeEventListener('volumechange', this.onVolumeChange);
  }
}
