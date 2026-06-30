import './style.css';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

type ThemeState = {
  name: string;
  marker: string;
  lowerTitle: string;
  lowerSubtitle: string;
  home: string;
  away: string;
  accent: string;
  accent2: string;
  text: string;
  muted: string;
  surface: string;
  surface2: string;
  border: string;
  glow: string;
  onAccent: string;
};

const themes: ThemeState[] = [
  {
    name: 'Broadcast',
    marker: 'Broadcast',
    lowerTitle: 'Grand Finals',
    lowerSubtitle: 'OverlayKit runtime · channel main',
    home: '12',
    away: '08',
    accent: '#22d3ee',
    accent2: '#7c3aed',
    text: '#f4f7fb',
    muted: 'rgba(244, 247, 251, 0.62)',
    surface: 'linear-gradient(180deg, rgba(18, 24, 38, 0.94) 0%, rgba(11, 15, 23, 0.96) 100%)',
    surface2: 'rgba(255, 255, 255, 0.06)',
    border: 'rgba(34, 211, 238, 0.28)',
    glow: 'rgba(34, 211, 238, 0.4)',
    onAccent: '#06121a',
  },
  {
    name: 'Playoff Heat',
    marker: 'Playoff',
    lowerTitle: 'Match Point',
    lowerSubtitle: 'Theme swap · scoreboard bump',
    home: '18',
    away: '17',
    accent: '#f97316',
    accent2: '#ef4444',
    text: '#fff7ed',
    muted: 'rgba(255, 237, 213, 0.68)',
    surface: 'linear-gradient(180deg, rgba(49, 18, 8, 0.94) 0%, rgba(18, 8, 8, 0.96) 100%)',
    surface2: 'rgba(249, 115, 22, 0.13)',
    border: 'rgba(251, 146, 60, 0.36)',
    glow: 'rgba(249, 115, 22, 0.42)',
    onAccent: '#140704',
  },
  {
    name: 'Signal Lime',
    marker: 'Signal',
    lowerTitle: 'Creator Spotlight',
    lowerSubtitle: 'Alert out · ticker stays live',
    home: '24',
    away: '21',
    accent: '#a3e635',
    accent2: '#14b8a6',
    text: '#f7fee7',
    muted: 'rgba(236, 252, 203, 0.68)',
    surface: 'linear-gradient(180deg, rgba(18, 32, 18, 0.94) 0%, rgba(7, 18, 15, 0.96) 100%)',
    surface2: 'rgba(163, 230, 53, 0.13)',
    border: 'rgba(190, 242, 100, 0.34)',
    glow: 'rgba(163, 230, 53, 0.38)',
    onAccent: '#081106',
  },
];

function qs<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function msToken(name: string, fallback: number): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value) return fallback;
  if (value.endsWith('ms')) return Number.parseFloat(value) / 1000;
  if (value.endsWith('s')) return Number.parseFloat(value);
  return fallback;
}

function applyTheme(root: HTMLElement, theme: ThemeState): void {
  root.style.setProperty('--ds-accent', theme.accent);
  root.style.setProperty('--ds-accent-2', theme.accent2);
  root.style.setProperty('--ds-grad', `linear-gradient(135deg, ${theme.accent2} 0%, ${theme.accent} 100%)`);
  root.style.setProperty('--ds-text', theme.text);
  root.style.setProperty('--ds-muted', theme.muted);
  root.style.setProperty('--ds-surface', theme.surface);
  root.style.setProperty('--ds-surface-2', theme.surface2);
  root.style.setProperty('--ds-border', theme.border);
  root.style.setProperty('--ds-glow', theme.glow);
  root.style.setProperty('--ds-on-accent', theme.onAccent);
}

function setupLandingPreview(): void {
  const root = qs<HTMLElement>('[data-preview-root]');
  const progress = qs<HTMLElement>('[data-timeline-progress]');
  const label = qs<HTMLElement>('[data-theme-label]');
  const marker = qs<HTMLElement>('[data-marker-label]');
  const lowerTitle = qs<HTMLElement>('[data-lower-title]');
  const lowerSubtitle = qs<HTMLElement>('[data-lower-subtitle]');
  const scoreHome = qs<HTMLElement>('[data-score-home]');
  const scoreAway = qs<HTMLElement>('[data-score-away]');
  const alert = qs<HTMLElement>('[data-alert]');
  const lower = qs<HTMLElement>('[data-lower-third]');
  const ticker = qs<HTMLElement>('[data-ticker]');
  const scoreboard = qs<HTMLElement>('[data-scoreboard]');
  const clock = qs<HTMLElement>('[data-clock]');

  if (!root || !progress || !label || !marker || !lowerTitle || !lowerSubtitle || !scoreHome || !scoreAway) {
    return;
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  applyTheme(root, themes[0]);

  const setState = (progressValue: number): void => {
    const nextTheme = progressValue > 0.68 ? themes[2] : progressValue > 0.36 ? themes[1] : themes[0];
    applyTheme(root, nextTheme);
    label.textContent = nextTheme.name;
    marker.textContent = nextTheme.marker;
    lowerTitle.textContent = nextTheme.lowerTitle;
    lowerSubtitle.textContent = nextTheme.lowerSubtitle;
    scoreHome.textContent = nextTheme.home;
    scoreAway.textContent = nextTheme.away;
    progress.style.transform = `scaleX(${Math.max(0.04, progressValue).toFixed(3)})`;
  };

  if (reducedMotion) {
    setState(1);
    return;
  }

  const fast = msToken('--ds-dur-fast', 0.14);
  const base = msToken('--ds-dur-base', 0.3);
  const slow = msToken('--ds-dur-slow', 0.52);

  gsap.set(alert, { autoAlpha: 0, xPercent: 24, scale: 0.96 });
  gsap.set([lower, ticker, scoreboard, clock], { transformOrigin: 'center center' });

  const tl = gsap.timeline({
    defaults: { ease: 'power3.out' },
    scrollTrigger: {
      trigger: '.hero-show',
      start: 'top top',
      end: '+=2600',
      scrub: 0.75,
      pin: true,
      anticipatePin: 1,
      onUpdate: (self) => setState(self.progress),
    },
  });

  tl
    .to(scoreboard, { y: -10, scale: 1.035, duration: slow }, 0)
    .to(clock, { y: -6, duration: base }, 0.05)
    .to(lower, { xPercent: 110, autoAlpha: 0, duration: slow }, 0.16)
    .fromTo(alert, { xPercent: 28, autoAlpha: 0, scale: 0.96 }, { xPercent: 0, autoAlpha: 1, scale: 1, duration: slow }, 0.32)
    .to(ticker, { y: -5, scale: 1.01, duration: base }, 0.42)
    .to(scoreboard, { scale: 1.13, duration: fast, yoyo: true, repeat: 1 }, 0.56)
    .to(alert, { xPercent: 42, autoAlpha: 0, scale: 0.98, duration: base }, 0.74)
    .fromTo(lower, { xPercent: 110, autoAlpha: 0 }, { xPercent: 0, autoAlpha: 1, duration: slow }, 0.82)
    .to(ticker, { y: 0, scale: 1, duration: base }, 0.9)
    .to(scoreboard, { y: 0, scale: 1, duration: slow }, 1);

  gsap.to('.feed-grid', {
    yPercent: 4,
    duration: 8,
    repeat: -1,
    yoyo: true,
    ease: 'sine.inOut',
  });

  gsap.to('.feed-bars span', {
    scaleY: () => gsap.utils.random(0.72, 1.18),
    transformOrigin: 'bottom center',
    duration: 1.4,
    repeat: -1,
    yoyo: true,
    stagger: 0.18,
    ease: 'sine.inOut',
  });
}

setupLandingPreview();
