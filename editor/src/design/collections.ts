// Curated layout packs. Each bundles a coordinated set of DS components with
// positions and a default design system (theme), so a user gets a whole themed
// overlay in one click.

export interface CollectionPreset {
  id: string;
  name: string;
  description: string;
  themeName: string; // must match a DesignTokens.name
  items: Array<{ templateId: string; x: number; y: number }>;
}

export const collectionPresets: CollectionPreset[] = [
  {
    id: 'pack-esports',
    name: 'Esports Completo',
    description: 'Logo, stats, cámara, lower third y reloj — tema Neon Esports.',
    themeName: 'Neon Esports',
    items: [
      { templateId: 'ds-logo-badge', x: 70, y: 70 },
      { templateId: 'ds-stats', x: 60, y: 200 },
      { templateId: 'ds-webcam-frame', x: 1170, y: 70 },
      { templateId: 'ds-lower-third', x: 80, y: 884 },
      { templateId: 'ds-clock', x: 1610, y: 984 },
    ],
  },
  {
    id: 'pack-charla',
    name: 'Charla Minimal',
    description: 'Logo, lower third, reloj y barra social — tema Minimal Light.',
    themeName: 'Minimal Light',
    items: [
      { templateId: 'ds-logo-badge', x: 70, y: 70 },
      { templateId: 'ds-clock', x: 1620, y: 70 },
      { templateId: 'ds-lower-third', x: 80, y: 900 },
      { templateId: 'ds-social-bar', x: 660, y: 980 },
    ],
  },
  {
    id: 'pack-game-night',
    name: 'Game Night',
    description: 'Cámara, stats, logo y reloj — tema Retro Arcade.',
    themeName: 'Retro Arcade',
    items: [
      { templateId: 'ds-webcam-frame', x: 70, y: 70 },
      { templateId: 'ds-logo-badge', x: 1760, y: 70 },
      { templateId: 'ds-stats', x: 60, y: 900 },
      { templateId: 'ds-clock', x: 1600, y: 984 },
    ],
  },
  {
    id: 'pack-esports-match',
    name: 'Esports · Partida',
    description: 'Marcador, casters, mapa/rondas, logo y cámara — Neon Esports.',
    themeName: 'Neon Esports',
    items: [
      { templateId: 'ds-match-score', x: 610, y: 46 },
      { templateId: 'ds-map-rounds', x: 60, y: 300 },
      { templateId: 'ds-caster-bar', x: 60, y: 930 },
      { templateId: 'ds-logo-badge', x: 70, y: 70 },
      { templateId: 'ds-webcam-frame', x: 1170, y: 130 },
    ],
  },
  {
    id: 'pack-esports-tournament',
    name: 'Torneo',
    description: 'Clasificación, premio, marcador y logo — Corporate Teal.',
    themeName: 'Corporate Teal',
    items: [
      { templateId: 'ds-standings', x: 60, y: 90 },
      { templateId: 'ds-prize-pool', x: 700, y: 70 },
      { templateId: 'ds-match-score', x: 640, y: 380 },
      { templateId: 'ds-logo-badge', x: 1780, y: 70 },
    ],
  },
  {
    id: 'pack-podcast',
    name: 'Podcast',
    description: 'Grabación + ecualizador, episodio, anfitrión/invitado y logo — Minimal Light.',
    themeName: 'Minimal Light',
    items: [
      { templateId: 'ds-recording', x: 70, y: 70 },
      { templateId: 'ds-logo-badge', x: 1780, y: 70 },
      { templateId: 'ds-host-guest', x: 80, y: 884 },
      { templateId: 'ds-topic-card', x: 560, y: 80 },
    ],
  },
  {
    id: 'pack-game-stream',
    name: 'Game Stream',
    description: 'Logo, stats, meta, lower third, social y cámara — Neon Esports.',
    themeName: 'Neon Esports',
    items: [
      { templateId: 'ds-logo-badge', x: 70, y: 70 },
      { templateId: 'ds-stats', x: 60, y: 200 },
      { templateId: 'ds-goal-bar', x: 60, y: 372 },
      { templateId: 'ds-lower-third', x: 80, y: 884 },
      { templateId: 'ds-social-bar', x: 640, y: 984 },
      { templateId: 'ds-webcam-frame', x: 1170, y: 70 },
    ],
  },
  {
    id: 'pack-small-talk',
    name: 'Small Talk',
    description: 'Lower third, tema, reloj, social y cámara — Minimal Light.',
    themeName: 'Minimal Light',
    items: [
      { templateId: 'ds-lower-third', x: 80, y: 890 },
      { templateId: 'ds-topic-card', x: 560, y: 70 },
      { templateId: 'ds-clock', x: 1620, y: 70 },
      { templateId: 'ds-social-bar', x: 660, y: 984 },
      { templateId: 'ds-webcam-frame', x: 1170, y: 140 },
    ],
  },
  {
    id: 'pack-webinar',
    name: 'Webinar',
    description: 'Tema actual, agenda, ponente y cuenta regresiva — Corporate Teal.',
    themeName: 'Corporate Teal',
    items: [
      { templateId: 'ds-topic-card', x: 420, y: 60 },
      { templateId: 'ds-agenda', x: 1430, y: 150 },
      { templateId: 'ds-speaker-card', x: 80, y: 890 },
      { templateId: 'ds-countdown', x: 1470, y: 60 },
    ],
  },
  {
    id: 'pack-videocall',
    name: 'Videollamada de Trabajo',
    description: 'Barra de reunión, nombre, micrófono y reloj — Corporate Teal.',
    themeName: 'Corporate Teal',
    items: [
      { templateId: 'ds-meeting-bar', x: 560, y: 40 },
      { templateId: 'ds-lower-third', x: 80, y: 890 },
      { templateId: 'ds-mute-status', x: 1640, y: 900 },
      { templateId: 'ds-clock', x: 1640, y: 70 },
    ],
  },
];
