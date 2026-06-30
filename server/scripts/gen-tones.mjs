#!/usr/bin/env node
/**
 * gen-tones.mjs — zero-dependency offline synthesizer for the OverlayKit
 * starter sound catalog. Writes ~14 short 16-bit / mono / 44100 Hz PCM WAV clips
 * into server/public/sounds/<category>/<name>.wav plus a manifest.json that the
 * editor SoundPicker, the panel soundboard, and saved sound actions read.
 *
 * No network fetch and no npm deps: every clip is synthesized from sine / triangle
 * / square partials, shaped white noise, or short arpeggios, then wrapped in an
 * ADSR-ish envelope with a fade-in (>=3ms) and fade-out (>=20ms) so there are no
 * clicks, and peak-normalized to ~ -3 dBFS. CC0 (synthesized) — fully royalty-free.
 *
 * Run:  node server/scripts/gen-tones.mjs   (from the repo root)
 */

import { mkdirSync, writeFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ -> server/ -> public/sounds
const SOUNDS_DIR = join(__dirname, '..', 'public', 'sounds');

const SAMPLE_RATE = 44100;
const TWO_PI = Math.PI * 2;
const PEAK_DBFS = -3; // normalize target
const PEAK_LINEAR = Math.pow(10, PEAK_DBFS / 20);

// ---------------------------------------------------------------------------
// Low-level signal helpers. A "buffer" is a Float32Array of samples in [-1, 1].
// ---------------------------------------------------------------------------

const nSamples = (ms) => Math.max(1, Math.round((ms / 1000) * SAMPLE_RATE));

/** Oscillator. shape: 'sine' | 'triangle' | 'square'. freq may be a fn(t)->Hz (glide). */
function osc(ms, freq, shape = 'sine', gain = 1) {
  const len = nSamples(ms);
  const out = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    const f = typeof freq === 'function' ? freq(t, i / len) : freq;
    phase += (TWO_PI * f) / SAMPLE_RATE;
    if (phase > TWO_PI) phase -= TWO_PI;
    let s;
    switch (shape) {
      case 'square':
        s = Math.sin(phase) >= 0 ? 1 : -1;
        break;
      case 'triangle':
        s = (2 / Math.PI) * Math.asin(Math.sin(phase));
        break;
      default:
        s = Math.sin(phase);
    }
    out[i] = s * gain;
  }
  return out;
}

/** White noise, optionally low-pass filtered (one-pole). cutoff in Hz, 0 = off. */
function noise(ms, gain = 1, cutoffHz = 0) {
  const len = nSamples(ms);
  const out = new Float32Array(len);
  let prev = 0;
  // one-pole LPF coefficient
  const dt = 1 / SAMPLE_RATE;
  let alpha = 1;
  if (cutoffHz > 0) {
    const rc = 1 / (TWO_PI * cutoffHz);
    alpha = dt / (rc + dt);
  }
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    prev = cutoffHz > 0 ? prev + alpha * (white - prev) : white;
    out[i] = prev * gain;
  }
  return out;
}

/** Sum/overlay buffers (mix). Result length = max length. */
function mix(...buffers) {
  const len = Math.max(...buffers.map((b) => b.length));
  const out = new Float32Array(len);
  for (const b of buffers) {
    for (let i = 0; i < b.length; i++) out[i] += b[i];
  }
  return out;
}

/** Concatenate buffers end to end (sequence). */
function concat(...buffers) {
  const len = buffers.reduce((s, b) => s + b.length, 0);
  const out = new Float32Array(len);
  let off = 0;
  for (const b of buffers) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

/**
 * Apply an ADSR-ish envelope plus guaranteed click-free edges.
 * attack/decay/release in ms; sustain is a level 0..1. A minimum fade-in (3ms)
 * and fade-out (20ms) are always enforced on top so no clip can click.
 */
function envelope(buf, { attack = 5, decay = 40, sustain = 0.7, release = 60 } = {}) {
  const len = buf.length;
  const out = new Float32Array(len);
  const a = nSamples(attack);
  const d = nSamples(decay);
  const r = nSamples(release);
  const sustainStart = a + d;
  const releaseStart = Math.max(sustainStart, len - r);

  for (let i = 0; i < len; i++) {
    let g;
    if (i < a) {
      g = i / a; // attack ramp 0..1
    } else if (i < sustainStart) {
      g = 1 - (1 - sustain) * ((i - a) / d); // decay 1..sustain
    } else if (i < releaseStart) {
      g = sustain; // sustain
    } else {
      g = sustain * (1 - (i - releaseStart) / r); // release ..0
    }
    out[i] = buf[i] * g;
  }
  return enforceFades(out);
}

/** Enforce a minimum fade-in (>=3ms) and fade-out (>=20ms) to kill clicks. */
function enforceFades(buf, fadeInMs = 3, fadeOutMs = 22) {
  const len = buf.length;
  const fin = Math.min(nSamples(fadeInMs), Math.floor(len / 2));
  const fout = Math.min(nSamples(fadeOutMs), Math.floor(len / 2));
  for (let i = 0; i < fin; i++) buf[i] *= i / fin;
  for (let i = 0; i < fout; i++) buf[len - 1 - i] *= i / fout;
  return buf;
}

/** Peak-normalize to ~ -3 dBFS. */
function normalize(buf, peak = PEAK_LINEAR) {
  let max = 0;
  for (let i = 0; i < buf.length; i++) max = Math.max(max, Math.abs(buf[i]));
  if (max < 1e-6) return buf;
  const scale = peak / max;
  for (let i = 0; i < buf.length; i++) buf[i] *= scale;
  return buf;
}

// ---------------------------------------------------------------------------
// WAV writing (canonical 44-byte header + 16-bit signed LE PCM, mono).
// ---------------------------------------------------------------------------

function floatToWav(buf) {
  const numSamples = buf.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4); // file size - 8
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(1, 22); // num channels = mono
  header.writeUInt32LE(SAMPLE_RATE, 24); // sample rate
  header.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28); // byte rate
  header.writeUInt16LE(bytesPerSample, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  const pcm = Buffer.alloc(dataSize);
  for (let i = 0; i < numSamples; i++) {
    let s = Math.max(-1, Math.min(1, buf[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    pcm.writeInt16LE(s | 0, i * bytesPerSample);
  }
  return Buffer.concat([header, pcm]);
}

// Musical note frequencies (equal temperament).
const NOTE = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, B5: 987.77,
  C6: 1046.5, E6: 1318.51, G6: 1567.98,
};

// ---------------------------------------------------------------------------
// Clip recipes. Each returns a finished, normalized Float32Array.
// ---------------------------------------------------------------------------

const recipes = {
  // ---- ui/ ----
  'ui/click': () => {
    // Tight, dry click: short high triangle blip.
    const body = osc(45, 2100, 'triangle');
    return normalize(envelope(body, { attack: 1, decay: 12, sustain: 0.0, release: 18 }));
  },
  'ui/pop': () => {
    // Bubble pop: quick upward pitch glide.
    const body = osc(120, (t) => 320 + 1200 * Math.min(1, t / 0.05), 'sine');
    return normalize(envelope(body, { attack: 2, decay: 40, sustain: 0.25, release: 60 }));
  },
  'ui/tick': () => {
    // Very short percussive tick (noise + tonal ping).
    const ping = osc(30, 3000, 'sine', 0.7);
    const tk = noise(30, 0.5, 6000);
    return normalize(envelope(mix(ping, tk), { attack: 1, decay: 8, sustain: 0.0, release: 16 }));
  },
  'ui/blip': () => {
    // Clean square blip, slightly retro.
    const body = osc(110, 880, 'square', 0.6);
    return normalize(envelope(body, { attack: 2, decay: 30, sustain: 0.4, release: 50 }));
  },

  // ---- alerts/ ----
  'alerts/ding': () => {
    // Bright bell ding: fundamental + octave + fifth partials.
    const f = NOTE.A5;
    const body = mix(
      osc(650, f, 'sine', 1.0),
      osc(650, f * 2, 'sine', 0.4),
      osc(650, f * 3, 'sine', 0.18),
    );
    return normalize(envelope(body, { attack: 3, decay: 120, sustain: 0.35, release: 400 }));
  },
  'alerts/chime': () => {
    // Two-note ascending chime (campana): C5 -> G5.
    const a = envelope(mix(osc(400, NOTE.C5, 'sine'), osc(400, NOTE.C5 * 2, 'sine', 0.3)),
      { attack: 3, decay: 90, sustain: 0.3, release: 250 });
    const b = envelope(mix(osc(500, NOTE.G5, 'sine'), osc(500, NOTE.G5 * 2, 'sine', 0.3)),
      { attack: 3, decay: 110, sustain: 0.3, release: 320 });
    return normalize(concat(a, b));
  },
  'alerts/notify': () => {
    // Friendly two-tone notify: rising perfect fourth, soft triangles.
    const a = envelope(osc(180, NOTE.E5, 'triangle'),
      { attack: 3, decay: 60, sustain: 0.5, release: 90 });
    const b = envelope(osc(280, NOTE.A5, 'triangle'),
      { attack: 3, decay: 70, sustain: 0.5, release: 160 });
    return normalize(concat(a, b));
  },

  // ---- transitions/ ----
  'transitions/whoosh': () => {
    // Filtered noise sweep: cutoff rises then falls, with a body swell.
    const len = nSamples(600);
    const out = new Float32Array(len);
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const p = i / len; // 0..1
      const white = Math.random() * 2 - 1;
      // cutoff sweeps up to mid then back down -> classic whoosh contour
      const cutoff = 400 + 5000 * Math.sin(Math.PI * p);
      const rc = 1 / (TWO_PI * cutoff);
      const dt = 1 / SAMPLE_RATE;
      const alpha = dt / (rc + dt);
      prev = prev + alpha * (white - prev);
      // amplitude swell (in then out)
      const amp = Math.sin(Math.PI * p);
      out[i] = prev * amp;
    }
    return normalize(envelope(out, { attack: 40, decay: 0, sustain: 1.0, release: 120 }));
  },
  'transitions/swipe': () => {
    // Quick downward filtered-noise swipe.
    const len = nSamples(260);
    const out = new Float32Array(len);
    let prev = 0;
    for (let i = 0; i < len; i++) {
      const p = i / len;
      const white = Math.random() * 2 - 1;
      const cutoff = 6000 * (1 - p) + 600; // high -> low
      const rc = 1 / (TWO_PI * cutoff);
      const dt = 1 / SAMPLE_RATE;
      const alpha = dt / (rc + dt);
      prev = prev + alpha * (white - prev);
      out[i] = prev;
    }
    return normalize(envelope(out, { attack: 6, decay: 0, sustain: 1.0, release: 90 }));
  },

  // ---- stingers/ ----
  'stingers/success': () => {
    // Major triad arpeggio resolving to a held chord (C-E-G).
    const n1 = envelope(osc(140, NOTE.C5, 'triangle'), { attack: 3, decay: 40, sustain: 0.6, release: 60 });
    const n2 = envelope(osc(140, NOTE.E5, 'triangle'), { attack: 3, decay: 40, sustain: 0.6, release: 60 });
    const chord = mix(
      osc(520, NOTE.C5, 'triangle', 0.7),
      osc(520, NOTE.E5, 'triangle', 0.7),
      osc(520, NOTE.G5, 'triangle', 0.7),
    );
    const n3 = envelope(chord, { attack: 3, decay: 120, sustain: 0.45, release: 300 });
    return normalize(concat(n1, n2, n3));
  },
  'stingers/fail': () => {
    // Descending minor "wah-wah": A4 -> F4 -> D4, square for a buzzy sad tone.
    const n1 = envelope(osc(180, NOTE.A4, 'square', 0.5), { attack: 3, decay: 40, sustain: 0.6, release: 70 });
    const n2 = envelope(osc(200, NOTE.F4, 'square', 0.5), { attack: 3, decay: 50, sustain: 0.6, release: 80 });
    const n3 = envelope(osc(420, (t) => NOTE.D4 * (1 - 0.06 * Math.min(1, t / 0.4)), 'square', 0.5),
      { attack: 3, decay: 80, sustain: 0.5, release: 260 });
    return normalize(concat(n1, n2, n3));
  },
  'stingers/levelup': () => {
    // Ascending arpeggio fanfare: C5 E5 G5 C6, last note held + octave shimmer.
    const step = (f, ms, hold = false) =>
      envelope(mix(osc(ms, f, 'triangle'), osc(ms, f * 2, 'sine', 0.25)),
        { attack: 2, decay: 30, sustain: hold ? 0.55 : 0.5, release: hold ? 320 : 50 });
    return normalize(concat(
      step(NOTE.C5, 110),
      step(NOTE.E5, 110),
      step(NOTE.G5, 110),
      step(NOTE.C6, 460, true),
    ));
  },
  'stingers/coin': () => {
    // Classic platformer coin: two quick square notes, B5 -> E6.
    const a = envelope(osc(70, NOTE.B5, 'square', 0.6), { attack: 1, decay: 20, sustain: 0.7, release: 30 });
    const b = envelope(osc(320, NOTE.E6, 'square', 0.6), { attack: 1, decay: 60, sustain: 0.5, release: 200 });
    return normalize(concat(a, b));
  },
  'stingers/applause': () => {
    // Shaped white-noise crowd applause: dense noise with amplitude swell and
    // sparse louder "claps" layered on top.
    const len = nSamples(900);
    const out = new Float32Array(len);
    let prev = 0;
    const dt = 1 / SAMPLE_RATE;
    const rc = 1 / (TWO_PI * 3500);
    const alpha = dt / (rc + dt);
    for (let i = 0; i < len; i++) {
      const p = i / len;
      const white = Math.random() * 2 - 1;
      prev = prev + alpha * (white - prev);
      // swell up then sustain then taper (envelope adds final release)
      const amp = Math.min(1, p / 0.15) * (1 - 0.25 * p);
      out[i] = prev * amp * 0.7;
    }
    // sparse claps: short noise bursts
    for (let c = 0; c < 28; c++) {
      const start = Math.floor(Math.random() * (len - 400));
      const burst = nSamples(8 + Math.random() * 10);
      const g = 0.4 + Math.random() * 0.4;
      for (let j = 0; j < burst && start + j < len; j++) {
        const w = (Math.random() * 2 - 1) * g * (1 - j / burst);
        out[start + j] += w;
      }
    }
    return normalize(envelope(out, { attack: 30, decay: 0, sustain: 1.0, release: 220 }));
  },
};

// ---------------------------------------------------------------------------
// Manifest metadata: display names (neutral / Spanish) + ordering.
// ---------------------------------------------------------------------------

const META = {
  'ui/click': { name: 'Click', category: 'ui' },
  'ui/pop': { name: 'Pop', category: 'ui' },
  'ui/tick': { name: 'Tick', category: 'ui' },
  'ui/blip': { name: 'Blip', category: 'ui' },
  'alerts/ding': { name: 'Ding', category: 'alerts' },
  'alerts/chime': { name: 'Campana', category: 'alerts' },
  'alerts/notify': { name: 'Notificación', category: 'alerts' },
  'transitions/whoosh': { name: 'Whoosh', category: 'transitions' },
  'transitions/swipe': { name: 'Swipe', category: 'transitions' },
  'stingers/success': { name: 'Éxito', category: 'stingers' },
  'stingers/fail': { name: 'Error', category: 'stingers' },
  'stingers/levelup': { name: 'Subir de nivel', category: 'stingers' },
  'stingers/coin': { name: 'Moneda', category: 'stingers' },
  'stingers/applause': { name: 'Aplausos', category: 'stingers' },
};

// Category display order for the manifest.
const CATEGORY_ORDER = ['alerts', 'stingers', 'transitions', 'ui'];

function idFromKey(key) {
  return key.replace('/', '-'); // 'ui/click' -> 'ui-click'
}

// ---------------------------------------------------------------------------
// Generate.
// ---------------------------------------------------------------------------

function run() {
  const entries = [];

  for (const key of Object.keys(META)) {
    const recipe = recipes[key];
    if (!recipe) {
      console.warn(`No recipe for ${key}, skipping`);
      continue;
    }
    const buf = recipe();
    const wav = floatToWav(buf);

    const [category, name] = key.split('/');
    const dir = join(SOUNDS_DIR, category);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${name}.wav`);
    writeFileSync(filePath, wav);

    const size = statSync(filePath).size;
    if (size <= 1024) {
      throw new Error(`Generated file too small (${size} bytes): ${filePath}`);
    }

    const durationMs = Math.round((buf.length / SAMPLE_RATE) * 1000);
    entries.push({
      id: idFromKey(key),
      name: META[key].name,
      category: META[key].category,
      url: `/sounds/${category}/${name}.wav`,
      durationMs,
      attribution: 'CC0 (synthesized)',
      _size: size,
    });
    console.log(`  ${key.padEnd(22)} ${String(durationMs).padStart(4)}ms  ${(size / 1024).toFixed(1)} KB`);
  }

  // Sort by category order, then by name.
  entries.sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category);
    const cb = CATEGORY_ORDER.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name);
  });

  // Strip the internal _size field before writing the manifest.
  const manifest = entries.map(({ _size, ...rest }) => rest);
  const manifestPath = join(SOUNDS_DIR, 'manifest.json');
  mkdirSync(SOUNDS_DIR, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`\nWrote ${manifest.length} clips + manifest -> ${manifestPath}`);
}

run();
