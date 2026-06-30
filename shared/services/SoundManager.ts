import { logger } from '../utils/logger';
import { Sound } from '../types/element';

/**
 * Resolve a catalog sound URL to an absolute one. Bundled clips ship as
 * root-relative paths (e.g. "/sounds/alerts/ding.wav") served by the API host,
 * but the overlay/editor run on a DIFFERENT origin, so a bare relative URL would
 * resolve against the overlay origin and 404. Absolutize against VITE_API_URL so
 * every trigger path (panel soundboard, editor sound.play action, and saved
 * actions) heals at this single playback chokepoint. Absolute
 * http(s)/data/blob URLs pass through untouched.
 */
function resolveSoundUrl(url: string): string {
  if (!url || /^(https?:|data:|blob:)/i.test(url)) return url;
  // Match the app convention (ProductionView): VITE_API_URL when set, else the dev
  // API host. Without this a bare "/sounds/.." resolves against the overlay origin
  // (a different port in dev) and hits the SPA fallback (text/html) instead of audio.
  const base = (import.meta as any)?.env?.VITE_API_URL || 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

export class SoundManager {
  private audioElements: Map<string, HTMLAudioElement> = new Map();
  private static instance: SoundManager;

  /**
   * Get singleton instance
   */
  public static getInstance(): SoundManager {
    if (!SoundManager.instance) {
      SoundManager.instance = new SoundManager();
    }
    return SoundManager.instance;
  }

  /**
   * Play a sound
   */
  public async playSound(sound: Sound): Promise<void> {
    // Attempt playback regardless of gesture state: OBS browser sources allow
    // autoplay, so this works in production. In a normal browser tab the play()
    // promise rejects until a user gesture and we degrade gracefully (logged).
    try {
      const audioId = this.generateAudioId(sound.url);
      let audio = this.audioElements.get(audioId);

      if (!audio) {
        audio = new Audio(resolveSoundUrl(sound.url));
        audio.volume = sound.volume ?? 0.5;
        audio.loop = sound.loop ?? false;
        this.audioElements.set(audioId, audio);
      } else {
        audio.currentTime = 0; // Reset playback
        audio.volume = sound.volume ?? 0.5;
        audio.loop = sound.loop ?? false;
      }

      await audio.play().catch((error) => {
        logger.warn('Sound playback blocked (autoplay policy until a user gesture?)', { url: sound.url, error: String(error) });
      });
    } catch (error) {
      logger.error('Error playing sound', { url: sound.url, error: String(error) });
    }
  }

  /**
   * Play background music
   */
  public playBackgroundMusic(sound: Sound & { preload?: boolean }): void {
    const audioId = this.generateAudioId(sound.url + '-bg');
    let audio = this.audioElements.get(audioId);

    if (!audio) {
      audio = new Audio(sound.url);
      audio.loop = sound.loop ?? true;
      audio.volume = sound.volume ?? 0.3;
      this.audioElements.set(audioId, audio);
    }

    if (audio.paused) {
      audio.play().catch((error) => {
        logger.warn('Failed to play background music', {
          url: sound.url,
          error: String(error),
        });
      });
    }
  }

  /**
   * Stop background music
   */
  public stopBackgroundMusic(soundUrl: string): void {
    const audioId = this.generateAudioId(soundUrl + '-bg');
    const audio = this.audioElements.get(audioId);
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }

  /**
   * Stop all sounds
   */
  public stopAll(): void {
    for (const audio of this.audioElements.values()) {
      audio.pause();
      audio.currentTime = 0;
    }
  }

  /**
   * Set volume for a specific sound
   */
  public setVolume(soundUrl: string, volume: number): void {
    const audioId = this.generateAudioId(soundUrl);
    const audio = this.audioElements.get(audioId);
    if (audio) {
      audio.volume = Math.max(0, Math.min(1, volume));
    }
  }

  private generateAudioId(url: string): string {
    // Generate consistent ID from URL
    return `audio-${url.replace(/[^a-zA-Z0-9]/g, '_')}`;
  }
}

export const soundManager = SoundManager.getInstance();
