// Design System tokens. A "design system" is just a set of these values; the
// DS-aware components reference them via var(--ds-*), so swapping the token set
// re-skins the whole collection. The same token <style> is shipped inside the
// activated scene, so production renders identically to the composer.

export interface DesignTokens {
  name: string;
  font: string;        // font-family stack
  text: string;        // primary text color
  muted: string;       // secondary text color
  accent: string;      // primary accent
  accent2: string;     // secondary accent
  grad: string;        // signature gradient (uses accent/accent2)
  surface: string;     // component background (solid / rgba / gradient)
  surface2: string;    // nested chip / inner surface
  border: string;      // border color
  radius: string;      // base border-radius (e.g. "14px")
  shadow: string;      // component box-shadow
  glow: string;        // accent glow color (rgba)
  onAccent: string;    // text color on accent-filled surfaces
  fontImport?: string; // optional https URL to a web-font stylesheet (e.g. Google Fonts), emitted as @import
  // Motion System tokens (optional — the motion-patterns stylesheet supplies
  // fallbacks, so a theme may omit these and still animate sanely).
  durFast?: string;       // exit / quick durations, e.g. "150ms"
  durBase?: string;       // emphasis duration, e.g. "300ms"
  durSlow?: string;       // entrance duration, e.g. "480ms"
  easeEntrance?: string;  // cubic-bezier for arrivals
  easeExit?: string;      // cubic-bezier for exits
  easeEmphasis?: string;  // cubic-bezier for pops
  stagger?: string;       // delay between components in a scene intro, e.g. "80ms"
}

const VARS: Array<[keyof DesignTokens, string]> = [
  ['font', '--ds-font'], ['text', '--ds-text'], ['muted', '--ds-muted'],
  ['accent', '--ds-accent'], ['accent2', '--ds-accent-2'], ['grad', '--ds-grad'],
  ['surface', '--ds-surface'], ['surface2', '--ds-surface-2'], ['border', '--ds-border'],
  ['radius', '--ds-radius'], ['shadow', '--ds-shadow'], ['glow', '--ds-glow'],
  ['onAccent', '--ds-on-accent'],
  // Motion tokens (parallel to the color/type tokens above).
  ['durFast', '--ds-dur-fast'], ['durBase', '--ds-dur-base'], ['durSlow', '--ds-dur-slow'],
  ['easeEntrance', '--ds-ease-entrance'], ['easeExit', '--ds-ease-exit'], ['easeEmphasis', '--ds-ease-emphasis'],
  ['stagger', '--ds-stagger'],
];

/**
 * Validate a web-font stylesheet URL before embedding it in an `@import`
 * (CSS-injection guard — mirror of the server's sanitizeFontImport).
 */
export function sanitizeFontImport(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!/^https:\/\/[^\s'"();]+$/.test(url)) return null;
  return url;
}

/** Serialize tokens to a CSS rule that defines the --ds-* custom properties. */
export function tokensToCss(t: DesignTokens, selector = ':root'): string {
  const body = VARS
    .filter(([key]) => t[key] != null && String(t[key]).trim() !== '')
    .map(([key, cssVar]) => `${cssVar}:${String(t[key])}`)
    .join(';');
  // A web-font `@import` (if any) must come first in the stylesheet.
  const fontUrl = sanitizeFontImport(t.fontImport);
  const importRule = fontUrl ? `@import url("${fontUrl}");` : '';
  return `${importRule}${selector}{${body}}`;
}

export const designSystems: DesignTokens[] = [
  {
    name: 'Broadcast',
    font: "'Inter', system-ui, sans-serif",
    text: '#f4f7fb',
    muted: 'rgba(244,247,251,0.62)',
    accent: '#22d3ee',
    accent2: '#7c3aed',
    grad: 'linear-gradient(135deg, #7c3aed 0%, #22d3ee 100%)',
    surface: 'linear-gradient(180deg, rgba(18,24,38,0.94) 0%, rgba(11,15,23,0.96) 100%)',
    surface2: 'rgba(255,255,255,0.06)',
    border: 'rgba(34,211,238,0.28)',
    radius: '14px',
    shadow: '0 14px 40px rgba(0,0,0,0.5)',
    glow: 'rgba(34,211,238,0.4)',
    onAccent: '#06121a',
    durFast: '140ms', durBase: '300ms', durSlow: '520ms',
    easeEntrance: 'cubic-bezier(.22,1,.36,1)', easeExit: 'cubic-bezier(.4,0,1,1)', easeEmphasis: 'cubic-bezier(.2,.8,.2,1)',
    stagger: '70ms',
  },
  {
    name: 'Neon Esports',
    font: "'Rajdhani', 'Segoe UI', system-ui, sans-serif",
    text: '#f5f3ff',
    muted: 'rgba(245,243,255,0.55)',
    accent: '#22d3ee',
    accent2: '#a855f7',
    grad: 'linear-gradient(135deg, #a855f7 0%, #22d3ee 100%)',
    surface: 'linear-gradient(180deg, rgba(20,18,33,0.92) 0%, rgba(12,11,22,0.95) 100%)',
    surface2: 'rgba(255,255,255,0.06)',
    border: 'rgba(168,85,247,0.35)',
    radius: '16px',
    shadow: '0 12px 36px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(34,211,238,0.10)',
    glow: 'rgba(34,211,238,0.55)',
    onAccent: '#0b0b16',
    // Motion: fast, energetic, slight overshoot, tight sequence.
    durFast: '130ms', durBase: '240ms', durSlow: '420ms',
    easeEntrance: 'cubic-bezier(.16,1,.3,1)', easeExit: 'cubic-bezier(.4,0,1,1)', easeEmphasis: 'cubic-bezier(.34,1.56,.64,1)',
    stagger: '60ms',
  },
  {
    name: 'Minimal Light',
    font: "'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif",
    text: '#1e2430',
    muted: '#6b7280',
    accent: '#2563eb',
    accent2: '#0ea5e9',
    grad: 'linear-gradient(135deg, #2563eb 0%, #0ea5e9 100%)',
    surface: 'rgba(255,255,255,0.94)',
    surface2: 'rgba(15,23,42,0.05)',
    border: 'rgba(15,23,42,0.10)',
    radius: '12px',
    shadow: '0 8px 24px rgba(15,23,42,0.12)',
    glow: 'rgba(37,99,235,0.30)',
    onAccent: '#ffffff',
    // Motion: calm glide, longer, no bounce.
    durFast: '160ms', durBase: '320ms', durSlow: '600ms',
    easeEntrance: 'cubic-bezier(.25,.8,.25,1)', easeExit: 'cubic-bezier(.4,0,1,1)', easeEmphasis: 'cubic-bezier(.25,.8,.25,1)',
    stagger: '90ms',
  },
  {
    name: 'Retro Arcade',
    font: "'Courier New', ui-monospace, monospace",
    text: '#fff8e7',
    muted: '#ffd28a',
    accent: '#ffcc00',
    accent2: '#ff3b3b',
    grad: 'linear-gradient(135deg, #ff3b3b 0%, #ffcc00 100%)',
    surface: 'linear-gradient(180deg, #241341 0%, #160a2b 100%)',
    surface2: 'rgba(255,255,255,0.08)',
    border: '#ffcc00',
    radius: '6px',
    shadow: '0 6px 0 #ff3b3b, 0 12px 24px rgba(0,0,0,0.5)',
    glow: 'rgba(255,204,0,0.6)',
    onAccent: '#160a2b',
    // Motion: snappy, bouncy, stepwise overshoot.
    durFast: '110ms', durBase: '220ms', durSlow: '360ms',
    easeEntrance: 'cubic-bezier(.34,1.7,.5,1)', easeExit: 'cubic-bezier(.5,0,1,1)', easeEmphasis: 'cubic-bezier(.34,1.8,.5,1)',
    stagger: '100ms',
  },
  {
    name: 'Corporate Teal',
    font: "'Segoe UI', Roboto, system-ui, sans-serif",
    text: '#e8eef7',
    muted: '#9fb0c7',
    accent: '#14b8a6',
    accent2: '#0ea5e9',
    grad: 'linear-gradient(135deg, #0ea5e9 0%, #14b8a6 100%)',
    surface: 'linear-gradient(180deg, rgba(15,29,53,0.94) 0%, rgba(10,20,38,0.96) 100%)',
    surface2: 'rgba(255,255,255,0.05)',
    border: 'rgba(20,184,166,0.30)',
    radius: '10px',
    shadow: '0 10px 30px rgba(0,0,0,0.45)',
    glow: 'rgba(20,184,166,0.35)',
    onAccent: '#06121a',
    // Motion: smooth ease-in-out, professional, no bounce.
    durFast: '150ms', durBase: '300ms', durSlow: '500ms',
    easeEntrance: 'cubic-bezier(.4,0,.2,1)', easeExit: 'cubic-bezier(.4,0,1,1)', easeEmphasis: 'cubic-bezier(.4,0,.2,1)',
    stagger: '70ms',
  },
];

export const defaultDesignSystem = designSystems[0];

/** Fill any missing keys (e.g. from an NL-generated partial) with safe defaults. */
export function normalizeTokens(input: Partial<DesignTokens>, name = 'Personalizado'): DesignTokens {
  const base = defaultDesignSystem;
  return {
    name: input.name || name,
    font: input.font || base.font,
    text: input.text || base.text,
    muted: input.muted || base.muted,
    accent: input.accent || base.accent,
    accent2: input.accent2 || base.accent2,
    grad: input.grad || `linear-gradient(135deg, ${input.accent2 || base.accent2} 0%, ${input.accent || base.accent} 100%)`,
    surface: input.surface || base.surface,
    surface2: input.surface2 || base.surface2,
    border: input.border || base.border,
    radius: input.radius || base.radius,
    shadow: input.shadow || base.shadow,
    glow: input.glow || base.glow,
    onAccent: input.onAccent || base.onAccent,
    // Web-font import passes through (sanitized at serialize time); absent = none.
    fontImport: sanitizeFontImport(input.fontImport) || undefined,
    // Motion tokens pass through when provided; absent ones fall back in CSS.
    durFast: input.durFast,
    durBase: input.durBase,
    durSlow: input.durSlow,
    easeEntrance: input.easeEntrance,
    easeExit: input.easeExit,
    easeEmphasis: input.easeEmphasis,
    stagger: input.stagger,
  };
}
