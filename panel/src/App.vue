<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { extractVariableNames, isVisible, interpolate } from '@overlaykit/renderer/utils/interpolate';
import { SOUND_CATEGORY_ORDER, soundCategoryLabel } from '@overlaykit/renderer/utils/soundCategories';
import { StatusDot, Badge, Button } from '@overlaykit/ui';

const EDITOR_URL = (import.meta as any).env?.VITE_EDITOR_URL || 'http://localhost:5174';

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3000';
const WS_URL = (import.meta as any).env?.VITE_WS_URL || 'ws://localhost:8080';
const channelId = new URLSearchParams(location.search).get('channel') || 'main';
const embedded = new URLSearchParams(location.search).get('embedded') === 'true';
const exampleVar = '{{ ejemplo }}';

const status = ref<'disconnected' | 'connected'>('disconnected');
const elements = ref<any[]>([]);
// published = last-known SERVER truth (fed ONLY by incoming WebSocket, never by the UI).
const published = reactive<Record<string, any>>({});
// draft = the working copy the form controls bind to and mutate.
const draft = reactive<Record<string, any>>({});

let ws: WebSocket | null = null;
let reconnectT: ReturnType<typeof setTimeout> | null = null;

// conflict = paths a REMOTE operator published while we had a pending local edit
// on the same path. Latched until resolved (force-publish, discard, or accept).
interface ConflictPath { path: string; remote: any; mine: any }
const conflictPaths = ref<ConflictPath[]>([]);
const hasConflict = computed(() => conflictPaths.value.length > 0);
const showConflictDetail = ref(false);
const sceneSelRef = ref<HTMLSelectElement | null>(null);

function fmtVal(v: any): string {
  if (v === undefined || v === '') return '(vacío)';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

// ---- extract the variable paths used by the active scene's elements ----
function scan(s: unknown, set: Set<string>) {
  if (typeof s === 'string') extractVariableNames(s).forEach((p) => set.add(p));
}
function collect(el: any, set: Set<string>) {
  if (!el) return;
  scan(el.content, set);
  if (el.styles) for (const v of Object.values(el.styles)) scan(v, set);
  if (el.attributes) {
    scan(el.attributes['data-content-template'], set);
    const st = el.attributes['data-style-templates'];
    if (st) { try { Object.values(JSON.parse(st)).forEach((v) => scan(v, set)); } catch { /* ignore */ } }
  }
  if (Array.isArray(el.children)) for (const c of el.children) collect(c, set);
}
const paths = computed(() => {
  const set = new Set<string>();
  for (const el of elements.value) collect(el, set);
  return [...set].sort();
});

// ---- deep clone (structured copy via JSON, matches the push payload shape) ----
function clone<T>(obj: T): T {
  if (obj === undefined) return undefined as T;
  return JSON.parse(JSON.stringify(obj));
}

// ---- nested get/set by dot path ----
function getByPath(obj: any, p: string) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setByPath(obj: any, p: string, value: any) {
  const keys = p.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof o[keys[i]] !== 'object' || o[keys[i]] == null) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

// ---- infer a control type from the value + the leaf name ----
function controlType(p: string, value: any): string {
  const leaf = p.split('.').pop()!.toLowerCase();
  if (typeof value === 'boolean') return 'toggle';
  const isHex = typeof value === 'string' && /^#([0-9a-fA-F]{3,8})$/.test(value.trim());
  if (isHex || leaf.includes('color') || leaf === 'bg') return 'color';
  const numericLeaf = /(score|count|amount|points?|num(ber)?|total|viewers|temp|percent|level|round|qty|delay)/.test(leaf);
  if (typeof value === 'number' || (numericLeaf && value !== '' && !isNaN(Number(value)))) return 'number';
  const longText = typeof value === 'string' && (value.includes('\n') || value.length > 60);
  if (longText || /(question|message|msg|description|desc|subtitle|bio)/.test(leaf)) return 'textarea';
  return 'text';
}

const fields = computed(() =>
  paths.value.map((p) => {
    const value = getByPath(draft, p);
    return { path: p, type: controlType(p, value), value: value ?? '' };
  })
);

// ---- dirty tracking: dot-paths where draft differs from published ----
function sameValue(a: any, b: any): boolean {
  // deep, order-insensitive compare via canonical JSON (values are scalars/objects, no functions)
  if (a === b) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
const dirtyPaths = computed(() => {
  const set = new Set<string>();
  for (const p of paths.value) {
    if (!sameValue(getByPath(draft, p), getByPath(published, p))) set.add(p);
  }
  return set;
});
function isDirty(path: string): boolean {
  return dirtyPaths.value.has(path);
}
const dirtyCount = computed(() => dirtyPaths.value.size);

// group fields by their top-level key for a tidier UI
const groups = computed(() => {
  const m = new Map<string, typeof fields.value>();
  for (const f of fields.value) {
    const g = f.path.includes('.') ? f.path.split('.')[0] : '·';
    if (!m.has(g)) m.set(g, []);
    m.get(g)!.push(f);
  }
  return [...m.entries()].map(([name, items]) => ({ name, items }));
});

function sliderMax(value: any) {
  const n = Number(value) || 0;
  return Math.max(100, Math.ceil(n * 2));
}
function asHex(value: any) {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3,8})$/.test(value.trim()) ? value : '#000000';
}

// human-readable currently-published value for a path (what viewers see right now)
function publishedLabel(path: string): string {
  const v = getByPath(published, path);
  if (v === undefined || v === '') return '(vacío)';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
// title shown on each input: what viewers currently see vs the pending edit
function fieldTitle(path: string): string {
  return isDirty(path) ? `En producción: ${publishedLabel(path)}` : '';
}

// ---- editing -> writes ONLY to the local draft (no live push) ----
function onEdit(path: string, raw: any, type: string) {
  let value: any = raw;
  if (type === 'number') value = raw === '' ? '' : Number(raw);
  else if (type === 'toggle') value = !!raw;
  setByPath(draft, path, value);
}

// ---- publish the whole draft atomically (the only place that POSTs variables) ----
async function publish() {
  if (dirtyCount.value === 0) return;
  try {
    const res = await fetch(`${API}/api/variables`, { credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, variables: clone(draft) }),
    });
    if (res.ok) {
      // adopt draft as the new server truth so the button disables immediately;
      // the WS echo that follows is now a no-op (nothing dirty).
      reset(published, clone(draft));
      conflictPaths.value = [];
      showConflictDetail.value = false;
      flashPublished();
    }
  } catch { /* server offline */ }
}

// ---- revert local edits back to the last-published state ----
function discard() {
  reset(draft, clone(published));
  conflictPaths.value = [];
  showConflictDetail.value = false;
}

// Resolve one conflict by taking the server's value into the draft for that path
// (published already holds the remote value after applyIncoming).
function acceptRemote(c: ConflictPath) {
  setByPath(draft, c.path, clone(getByPath(published, c.path)));
  conflictPaths.value = conflictPaths.value.filter((x) => x.path !== c.path);
  if (!conflictPaths.value.length) showConflictDetail.value = false;
}

// ---- replace a reactive object's contents in place ----
function reset(target: Record<string, any>, source: Record<string, any>) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}

// ---- incoming server truth: always update `published`; reconcile `draft`
//      WITHOUT clobbering paths the local operator is still editing ----
function applyIncoming(v: Record<string, any>) {
  const dirty = dirtyPaths.value;
  // Detect conflicts BEFORE mutating `published`: if a path we're editing just
  // changed on the server to a value different from our pending edit, a remote
  // operator published over us. Latch it (merge with any existing conflicts).
  const merged = new Map(conflictPaths.value.map((c) => [c.path, c]));
  for (const p of dirty) {
    const oldPub = getByPath(published, p);
    const newPub = getByPath(v, p);
    const mine = getByPath(draft, p);
    if (!sameValue(oldPub, newPub) && !sameValue(newPub, mine)) {
      merged.set(p, { path: p, remote: clone(newPub), mine: clone(mine) });
    }
  }
  // clone so published and draft never alias the same nested object reference
  for (const k of Object.keys(v || {})) published[k] = clone(v[k]);
  // for every discovered path not currently dirty locally, mirror published -> draft
  // so a concurrent REMOTE operator's change appears in the form.
  for (const p of paths.value) {
    if (!dirty.has(p)) setByPath(draft, p, clone(getByPath(published, p)));
  }
  // keep only conflicts whose path is still pending locally
  conflictPaths.value = [...merged.values()].filter((c) => dirtyPaths.value.has(c.path));
}

// ---- Componentes (live show/hide) -------------------------------------------
// Walk the active scene's element tree and collect every layer that carries
// data-motion-show="<var.path>", so the operator can toggle each one live.
interface Showable { varPath: string; label: string; el: any }

// First non-empty text content found anywhere in a subtree — used as the row label.
function firstContent(el: any): string {
  if (!el || el.tag === 'style' || el.tag === 'script') return '';
  if (typeof el.content === 'string' && el.content.trim()) return el.content.trim();
  if (Array.isArray(el.children)) {
    for (const c of el.children) {
      const t = firstContent(c);
      if (t) return t;
    }
  }
  return '';
}
function labelFor(el: any): string {
  // Interpolate against the PUBLISHED (live) bag so a row shows "Alex Ríos" rather
  // than the raw "{{user.name}}" token the layer's content carries.
  const raw = firstContent(el);
  const text = raw ? interpolate(raw, published).trim() : '';
  if (text && !/^\{\{.*\}\}$/.test(text)) return text.length > 40 ? text.slice(0, 40) + '…' : text;
  return el?.attributes?.class || el?.id || 'componente';
}
function collectShowable(els: any[]): Showable[] {
  const out: Showable[] = [];
  const walk = (el: any) => {
    if (!el) return;
    const varPath = el.attributes?.['data-motion-show'];
    if (varPath) out.push({ varPath, label: labelFor(el), el });
    if (Array.isArray(el.children)) for (const c of el.children) walk(c);
  };
  for (const el of els) walk(el);
  return out;
}
const showables = computed<Showable[]>(() => collectShowable(elements.value));

// ---- panel state machine (drives header / banners / footer) -----------------
// offline takes precedence (connection lost), then conflict (remote diverged),
// then empty (no active scene), else draft/published by dirty count.
const hasScene = computed(() => elements.value.length > 0);
type PanelVariant = 'offline' | 'conflict' | 'empty' | 'published' | 'draft';
const panelVariant = computed<PanelVariant>(() => {
  if (status.value === 'disconnected') return 'offline';
  if (hasConflict.value) return 'conflict';
  if (!hasScene.value) return 'empty';
  return dirtyCount.value > 0 ? 'draft' : 'published';
});
const isOffline = computed(() => panelVariant.value === 'offline');
const headerDotState = computed<'connected' | 'offline' | 'idle'>(() =>
  panelVariant.value === 'offline' ? 'offline' : panelVariant.value === 'conflict' ? 'idle' : 'connected'
);
const headerDotLabel = computed(() =>
  panelVariant.value === 'offline'
    ? 'Conexión perdida'
    : panelVariant.value === 'conflict'
      ? 'Conflicto de versión'
      : `Conectado · ${channelId}`
);

function reconnect() {
  connect(); // clears the pending auto-retry timer + guards against a double socket
}
function openEditor() {
  window.open(EDITOR_URL, '_blank', 'noopener');
}
function focusSceneSwitcher() {
  sceneSelRef.value?.focus();
}

// Eye state reads the LIVE (published) truth via the bound flag path.
function isComponentVisible(varPath: string): boolean {
  return isVisible(getByPath(published, varPath));
}

// Build the nested flag object from a dot-path: 'flags.show_x' => { flags: { show_x: v } }.
function nestedFlag(path: string, value: any): Record<string, any> {
  const root: Record<string, any> = {};
  setByPath(root, path, value);
  return root;
}

// Toggling a component is an INTENTIONAL live action that BYPASSES the staging
// buffer: it deep-merges one flag into the channel's variables immediately. We
// also write the new value into BOTH published and draft so the UI reflects it at
// once without marking the path dirty.
async function toggleComponent(varPath: string) {
  const next = !isComponentVisible(varPath);
  // optimistic local update (keeps published === draft so it never goes dirty)
  setByPath(published, varPath, next);
  setByPath(draft, varPath, next);
  try {
    await fetch(`${API}/api/variables`, { credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, variables: nestedFlag(varPath, next) }),
    });
  } catch { /* server offline — local state already reflects intent */ }
}

// ---- Sonidos (live soundboard — bypasses staging) ---------------------------
// One-shot clips fetched from the bundled catalog. Clicking a clip fires it on
// the overlay LIVE via POST /api/sounds/play (an intentional immediate action,
// NOT a staged variable change), so every subscriber hears it in sync.
interface SoundClip { id: string; name: string; category: string; url: string; durationMs?: number }
const sounds = ref<SoundClip[]>([]);
const soundsFailed = ref(false);
const lastPlayedId = ref<string | null>(null);
let lastPlayedT: ReturnType<typeof setTimeout> | null = null;

// Category order + Spanish captions come from the shared sound vocabulary so the
// panel soundboard and the editor SoundPicker stay in lock-step.
const CATEGORY_ORDER = SOUND_CATEGORY_ORDER;
const categoryLabel = soundCategoryLabel;

// Group clips by category, ordered by CATEGORY_ORDER then alphabetically.
const soundGroups = computed(() => {
  const m = new Map<string, SoundClip[]>();
  for (const s of sounds.value) {
    const cat = s.category || 'otros';
    if (!m.has(cat)) m.set(cat, []);
    m.get(cat)!.push(s);
  }
  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  return [...m.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, clips]) => ({ category, label: categoryLabel(category), clips }));
});

async function loadSounds() {
  try {
    const res = await fetch(`${API}/api/sounds`, { credentials: 'include' });
    const j = await res.json();
    sounds.value = Array.isArray(j?.data?.sounds) ? j.data.sounds : [];
    soundsFailed.value = false;
  } catch {
    sounds.value = [];
    soundsFailed.value = true;
  }
}

async function playSound(clip: SoundClip) {
  // brief press feedback (highlight the clicked clip)
  lastPlayedId.value = clip.id;
  if (lastPlayedT) clearTimeout(lastPlayedT);
  lastPlayedT = setTimeout(() => { lastPlayedId.value = null; }, 450);
  try {
    await fetch(`${API}/api/sounds/play`, { credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, sound: { url: clip.url, volume: 0.6 } }),
    });
  } catch { /* server offline — nothing else to do for a one-shot */ }
}

// ---- Escenas (scene switcher — live activation) -----------------------------
// Lists saved collections; selecting one activates it on the overlay. The new
// elements/variables arrive back over WS (scene.activated / elements.updated),
// so the panel re-derives its variable controls + Componentes automatically.
interface Collection { id: string; name: string; channelId?: string }
const collections = ref<Collection[]>([]);
const sceneSel = ref('');          // currently-bound <select> value (collection id or '')
const activeSceneName = ref('');   // last successfully activated scene name (for confirmation)
const sceneJustSwitched = ref(false);
let sceneSwitchT: ReturnType<typeof setTimeout> | null = null;

async function loadCollections() {
  try {
    const res = await fetch(`${API}/api/collections?channelId=${encodeURIComponent(channelId)}`, { credentials: 'include' });
    const j = await res.json();
    collections.value = Array.isArray(j?.data?.collections) ? j.data.collections : [];
  } catch {
    collections.value = [];
  }
}

async function activateScene(id: string) {
  if (!id) return;
  const col = collections.value.find((c) => c.id === id);
  try {
    const res = await fetch(`${API}/api/collections/${encodeURIComponent(id)}/activate`, { credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId }),
    });
    if (res.ok) {
      activeSceneName.value = col?.name || id;
      sceneJustSwitched.value = true;
      if (sceneSwitchT) clearTimeout(sceneSwitchT);
      sceneSwitchT = setTimeout(() => { sceneJustSwitched.value = false; }, 1800);
      // keep the selected name shown (the WS echo will refresh elements/variables)
    } else {
      sceneSel.value = ''; // activation failed — revert to placeholder
    }
  } catch {
    sceneSel.value = '';
  }
}
function onSceneChange(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  sceneSel.value = id;
  activateScene(id);
}

// ---- websocket ----
function connect() {
  if (reconnectT) { clearTimeout(reconnectT); reconnectT = null; }
  // guard against opening a second socket (a manual Reintentar racing the 2s
  // auto-reconnect timer would otherwise double-connect).
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    status.value = 'connected';
    ws!.send(JSON.stringify({ type: 'subscribe', channelId }));
  };
  ws.onclose = () => {
    status.value = 'disconnected';
    reconnectT = setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    let m: any;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'subscription.confirmed') {
      elements.value = m.state?.elements || [];
      applyIncoming(m.state?.variables || {});
    } else if (m.type === 'elements.updated') {
      elements.value = m.elements || [];
      applyIncoming(m.variables || {});
    } else if (m.type === 'variables.update' || m.type === 'scene.activated') {
      if (m.type === 'scene.activated' && m.scene?.elements) elements.value = m.scene.elements;
      applyIncoming(m.variables || {});
    }
  };
}

// ---- transient "publicado ✓" confirmation ----
const justPushed = ref(false);
let publishedT: ReturnType<typeof setTimeout> | null = null;
function flashPublished() {
  justPushed.value = true;
  if (publishedT) clearTimeout(publishedT);
  publishedT = setTimeout(() => { justPushed.value = false; }, 1600);
}

// ---- keyboard: Cmd/Ctrl+Enter publishes (if dirty); Esc discards ----
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if (dirtyCount.value > 0) publish();
  } else if (e.key === 'Escape') {
    if (dirtyCount.value > 0) { e.preventDefault(); discard(); }
  }
}

onMounted(() => {
  connect();
  loadSounds();
  loadCollections();
  window.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  if (reconnectT) clearTimeout(reconnectT);
  if (publishedT) clearTimeout(publishedT);
  if (lastPlayedT) clearTimeout(lastPlayedT);
  if (sceneSwitchT) clearTimeout(sceneSwitchT);
  window.removeEventListener('keydown', onKeydown);
  ws?.close();
});
</script>

<template>
  <div class="panel">
    <header v-if="!embedded" class="hdr">
      <div class="brand">◆ Panel en vivo</div>
      <div class="hdr-right">
        <span class="chan">canal: <strong>{{ channelId }}</strong></span>
        <label v-if="collections.length" class="scene-switch">
          <span class="scene-label">Escena</span>
          <select ref="sceneSelRef" class="scene-sel" :value="sceneSel" @change="onSceneChange">
            <option value="">Cambiar escena…</option>
            <option v-for="c in collections" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <span class="scene-ok" :class="{ on: sceneJustSwitched }" :title="activeSceneName">✓ {{ activeSceneName }}</span>
        </label>
        <StatusDot :state="headerDotState" :label="headerDotLabel" />
      </div>
    </header>

    <!-- Offline: controls are paused; manual retry coexists with auto-reconnect. -->
    <div v-if="panelVariant === 'offline'" class="banner banner--offline">
      <span class="banner__icon">⚠</span>
      <span class="banner__text">Conexión perdida — los controles están en pausa hasta reconectar.</span>
      <Button variant="secondary" size="sm" @click="reconnect">Reintentar</Button>
    </div>
    <!-- Conflict: a remote operator published over a path we're editing. -->
    <div v-else-if="panelVariant === 'conflict'" class="banner banner--conflict">
      <span class="banner__icon">⚠</span>
      <span class="banner__text">Otro operador publicó cambios. Revisa antes de sobrescribir.</span>
      <Button variant="ghost" size="sm" @click="showConflictDetail = !showConflictDetail">
        {{ showConflictDetail ? 'Ocultar' : 'Ver cambios' }}
      </Button>
    </div>
    <div v-if="panelVariant === 'conflict' && showConflictDetail" class="conflict-detail">
      <div v-for="c in conflictPaths" :key="c.path" class="conflict-row">
        <code class="conflict-path">{{ c.path }}</code>
        <span class="conflict-vals">
          <span class="conflict-remote" title="valor publicado en el servidor">servidor: {{ fmtVal(c.remote) }}</span>
          <span class="conflict-mine" title="tu edición pendiente">tú: {{ fmtVal(c.mine) }}</span>
        </span>
        <Button variant="secondary" size="sm" @click="acceptRemote(c)">Usar la del servidor</Button>
      </div>
    </div>

    <main class="body">
      <!-- No active scene yet — guide the operator to pick or build one. -->
      <div v-if="panelVariant === 'empty'" class="empty-state">
        <div class="empty-glyph">◇</div>
        <div class="empty-title">Sin escena activa</div>
        <div class="empty-sub">Elige una escena para operar el directo, o crea una nueva en el editor.</div>
        <div class="empty-actions">
          <Button v-if="collections.length" variant="primary" size="sm" @click="focusSceneSwitcher">Elegir escena</Button>
          <Button variant="secondary" size="sm" @click="openEditor">Abrir editor</Button>
        </div>
      </div>

      <!-- Active content. Dimmed + inert while offline. -->
      <div v-else class="content" :class="{ 'is-dimmed': isOffline }">
      <!-- Componentes: live show/hide of every layer bound to data-motion-show.
           These eye toggles push LIVE immediately, bypassing the staging buffer. -->
      <section v-if="showables.length" class="components">
        <h2 class="components-title">🎬 Componentes</h2>
        <p class="components-hint">Muestra u oculta cada componente en producción al instante.</p>
        <div
          v-for="c in showables"
          :key="c.varPath"
          class="comp-row"
          :class="{ hidden: !isComponentVisible(c.varPath) }"
        >
          <span class="comp-label" :title="c.varPath">{{ c.label }}</span>
          <button
            class="eye-toggle"
            :class="{ off: !isComponentVisible(c.varPath) }"
            type="button"
            :title="isComponentVisible(c.varPath) ? 'Ocultar en producción' : 'Mostrar en producción'"
            :aria-pressed="isComponentVisible(c.varPath)"
            :aria-label="(isComponentVisible(c.varPath) ? 'Ocultar' : 'Mostrar') + ' ' + c.label"
            @click="toggleComponent(c.varPath)"
          >
            <span class="eye-glyph">{{ isComponentVisible(c.varPath) ? '👁' : '🚫' }}</span>
            <span class="eye-state">{{ isComponentVisible(c.varPath) ? 'Visible' : 'Oculto' }}</span>
          </button>
        </div>
      </section>

      <!-- Sonidos: live soundboard. Clips fire on the overlay immediately
           (POST /api/sounds/play), bypassing the staging buffer. -->
      <section v-if="sounds.length" class="sounds">
        <h2 class="sounds-title">🔊 Sonidos</h2>
        <p class="sounds-hint">Dispara un clip en producción al instante.</p>
        <div v-for="g in soundGroups" :key="g.category" class="sound-group">
          <h3 class="sound-cat">{{ g.label }}</h3>
          <div class="sound-grid">
            <button
              v-for="s in g.clips"
              :key="s.id"
              class="sound-btn"
              :class="{ played: lastPlayedId === s.id }"
              type="button"
              :title="s.name"
              @click="playSound(s)"
            >
              <span class="sound-name">{{ s.name }}</span>
              <span v-if="s.durationMs" class="sound-cap">{{ (s.durationMs / 1000).toFixed(1) }}s</span>
            </button>
          </div>
        </div>
      </section>
      <p v-else-if="soundsFailed" class="sounds-empty">Catálogo de sonidos no disponible.</p>

      <p v-if="hasScene && !fields.length" class="empty">
        No hay variables activas en el canal <strong>{{ channelId }}</strong>.<br />
        Envía una escena con variables (<code>{{ exampleVar }}</code>) desde el editor y aparecerán aquí.
      </p>

      <section v-for="group in groups" :key="group.name" class="group">
        <h2 class="group-name">{{ group.name }}</h2>
        <div class="field" v-for="f in group.items" :key="f.path" :class="{ dirty: isDirty(f.path) }">
          <label class="field-label" :title="isDirty(f.path) ? f.path + ' — en producción: ' + publishedLabel(f.path) : f.path">
            <span v-if="isDirty(f.path)" class="dirty-dot" title="cambio sin publicar"></span>{{ f.path }}
          </label>

          <!-- toggle -->
          <label v-if="f.type === 'toggle'" class="switch" :title="fieldTitle(f.path)">
            <input type="checkbox" :checked="!!f.value" @change="onEdit(f.path, ($event.target as HTMLInputElement).checked, 'toggle')" />
            <span class="track"></span>
          </label>

          <!-- number: slider + number -->
          <div v-else-if="f.type === 'number'" class="num" :title="fieldTitle(f.path)">
            <input type="range" min="0" :max="sliderMax(f.value)" step="1" :value="Number(f.value) || 0"
              @input="onEdit(f.path, ($event.target as HTMLInputElement).value, 'number')" />
            <input class="num-in" type="number" :value="f.value"
              @input="onEdit(f.path, ($event.target as HTMLInputElement).value, 'number')" />
          </div>

          <!-- color: picker + raw text -->
          <div v-else-if="f.type === 'color'" class="color" :title="fieldTitle(f.path)">
            <input type="color" :value="asHex(f.value)" @input="onEdit(f.path, ($event.target as HTMLInputElement).value, 'color')" />
            <input class="color-in" type="text" :value="f.value" placeholder="#fff / rgba(...)"
              @input="onEdit(f.path, ($event.target as HTMLInputElement).value, 'color')" />
          </div>

          <!-- textarea -->
          <textarea v-else-if="f.type === 'textarea'" rows="3" :value="f.value" :title="fieldTitle(f.path)"
            @input="onEdit(f.path, ($event.target as HTMLTextAreaElement).value, 'textarea')"></textarea>

          <!-- text -->
          <input v-else type="text" :value="f.value" :title="fieldTitle(f.path)"
            @input="onEdit(f.path, ($event.target as HTMLInputElement).value, 'text')" />
        </div>
      </section>

      </div>
    </main>

    <footer v-if="panelVariant !== 'empty'" class="ftr">
      <div class="ftr-left">
        <span class="count">{{ fields.length }} variable(s)</span>
        <Badge v-if="panelVariant === 'offline'" tone="neutral" dot>Sin conexión</Badge>
        <Badge v-else-if="panelVariant === 'conflict'" tone="danger" dot>Conflicto · {{ conflictPaths.length }}</Badge>
        <Badge v-else-if="panelVariant === 'draft'" tone="draft" dot>Borrador · {{ dirtyCount }}</Badge>
        <Badge v-else tone="published" dot>Publicado</Badge>
        <span class="saved" :class="{ on: justPushed }">publicado ✓</span>
      </div>
      <div class="ftr-actions">
        <template v-if="panelVariant === 'offline'">
          <Button variant="secondary" size="sm" @click="reconnect">Reintentar</Button>
          <Button variant="primary" size="sm" disabled>Publicar en vivo</Button>
        </template>
        <template v-else-if="panelVariant === 'conflict'">
          <Button variant="ghost" size="sm" @click="showConflictDetail = !showConflictDetail">Ver cambios</Button>
          <Button variant="danger" size="sm" @click="publish">Forzar publicación</Button>
        </template>
        <template v-else>
          <Button variant="secondary" size="sm" :disabled="dirtyCount === 0" @click="discard">Descartar</Button>
          <Button variant="primary" size="sm" :disabled="dirtyCount === 0" @click="publish">
            {{ dirtyCount > 0 ? `Publicar cambios (${dirtyCount})` : 'Publicar cambios' }}
          </Button>
        </template>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; height: 100vh; }
.hdr {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--surface);
}
.brand { font-weight: 800; }
.hdr-right { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); }
.chan strong { color: var(--ink); }
/* Scene switcher (header) */
.scene-switch { display: inline-flex; align-items: center; gap: 7px; }
.scene-label { font-size: 12px; color: var(--muted); }
.scene-sel {
  background: var(--surface-inset); border: 1px solid var(--input-border); color: var(--ink);
  border-radius: var(--radius-sm); padding: 6px 10px; font-size: 13px; font-family: inherit; cursor: pointer;
}
.scene-sel:focus { outline: none; border-color: var(--app-accent); }
.scene-sel:focus-visible { outline: none; box-shadow: var(--focus-ring); border-color: var(--app-accent); }
.scene-ok {
  font-size: 12px; font-weight: 600; color: var(--state-published); max-width: 120px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  opacity: 0; transition: opacity .2s;
}
.scene-ok.on { opacity: 1; }
.body { flex: 1; overflow-y: auto; padding: 16px 20px; }

.empty { color: var(--muted); text-align: center; margin-top: 60px; line-height: 1.7; }

/* Componentes (live show/hide) */
.components { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin-bottom: 18px; }
.components-title { margin: 0 0 4px; font-size: 14px; }
.components-hint { margin: 0 0 10px; font-size: 12px; color: var(--muted); }
.comp-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 4px; border-bottom: 1px solid var(--line);
}
.comp-row:last-child { border-bottom: none; }
.comp-label {
  font-size: 13px; color: var(--ink); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; transition: color .15s, opacity .15s;
}
.comp-row.hidden .comp-label { color: var(--muted); opacity: .7; }
.eye-toggle {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px;
  background: var(--app-raised); border: 1px solid var(--line); color: var(--ink);
  border-radius: var(--radius-pill); padding: 6px 14px 6px 12px; cursor: pointer;
  font-size: 12px; font-weight: 600; font-family: inherit;
  transition: border-color .15s, background .15s, filter .15s, transform .08s;
}
.eye-toggle:hover { filter: brightness(1.12); }
.eye-toggle:active { transform: scale(.95); }
.eye-toggle:focus-visible { outline: none; box-shadow: var(--focus-ring); }
/* visible: accent ring; hidden: muted + struck glyph */
.eye-toggle:not(.off) { border-color: var(--app-accent); box-shadow: 0 0 0 1px var(--app-accent) inset; }
.eye-toggle.off { color: var(--muted); }
.eye-glyph { font-size: 15px; line-height: 1; transition: transform .2s ease, opacity .2s; }
.eye-toggle:not(.off) .eye-glyph { transform: scale(1.06); }
.eye-toggle.off .eye-glyph { opacity: .8; }
.eye-state { letter-spacing: .02em; }

/* Sonidos (live soundboard) */
.sounds { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin-bottom: 18px; }
.sounds-title { margin: 0 0 4px; font-size: 14px; }
.sounds-hint { margin: 0 0 12px; font-size: 12px; color: var(--muted); }
.sounds-empty { color: var(--muted); font-size: 12px; margin: 0 0 18px; }
.sound-group { margin-bottom: 14px; }
.sound-group:last-child { margin-bottom: 0; }
.sound-cat { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--accent-2); margin: 0 0 8px; }
.sound-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
.sound-btn {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  background: var(--app-raised); border: 1px solid var(--line); color: var(--ink);
  border-radius: var(--radius-md); padding: 9px 12px; cursor: pointer; text-align: left;
  font-family: inherit; transition: border-color .15s, background .15s, transform .08s, box-shadow .15s;
}
.sound-btn:hover { border-color: var(--app-accent); background: var(--app-hover); }
.sound-btn:active { transform: scale(.96); }
.sound-btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.sound-btn.played { border-color: var(--app-accent); box-shadow: 0 0 0 2px var(--app-accent) inset; background: var(--app-accent-quiet); }
.sound-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.sound-cap { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }

.group { margin-bottom: 22px; }
.group-name { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--accent-2); margin: 0 0 10px; }
.field { display: grid; grid-template-columns: 220px 1fr; gap: 14px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line); }
.field-label { display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.field.dirty .field-label { color: var(--ink); }
.dirty-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: var(--radius-pill); background: var(--state-draft); box-shadow: 0 0 6px rgba(245, 158, 11, .6); }
input[type="text"], input[type="number"], textarea {
  width: 100%; background: var(--surface-inset); border: 1px solid var(--input-border); color: var(--ink);
  border-radius: var(--radius-sm); padding: 8px 10px; font-size: 14px; font-family: inherit;
}
textarea { resize: vertical; }
input:focus, textarea:focus { outline: none; border-color: var(--app-accent); }
input:focus-visible, textarea:focus-visible { outline: none; box-shadow: var(--focus-ring); border-color: var(--app-accent); }
.num { display: flex; align-items: center; gap: 12px; }
.num input[type="range"] { flex: 1; accent-color: var(--control-fill); }
.num-in { width: 90px; flex: 0 0 auto; }
.color { display: flex; align-items: center; gap: 10px; }
.color input[type="color"] { width: 40px; height: 32px; border: 1px solid var(--input-border); border-radius: var(--radius-sm); background: var(--surface-inset); padding: 2px; cursor: pointer; }
.color-in { flex: 1; }
.switch { position: relative; display: inline-block; width: 48px; height: 26px; cursor: pointer; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .track { position: absolute; inset: 0; background: var(--control-track); border-radius: var(--radius-pill); transition: .2s; }
.switch .track::before { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; background: var(--app-ink-bright); border-radius: var(--radius-pill); transition: .2s; }
.switch input:checked + .track { background: var(--control-fill); }
.switch input:focus-visible + .track { box-shadow: var(--focus-ring); }
.switch input:checked + .track::before { transform: translateX(22px); }
.ftr {
  position: sticky; bottom: 0; z-index: 5;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 12px 20px; border-top: 1px solid var(--line); background: var(--surface);
  font-size: 12px; color: var(--muted);
}
.ftr-left { display: flex; align-items: center; gap: 14px; min-width: 0; }
.saved { opacity: 0; transition: opacity .2s; color: var(--state-published); font-weight: 600; }
.saved.on { opacity: 1; }
.ftr-actions { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }

/* ---- state banners (offline / conflict) ---- */
.banner {
  display: flex; align-items: center; gap: 10px;
  padding: 11px 20px; font-size: 13px; border-bottom: 1px solid var(--line);
}
.banner__icon { font-size: 14px; flex: 0 0 auto; }
.banner__text { flex: 1; min-width: 0; }
.banner--offline { background: var(--tint-draft); color: var(--amber-300); }
.banner--conflict { background: var(--tint-danger); color: #fca5a5; }

.conflict-detail {
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 20px 14px; background: var(--surface-inset); border-bottom: 1px solid var(--line);
}
.conflict-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.conflict-path { font-family: var(--font-mono); font-size: 12px; color: var(--app-muted); flex: 0 0 auto; }
.conflict-vals { display: flex; gap: 14px; font-size: 12px; flex: 1; min-width: 0; flex-wrap: wrap; }
.conflict-remote { color: #fca5a5; }
.conflict-mine { color: var(--cyan-300); }

/* ---- content dimming while offline ---- */
.content.is-dimmed { opacity: .55; pointer-events: none; filter: saturate(.7); }

/* ---- empty state (no active scene) ---- */
.empty-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; min-height: 60vh; gap: 6px;
}
.empty-glyph { font-size: 38px; opacity: .4; margin-bottom: 6px; }
.empty-title { font-size: 18px; font-weight: 700; color: var(--ink); }
.empty-sub { font-size: 13px; color: var(--muted); max-width: 280px; line-height: 1.6; }
.empty-actions { display: flex; gap: 8px; margin-top: 16px; }
</style>
