// Serialize a design-token object to a CSS rule that defines the --ds-* custom
// properties. Mirrors the mapping used by the editor so themes look identical.

const VARS: Record<string, string> = {
  font: '--ds-font',
  text: '--ds-text',
  muted: '--ds-muted',
  accent: '--ds-accent',
  accent2: '--ds-accent-2',
  grad: '--ds-grad',
  surface: '--ds-surface',
  surface2: '--ds-surface-2',
  border: '--ds-border',
  radius: '--ds-radius',
  shadow: '--ds-shadow',
  glow: '--ds-glow',
  onAccent: '--ds-on-accent',
  // Motion System tokens (mirror of editor/src/design/tokens.ts VARS).
  durFast: '--ds-dur-fast',
  durBase: '--ds-dur-base',
  durSlow: '--ds-dur-slow',
  easeEntrance: '--ds-ease-entrance',
  easeExit: '--ds-ease-exit',
  easeEmphasis: '--ds-ease-emphasis',
  stagger: '--ds-stagger',
};

export type DesignTokens = Record<string, string>;

/**
 * Validate a web-font stylesheet URL (e.g. Google Fonts) before it is embedded
 * in an `@import`. Only https URLs with safe characters are allowed — this is a
 * CSS-injection guard, since the value is interpolated verbatim into a <style>.
 */
export function sanitizeFontImport(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  // https only; no quotes/parens/semicolons/whitespace that could break out of
  // the url("...") wrapper or terminate the rule.
  if (!/^https:\/\/[^\s'"();]+$/.test(url)) return null;
  return url;
}

export function tokensToCss(tokens: DesignTokens, selector = ':root'): string {
  const body = Object.entries(VARS)
    .filter(([key]) => typeof tokens[key] === 'string' && tokens[key].trim())
    .map(([key, cssVar]) => `${cssVar}:${tokens[key]}`)
    .join(';');
  // A web-font `@import` (if any) must precede every other rule in the sheet.
  const fontUrl = sanitizeFontImport(tokens.fontImport);
  const importRule = fontUrl ? `@import url("${fontUrl}");` : '';
  return `${importRule}${selector}{${body}}`;
}

/** Keep only known string token keys. */
export function sanitizeTokens(input: Record<string, unknown>): DesignTokens {
  const out: DesignTokens = {};
  for (const key of Object.keys(VARS)) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) out[key] = v.trim();
  }
  if (typeof input.name === 'string' && input.name.trim()) out.name = input.name.trim();
  // fontImport is not a --ds-* var; it becomes an @import in tokensToCss.
  const fontUrl = sanitizeFontImport(input.fontImport);
  if (fontUrl) out.fontImport = fontUrl;
  return out;
}
