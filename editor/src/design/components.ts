import type { EditorTemplate } from '../templates';
import { designComponentsExtra } from './componentsExtra';

// Design-System-aware components. Every color / font / radius / shadow is a
// var(--ds-*) with a baked-in fallback, so each looks good standalone AND
// re-skins instantly when a design system (theme) sets the --ds-* tokens.
// They use simple anchors (no transform-centering) so the Layout Composer can
// place them pixel-accurately.

const dsLowerThird: EditorTemplate = {
  id: 'ds-lower-third',
  name: 'DS · Lower Third',
  description: 'Nombre + rol con franja de acento. Usa el Design System activo.',
  html:
    '<div class="dsl3">\n  <div class="dsl3__accent"></div>\n  <div class="dsl3__body">\n    <div class="dsl3__name">{{user.name}}</div>\n    <div class="dsl3__role">{{user.role}}</div>\n  </div>\n</div>',
  css:
    '.dsl3 {\n  position: absolute; left: 80px; bottom: 96px;\n  display: flex; align-items: stretch; min-width: 360px;\n  background: var(--ds-surface, rgba(17,18,27,0.92));\n  border: 1px solid var(--ds-border, rgba(168,85,247,0.35));\n  border-radius: var(--ds-radius, 16px);\n  box-shadow: var(--ds-shadow, 0 12px 36px rgba(0,0,0,0.55));\n  font-family: var(--ds-font, system-ui, sans-serif);\n  overflow: hidden;\n  animation: dsl3-in var(--ds-dur-slow, 0.6s) var(--ds-ease-entrance, cubic-bezier(0.16,1,0.3,1)) both;\n  animation-delay: calc(var(--ds-stagger, 0ms) * var(--dsm-i, 0));\n}\n.dsl3__accent { width: 8px; background: var(--ds-grad, linear-gradient(135deg,#a855f7,#22d3ee)); }\n.dsl3__body { padding: 14px 28px 14px 20px; }\n.dsl3__name { font-size: 34px; font-weight: 800; color: var(--ds-text, #fff); letter-spacing: 0.2px; line-height: 1.1; }\n.dsl3__role { font-size: 16px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ds-accent, #22d3ee); margin-top: 4px; }\n@keyframes dsl3-in { from { opacity: 0; transform: translateX(-24px); } to { opacity: 1; transform: none; } }',
  variables: '{\n  "user": { "name": "Alex Ríos", "role": "Game Developer" }\n}',
};

const dsWebcamFrame: EditorTemplate = {
  id: 'ds-webcam-frame',
  name: 'DS · Marco de Webcam',
  description: 'Marco con borde de acento (centro transparente) + etiqueta en vivo.',
  html:
    '<div class="dscam">\n  <div class="dscam__frame"></div>\n  <div class="dscam__label" data-motion-pulse="flags.live"><span class="dscam__dot"></span>{{cam.label}}</div>\n</div>',
  css:
    '.dscam {\n  position: absolute; left: 80px; top: 80px; width: 680px; height: 383px;\n  font-family: var(--ds-font, system-ui, sans-serif);\n}\n.dscam__frame {\n  position: absolute; inset: 0; border-radius: var(--ds-radius, 16px); padding: 4px;\n  background: var(--ds-grad, linear-gradient(135deg,#a855f7,#22d3ee));\n  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);\n  -webkit-mask-composite: xor; mask-composite: exclude;\n  box-shadow: 0 0 26px var(--ds-glow, rgba(34,211,238,0.5));\n}\n.dscam__label {\n  position: absolute; left: 18px; bottom: 14px; display: flex; align-items: center; gap: 8px;\n  padding: 7px 15px; border-radius: 999px;\n  background: var(--ds-surface, rgba(17,18,27,0.92));\n  border: 1px solid var(--ds-border, rgba(168,85,247,0.35));\n  color: var(--ds-text, #fff); font-size: 15px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;\n  box-shadow: var(--ds-shadow, 0 8px 20px rgba(0,0,0,0.5));\n}\n.dscam__dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ds-accent, #22d3ee); box-shadow: 0 0 8px var(--ds-glow, rgba(34,211,238,0.6)); animation: dscam-pulse 1.4s ease-in-out infinite; }\n@keyframes dscam-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.45; transform: scale(0.7); } }',
  variables: '{\n  "cam": { "label": "En Vivo" }\n}',
};

const dsClock: EditorTemplate = {
  id: 'ds-clock',
  name: 'DS · Reloj',
  description: 'Reloj que avanza solo (data-clock) con el estilo del Design System.',
  html:
    '<div class="dsclk">\n  <span class="dsclk__icon">◷</span>\n  <div class="dsclk__body">\n    <div class="dsclk__time" data-clock="true">00:00:00</div>\n    <div class="dsclk__label">{{clock.label}}</div>\n  </div>\n</div>',
  css:
    '.dsclk {\n  position: absolute; right: 60px; top: 60px; display: flex; align-items: center; gap: 12px;\n  padding: 10px 20px 10px 14px;\n  background: var(--ds-surface, rgba(17,18,27,0.92));\n  border: 1px solid var(--ds-border, rgba(168,85,247,0.35));\n  border-radius: var(--ds-radius, 16px);\n  box-shadow: var(--ds-shadow, 0 12px 36px rgba(0,0,0,0.55));\n  font-family: var(--ds-font, system-ui, sans-serif);\n}\n.dsclk__icon { display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; background: var(--ds-grad, linear-gradient(135deg,#a855f7,#22d3ee)); color: var(--ds-on-accent, #0b0b16); font-size: 18px; }\n.dsclk__time { font-size: 30px; font-weight: 800; color: var(--ds-text, #fff); letter-spacing: 1px; font-variant-numeric: tabular-nums; line-height: 1; }\n.dsclk__label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ds-muted, #999); margin-top: 4px; }',
  variables: '{\n  "clock": { "label": "Hora Local" }\n}',
};

const dsLogoBadge: EditorTemplate = {
  id: 'ds-logo-badge',
  name: 'DS · Logo (badge)',
  description: 'Insignia circular con iniciales y anillo giratorio, en color del tema.',
  html:
    '<div class="dslogo">\n  <div class="dslogo__ring"></div>\n  <span class="dslogo__txt">{{brand.initials}}</span>\n</div>',
  css:
    '.dslogo {\n  position: absolute; left: 70px; top: 70px; width: 96px; height: 96px;\n  display: flex; align-items: center; justify-content: center; border-radius: 50%;\n  background: var(--ds-grad, linear-gradient(135deg,#a855f7,#22d3ee));\n  box-shadow: var(--ds-shadow, 0 10px 28px rgba(0,0,0,0.55)), 0 0 22px var(--ds-glow, rgba(34,211,238,0.5));\n  font-family: var(--ds-font, system-ui, sans-serif);\n}\n.dslogo__ring { position: absolute; inset: 5px; border-radius: 50%; border: 2px dashed rgba(255,255,255,0.42); animation: dslogo-spin 12s linear infinite; }\n.dslogo__txt { font-size: 38px; font-weight: 900; color: var(--ds-on-accent, #0b0b16); }\n@keyframes dslogo-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }',
  variables: '{\n  "brand": { "initials": "DP" }\n}',
};

const dsSocialBar: EditorTemplate = {
  id: 'ds-social-bar',
  name: 'DS · Barra Social',
  description: 'Pill con tus redes, con los acentos del Design System.',
  html:
    '<div class="dssoc">\n  <span class="dssoc__item"><span class="dssoc__ic">▶</span>{{social.twitch}}</span>\n  <span class="dssoc__sep"></span>\n  <span class="dssoc__item"><span class="dssoc__ic">●</span>{{social.youtube}}</span>\n  <span class="dssoc__sep"></span>\n  <span class="dssoc__item"><span class="dssoc__ic">✦</span>{{social.x}}</span>\n</div>',
  css:
    '.dssoc {\n  position: absolute; left: 610px; bottom: 48px; display: flex; align-items: center; gap: 8px;\n  padding: 10px 22px;\n  background: var(--ds-surface, rgba(17,18,27,0.92));\n  border: 1px solid var(--ds-border, rgba(168,85,247,0.35));\n  border-radius: 999px;\n  box-shadow: var(--ds-shadow, 0 12px 34px rgba(0,0,0,0.55));\n  font-family: var(--ds-font, system-ui, sans-serif);\n}\n.dssoc__item { display: flex; align-items: center; gap: 9px; font-size: 19px; font-weight: 600; color: var(--ds-text, #fff); padding: 2px 8px; }\n.dssoc__ic { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--ds-surface-2, rgba(255,255,255,0.08)); color: var(--ds-accent, #22d3ee); font-size: 13px; }\n.dssoc__sep { width: 1px; height: 22px; background: var(--ds-border, rgba(255,255,255,0.2)); }',
  variables: '{\n  "social": { "twitch": "twitch.tv/teamx", "youtube": "@TeamX", "x": "@teamx_live" }\n}',
};

const dsStats: EditorTemplate = {
  id: 'ds-stats',
  name: 'DS · Stats',
  description: 'Espectadores / seguidores / subs con el estilo del tema.',
  html:
    '<div class="dsstat">\n  <div class="dsstat__pill"><span class="dsstat__ic">◉</span><div class="dsstat__col"><span class="dsstat__v">{{stats.viewers}}</span><span class="dsstat__l">Espectadores</span></div></div>\n  <div class="dsstat__pill"><span class="dsstat__ic">♥</span><div class="dsstat__col"><span class="dsstat__v">{{stats.followers}}</span><span class="dsstat__l">Seguidores</span></div></div>\n  <div class="dsstat__pill"><span class="dsstat__ic">★</span><div class="dsstat__col"><span class="dsstat__v">{{stats.subs}}</span><span class="dsstat__l">Subs</span></div></div>\n</div>',
  css:
    '.dsstat {\n  position: absolute; left: 60px; bottom: 60px; display: flex; gap: 14px;\n  font-family: var(--ds-font, system-ui, sans-serif);\n}\n.dsstat__pill { display: flex; align-items: center; gap: 12px; padding: 12px 18px 12px 12px; background: var(--ds-surface, rgba(17,18,27,0.92)); border: 1px solid var(--ds-border, rgba(168,85,247,0.35)); border-radius: var(--ds-radius, 16px); box-shadow: var(--ds-shadow, 0 12px 34px rgba(0,0,0,0.55)); }\n.dsstat__ic { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 12px; background: var(--ds-grad, linear-gradient(135deg,#a855f7,#22d3ee)); color: var(--ds-on-accent, #0b0b16); font-size: 18px; }\n.dsstat__col { display: flex; flex-direction: column; line-height: 1.05; }\n.dsstat__v { font-size: 24px; font-weight: 800; color: var(--ds-text, #fff); font-variant-numeric: tabular-nums; }\n.dsstat__l { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--ds-muted, #999); }',
  variables: '{\n  "stats": { "viewers": "1.2K", "followers": "32.9K", "subs": "847" }\n}',
};

const dsLogoImage: EditorTemplate = {
  id: 'ds-logo-image',
  name: 'DS · Logo (imagen)',
  description: 'Logo a partir de una imagen (pega la URL en Contenido → brand.logoUrl).',
  html:
    `<div class="dslimg"><div class="dslimg__pic" data-style-templates='{"background-image":"url({{brand.logoUrl}})"}'></div></div>`,
  css:
    `.dslimg {
  position: absolute; left: 70px; top: 70px; width: 112px; height: 112px; padding: 5px; border-radius: 50%;
  background: var(--ds-grad, linear-gradient(135deg,#a855f7,#22d3ee));
  box-shadow: var(--ds-shadow, 0 10px 28px rgba(0,0,0,0.55)), 0 0 22px var(--ds-glow, rgba(34,211,238,0.5));
  font-family: var(--ds-font, system-ui, sans-serif);
}
.dslimg__pic {
  width: 100%; height: 100%; border-radius: 50%;
  background-color: var(--ds-surface, #111);
  background-size: cover; background-position: center; background-repeat: no-repeat;
  border: 2px solid rgba(255,255,255,0.25);
}`,
  variables: '{\n  "brand": { "logoUrl": "https://placehold.co/200x200/9333ea/ffffff?text=LOGO" }\n}',
};

const dsNowPlaying: EditorTemplate = {
  id: 'ds-now-playing',
  name: 'DS · Now Playing',
  description: 'Barra "now playing" con ecualizador animado. Usa el Design System activo.',
  html:
    '<div class="dsnp">\n  <div class="dsnp__icon"><span class="dsnp__glyph">&#9835;</span></div>\n  <div class="dsnp__eq" aria-hidden="true">\n    <span class="dsnp__bar dsnp__bar--1"></span>\n    <span class="dsnp__bar dsnp__bar--2"></span>\n    <span class="dsnp__bar dsnp__bar--3"></span>\n    <span class="dsnp__bar dsnp__bar--4"></span>\n  </div>\n  <div class="dsnp__info">\n    <span class="dsnp__label">NOW PLAYING</span>\n    <span class="dsnp__song">{{music.song}}</span>\n    <span class="dsnp__artist">{{music.artist}}</span>\n  </div>\n</div>',
  css:
    '.dsnp {\n  position: absolute; right: 60px; bottom: 60px;\n  display: flex; align-items: center; gap: 16px;\n  padding: 14px 22px 14px 14px; max-width: 460px;\n  background: var(--ds-surface, rgba(17,18,27,0.92));\n  border: 1px solid var(--ds-border, rgba(168,85,247,0.35));\n  border-radius: var(--ds-radius, 16px);\n  box-shadow: var(--ds-shadow, 0 12px 36px rgba(0,0,0,0.55));\n  font-family: var(--ds-font, system-ui, sans-serif);\n  color: var(--ds-text, #fff);\n  animation: dsnp-in var(--ds-dur-slow, 0.6s) var(--ds-ease-entrance, cubic-bezier(0.16,1,0.3,1)) both;\n  animation-delay: calc(var(--ds-stagger, 0ms) * var(--dsm-i, 0));\n}\n.dsnp__icon {\n  flex: 0 0 auto; width: 52px; height: 52px; display: flex; align-items: center; justify-content: center;\n  border-radius: var(--ds-radius, 12px);\n  background: var(--ds-grad, linear-gradient(135deg,#a855f7,#22d3ee));\n  box-shadow: 0 0 18px var(--ds-glow, rgba(34,211,238,0.5));\n}\n.dsnp__glyph { font-size: 28px; line-height: 1; color: var(--ds-on-accent, #fff); animation: dsnp-bob 2.4s ease-in-out infinite; }\n.dsnp__eq { flex: 0 0 auto; display: flex; align-items: flex-end; gap: 4px; height: 34px; }\n.dsnp__bar { width: 5px; border-radius: 3px; background: var(--ds-grad, linear-gradient(to top,#a855f7,#22d3ee)); transform-origin: bottom center; }\n.dsnp__bar--1 { height: 30%; animation: dsnp-eq 0.9s ease-in-out infinite; }\n.dsnp__bar--2 { height: 70%; animation: dsnp-eq 0.7s ease-in-out infinite 0.15s; }\n.dsnp__bar--3 { height: 45%; animation: dsnp-eq 1.05s ease-in-out infinite 0.3s; }\n.dsnp__bar--4 { height: 85%; animation: dsnp-eq 0.8s ease-in-out infinite 0.45s; }\n.dsnp__info { display: flex; flex-direction: column; min-width: 0; gap: 2px; }\n.dsnp__label { font-size: 11px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: var(--ds-accent, #22d3ee); }\n.dsnp__song { font-size: 19px; font-weight: 700; line-height: 1.2; color: var(--ds-text, #fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.dsnp__artist { font-size: 14px; font-weight: 500; line-height: 1.2; color: var(--ds-muted, rgba(255,255,255,0.72)); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n@keyframes dsnp-eq { 0%,100% { transform: scaleY(0.35); } 50% { transform: scaleY(1); } }\n@keyframes dsnp-bob { 0%,100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-3px) rotate(-6deg); } }\n@keyframes dsnp-in { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: none; } }',
  variables: '{\n  "music": { "song": "Midnight City", "artist": "M83" }\n}',
};

export const designComponents: EditorTemplate[] = [
  dsLowerThird, dsWebcamFrame, dsClock, dsLogoBadge, dsLogoImage, dsSocialBar, dsStats, dsNowPlaying,
  ...designComponentsExtra,
];
