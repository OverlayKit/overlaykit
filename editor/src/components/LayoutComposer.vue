<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import ElementRenderer from '@overlaykit/renderer/components/ElementRenderer.vue';
import { ElementNode } from '@overlaykit/renderer/types/element';
import { parseHtmlToElements, createStyleElement } from '../utils/converter';
import { templateCategories, type EditorTemplate } from '../templates';
import { designSystems, tokensToCss, normalizeTokens, type DesignTokens } from '../design/tokens';
import { injectMotionPatterns } from '@overlaykit/renderer/services/motionPatterns';
import { isVisible } from '@overlaykit/renderer/utils/interpolate';
import { collectionPresets, type CollectionPreset } from '../design/collections';
import { useStageZoom } from '../composables/useStageZoom';
import { Button } from '@overlaykit/ui';

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3000';
// Canvas orientation: landscape (16:9) or portrait (9:16, for mobile / Shorts).
const orientation = ref<'landscape' | 'portrait'>('landscape');
const canvas = computed(() => (orientation.value === 'portrait' ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 }));
const STORAGE_KEY = 'overlaykit:collections';

// ---- a placed component instance ----
interface LayoutItem {
  id: string;
  templateId: string;
  name: string;
  html: string;
  css: string;
  varsObj: Record<string, any>;
  styleEl: ElementNode;     // <style> node (cached)
  els: ElementNode[];       // overridden + re-id'd component roots (cached)
  pos: { x: number; y: number };
  showVar?: string;         // when set, this layer's visibility is bound to that var
                            // (data-motion-show) — animated hide/show, toggled live.
}
interface SavedCollection {
  id: string;
  name: string;
  channelId: string;
  theme: DesignTokens | null;
  items: Array<{ templateId: string; name: string; html: string; css: string; vars: string; pos: { x: number; y: number }; showVar?: string }>;
}

const items = ref<LayoutItem[]>([]);
const selectedId = ref<string | null>(null);
const channelId = ref(new URLSearchParams(location.search).get('channel') || 'main');
const showId = new URLSearchParams(location.search).get('show');
const collectionName = ref('Mi Layout');
const savedCollections = ref<SavedCollection[]>([]);
const isSending = ref(false);
const toast = ref<{ message: string; type: 'success' | 'error' } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

const selected = computed(() => items.value.find((i) => i.id === selectedId.value) || null);
// Deep-merge each component's variables so two components that share a top-level
// namespace (e.g. quiz.question + quiz.optionA, or match.stage + match.label)
// combine instead of clobbering each other.
const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...a };
  for (const k of Object.keys(b || {})) {
    out[k] = isObj(out[k]) && isObj(b[k]) ? deepMerge(out[k], b[k]) : b[k];
  }
  return out;
}
const mergedVars = computed(() => items.value.reduce((acc, i) => deepMerge(acc, i.varsObj), {} as Record<string, any>));

// ---- per-component content editor: edit the selected component's variables ----
function setByPath(obj: any, path: string, value: any) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isObj(o[keys[i]])) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}
const selectedFields = computed(() => {
  const item = selected.value;
  if (!item) return [] as Array<{ path: string; leaf: string; value: string; long: boolean }>;
  const out: Array<{ path: string; leaf: string; value: string; long: boolean }> = [];
  const walk = (obj: any, prefix: string) => {
    for (const k of Object.keys(obj || {})) {
      const v = obj[k];
      const path = prefix ? `${prefix}.${k}` : k;
      if (isObj(v)) walk(v, path);
      else out.push({ path, leaf: k, value: String(v ?? ''), long: typeof v === 'string' && (v.length > 22 || /url|logo|image|img/i.test(k)) });
    }
  };
  walk(item.varsObj, '');
  return out;
});
function editVar(path: string, value: string) {
  if (selected.value) setByPath(selected.value.varsObj, path, value);
}
const flatTemplates = computed(() => templateCategories.flatMap((c) => c.templates.map((t) => ({ cat: c.name, t }))));

// ---- design system (theme) state ----
const customThemes = ref<DesignTokens[]>([]);
const activeThemeName = ref<string>('');
const WS_URL = (import.meta as any).env?.VITE_WS_URL || 'ws://localhost:8080';
const wsConnected = ref(false);
const lastRemoteTheme = ref('');
let composerWs: WebSocket | null = null;
let composerReconnect: ReturnType<typeof setTimeout> | null = null;
let composerWsClosed = false;
const allThemes = computed<DesignTokens[]>(() => [...designSystems, ...customThemes.value]);
const activeTokens = computed<DesignTokens | null>(() => allThemes.value.find((t) => t.name === activeThemeName.value) || null);
// the <style> that defines --ds-* for the active theme; shipped in the scene too
const themeStyleEl = computed<ElementNode | null>(() =>
  activeTokens.value ? { id: 'ds-theme', tag: 'style', content: tokensToCss(activeTokens.value), styles: {} } : null
);
function applyTheme(name: string) { activeThemeName.value = name; }
function clearTheme() { activeThemeName.value = ''; }

function templateById(id: string): EditorTemplate | null {
  for (const c of templateCategories) { const t = c.templates.find((x) => x.id === id); if (t) return t; }
  return null;
}
function loadPreset(p: CollectionPreset) {
  const next: LayoutItem[] = [];
  for (const it of p.items) {
    const t = templateById(it.templateId); if (!t) continue;
    const item = makeItem(t); item.pos = { x: it.x, y: it.y }; next.push(item);
  }
  items.value = next;
  activeThemeName.value = p.themeName;
  collectionName.value = p.name;
  selectedId.value = null;
  showToast(`Pack "${p.name}" cargado`, 'success');
}
// A design system pushed through the local API arrives over WebSocket and is applied instantly.
function receiveDesignSystem(ds: any) {
  if (!ds || !ds.tokens) return;
  const t = normalizeTokens(ds.tokens, ds.name || 'Tema IA');
  const idx = customThemes.value.findIndex((x) => x.name === t.name);
  if (idx >= 0) customThemes.value[idx] = t; else customThemes.value.push(t);
  activeThemeName.value = t.name;
  lastRemoteTheme.value = t.name;
  showToast(`Tema "${t.name}" recibido ✓`, 'success');
}
function connectComposerWs() {
  composerWs = new WebSocket(WS_URL);
  composerWs.onopen = () => { wsConnected.value = true; composerWs!.send(JSON.stringify({ type: 'subscribe', channelId: channelId.value })); };
  composerWs.onclose = () => { wsConnected.value = false; if (!composerWsClosed) composerReconnect = setTimeout(connectComposerWs, 2000); };
  composerWs.onmessage = (e) => {
    let m: any; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'subscription.confirmed' && m.state?.designSystem) receiveDesignSystem(m.state.designSystem);
    else if (m.type === 'design.system') receiveDesignSystem(m.designSystem);
  };
}

function showToast(message: string, type: 'success' | 'error') {
  toast.value = { message, type };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = null; }, 2600);
}

// ---- build the render model for an item: positioned roots that ignore their
// own absolute anchoring so the layout wrapper controls placement ----
const RESET: Record<string, string> = {
  position: 'relative', left: 'auto', top: 'auto', right: 'auto', bottom: 'auto', margin: '0',
};
function prepare(raw: ElementNode[], itemId: string): ElementNode[] {
  let n = 0;
  const walk = (el: ElementNode, isRoot: boolean): ElementNode => ({
    ...el,
    id: `${itemId}__${n++}`,
    styles: isRoot ? { ...(el.styles || {}), ...RESET } : { ...(el.styles || {}) },
    children: el.children ? el.children.map((c) => walk(c, false)) : undefined,
  });
  return raw.map((el) => walk(el, true));
}

function makeItem(t: EditorTemplate): LayoutItem {
  const id = `it-${Date.now()}-${seq++}`;
  let varsObj: Record<string, any> = {};
  try { varsObj = JSON.parse(t.variables); } catch { /* ignore */ }
  const styleEl: ElementNode = { ...createStyleElement(t.css), id: `style-${id}` };
  const els = prepare(parseHtmlToElements(t.html), id);
  // stagger new items so they don't stack exactly
  const n = items.value.length;
  return {
    id, templateId: t.id, name: t.name, html: t.html, css: t.css, varsObj, styleEl, els,
    pos: { x: 80 + (n % 6) * 60, y: 80 + (n % 6) * 50 },
  };
}
function renderModel(item: LayoutItem): ElementNode[] {
  return [item.styleEl, ...item.els];
}

// ---- palette ----
function addComponent(t: EditorTemplate) {
  const item = makeItem(t);
  items.value.push(item);
  selectedId.value = item.id;
}

// ---- layer ops ----
function selectItem(id: string) { selectedId.value = id; }
function removeItem(id: string) {
  items.value = items.value.filter((i) => i.id !== id);
  if (selectedId.value === id) selectedId.value = null;
}
function duplicateItem(item: LayoutItem) {
  const copy = makeItem({ id: item.templateId, name: item.name, html: item.html, css: item.css, variables: JSON.stringify(item.varsObj) } as EditorTemplate);
  copy.pos = { x: item.pos.x + 32, y: item.pos.y + 32 };
  const idx = items.value.findIndex((i) => i.id === item.id);
  items.value.splice(idx + 1, 0, copy);
  selectedId.value = copy.id;
}
function move(item: LayoutItem, dir: -1 | 1) {
  const idx = items.value.findIndex((i) => i.id === item.id);
  const j = idx + dir;
  if (j < 0 || j >= items.value.length) return;
  const arr = items.value.slice();
  [arr[idx], arr[j]] = [arr[j], arr[idx]];
  items.value = arr;
}

// ---- animated visibility (eye toggle) ----
// The layer wrapper carries data-motion-show="<var>"; the shared renderer fades+slides
// it out when the var is falsy. The flag lives in the item's varsObj (default true), so
// it ships in the scene variables and is toggleable live from the panel or an action.
function getByPath(obj: any, p: string): any {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
// Use the shared visibility rule so the composer preview agrees with production:
// empty / unset => VISIBLE; only the explicit falsy tokens hide.
function layerHidden(item: LayoutItem): boolean {
  return item.showVar ? !isVisible(getByPath(item.varsObj, item.showVar)) : false;
}
// One-click eye: lazily binds the layer to its show flag on first use (so the streamer
// never thinks about a variable) and flips it. The binding ships in the scene and stays
// toggleable live.
function toggleLayerEye(item: LayoutItem): void {
  if (!item.showVar) {
    item.showVar = `flags.show_${item.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    setByPath(item.varsObj, item.showVar, true); // bound visible by default
  }
  setByPath(item.varsObj, item.showVar, layerHidden(item)); // flip: hidden→show(true), visible→hide(false)
}

// ---- positioning ----
function clampPos(item: LayoutItem) {
  item.pos.x = Math.round(item.pos.x);
  item.pos.y = Math.round(item.pos.y);
}
function layerSize(id: string): { w: number; h: number } {
  const el = document.querySelector(`[data-layer="${id}"]`) as HTMLElement | null;
  if (!el) return { w: 0, h: 0 };
  const r = el.getBoundingClientRect();
  return { w: r.width / scale.value, h: r.height / scale.value };
}
function anchor(hp: 'l' | 'c' | 'r', vp: 't' | 'm' | 'b') {
  const item = selected.value; if (!item) return;
  const { w, h } = layerSize(item.id);
  const m = 24;
  item.pos.x = hp === 'l' ? m : hp === 'c' ? Math.round((canvas.value.w - w) / 2) : Math.round(canvas.value.w - w - m);
  item.pos.y = vp === 't' ? m : vp === 'm' ? Math.round((canvas.value.h - h) / 2) : Math.round(canvas.value.h - h - m);
}

// ---- drag ----
const drag = reactive({ active: false, id: '', sx: 0, sy: 0, ox: 0, oy: 0 });
function onDown(item: LayoutItem, e: MouseEvent) {
  selectedId.value = item.id;
  drag.active = true; drag.id = item.id; drag.sx = e.clientX; drag.sy = e.clientY; drag.ox = item.pos.x; drag.oy = item.pos.y;
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}
function onMove(e: MouseEvent) {
  if (!drag.active) return;
  const item = items.value.find((i) => i.id === drag.id); if (!item) return;
  item.pos.x = Math.round(drag.ox + (e.clientX - drag.sx) / scale.value);
  item.pos.y = Math.round(drag.oy + (e.clientY - drag.sy) / scale.value);
}
function onUp() {
  drag.active = false;
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
}

// ---- collections (localStorage) ----
function loadSaved() {
  try { savedCollections.value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { savedCollections.value = []; }
}
function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(savedCollections.value)); }
function saveCollection() {
  const name = collectionName.value.trim() || 'Sin nombre';
  const payload: SavedCollection = {
    id: 'col-' + name.toLowerCase().replace(/\s+/g, '-'),
    name, channelId: channelId.value,
    theme: activeTokens.value,
    items: items.value.map((i) => ({ templateId: i.templateId, name: i.name, html: i.html, css: i.css, vars: JSON.stringify(i.varsObj), pos: { ...i.pos }, ...(i.showVar ? { showVar: i.showVar } : {}) })),
  };
  const idx = savedCollections.value.findIndex((c) => c.id === payload.id);
  if (idx >= 0) savedCollections.value[idx] = payload; else savedCollections.value.push(payload);
  persist();
  showToast(`Colección "${name}" guardada`, 'success');
}
function loadCollection(c: SavedCollection) {
  collectionName.value = c.name;
  channelId.value = c.channelId || 'main';
  if (c.theme) {
    if (!allThemes.value.some((t) => t.name === c.theme!.name)) customThemes.value.push(c.theme);
    activeThemeName.value = c.theme.name;
  } else {
    activeThemeName.value = '';
  }
  items.value = c.items.map((s) => {
    const item = makeItem({ id: s.templateId, name: s.name, html: s.html, css: s.css, variables: s.vars } as EditorTemplate);
    item.pos = { ...s.pos };
    if (s.showVar) item.showVar = s.showVar;
    return item;
  });
  selectedId.value = null;
  showToast(`Colección "${c.name}" cargada`, 'success');
}
function deleteCollection(c: SavedCollection) {
  savedCollections.value = savedCollections.value.filter((x) => x.id !== c.id);
  persist();
}
function newCollection() { items.value = []; selectedId.value = null; collectionName.value = 'Mi Layout'; }

// ---- activate: send the whole layout as one scene ----
// Build the activatable scene from the current layout (positioned layers + the
// active theme's --ds-* tokens first). Shared by activate() and saveToServer().
function buildScene() {
  const layers: ElementNode[] = items.value.map((item, i) => ({
    id: `layer-${item.id}`,
    tag: 'div',
    styles: { position: 'absolute', left: `${item.pos.x}px`, top: `${item.pos.y}px`, zIndex: String(i + 1) },
    ...(item.showVar ? { attributes: { 'data-motion-show': item.showVar } } : {}),
    children: renderModel(item),
  }));
  const elements: ElementNode[] = themeStyleEl.value ? [themeStyleEl.value, ...layers] : layers;
  // Persist the canvas orientation so the server, overlay and every preview
  // size the stage (16:9 / 9:16) from the scene itself.
  return { id: 'layout-' + collectionName.value.toLowerCase().replace(/\s+/g, '-'), name: collectionName.value, elements, orientation: orientation.value };
}

async function activate() {
  if (!items.value.length) { showToast('Agrega componentes primero', 'error'); return; }
  const body = showId
    ? JSON.stringify({ variables: mergedVars.value, scene: buildScene() })
    : JSON.stringify({ channelId: channelId.value, clearPrevious: true, variables: mergedVars.value, scene: buildScene() });
  const path = showId
    ? `/api/shows/${encodeURIComponent(showId)}/production/preview`
    : '/api/scenes/activate';
  isSending.value = true;
  try {
    const res = await fetch(`${API}${path}`, { credentials: 'include', method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) { const j = await res.json().catch(() => null); throw new Error(j?.error?.message || 'HTTP ' + res.status); }
    showToast(showId ? 'Layout enviado a Preview' : 'Layout activado', 'success');
  } catch (e) { showToast('Error: ' + (e as Error).message, 'error'); }
  finally { isSending.value = false; }
}

// ---- server-side collection library (persisted; activatable by id) ----
const serverCollections = ref<Array<{ id: string; name: string; channelId: string; elementCount: number }>>([]);
const loadingCollections = ref(false);
async function loadServerCollections() {
  loadingCollections.value = true;
  try {
    const r = await fetch(`${API}/api/collections?channelId=${encodeURIComponent(channelId.value)}`, { credentials: 'include' });
    const j = await r.json();
    serverCollections.value = j.data?.collections || [];
  } catch { /* server offline */ }
  finally { loadingCollections.value = false; }
}
async function saveToServer() {
  if (!items.value.length) { showToast('Agrega componentes primero', 'error'); return; }
  try {
    const r = await fetch(`${API}/api/collections`, { credentials: 'include',
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: collectionName.value, channelId: channelId.value, scene: buildScene(), variables: mergedVars.value }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || 'HTTP ' + r.status);
    showToast(`Guardado en servidor: "${collectionName.value}"`, 'success');
    loadServerCollections();
  } catch (e) { showToast('Error: ' + (e as Error).message, 'error'); }
}
async function activateServerCollection(id: string) {
  try {
    const path = showId
      ? `/api/shows/${encodeURIComponent(showId)}/production/preview/scenes/${encodeURIComponent(id)}`
      : `/api/collections/${encodeURIComponent(id)}/activate`;
    const r = await fetch(`${API}${path}`, { credentials: 'include',
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: channelId.value }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || 'HTTP ' + r.status);
    showToast(showId ? 'Escena cargada en Preview' : 'Escena activada', 'success');
  } catch (e) { showToast('Error: ' + (e as Error).message, 'error'); }
}
async function deleteServerCollection(id: string) {
  try { await fetch(`${API}/api/collections/${id}`, { credentials: 'include', method: 'DELETE' }); loadServerCollections(); } catch { /* ignore */ }
}

// ---- canvas scale / fit (shared with App.vue via useStageZoom) ----
const containerRef = ref<HTMLElement | null>(null);
const { scale, sizerStyle, stageStyle, setScale, fit } =
  useStageZoom(() => canvas.value, containerRef, { maxScale: 2, pad: 28 });
function toggleOrientation() {
  orientation.value = orientation.value === 'landscape' ? 'portrait' : 'landscape';
  nextTick(fit);
}
onMounted(() => {
  // Canvas fit + resize observer are owned by useStageZoom (its own hooks).
  // Motion System: preview the same motion the overlay renders (shared patterns).
  injectMotionPatterns();
  loadSaved();
  loadServerCollections();
  connectComposerWs();
});
onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
  // Flag + detach before close(): onclose fires on a later tick and would
  // otherwise schedule a reconnect the clearTimeout above can't cancel.
  composerWsClosed = true;
  if (composerWs) composerWs.onclose = null;
  if (composerReconnect) clearTimeout(composerReconnect);
  composerWs?.close();
});

function onCanvasClick(e: MouseEvent) { if (e.target === e.currentTarget) selectedId.value = null; }
</script>

<template>
  <div class="lc">
    <!-- LEFT RAIL -->
    <aside class="lc-rail">
      <section class="rail-sec">
        <h3>Packs (colecciones listas)</h3>
        <p class="hint">Carga un layout completo con su Design System.</p>
        <div class="packs">
          <button v-for="p in collectionPresets" :key="p.id" class="pack" @click="loadPreset(p)">
            <span class="pack-name">{{ p.name }}</span>
            <span class="pack-desc">{{ p.description }}</span>
          </button>
        </div>
      </section>

      <section class="rail-sec">
        <h3>Componentes</h3>
        <p class="hint">Click para añadirlos al layout.</p>
        <div class="palette">
          <button v-for="(x, idx) in flatTemplates" :key="idx" class="pal-item" @click="addComponent(x.t)" :title="x.cat">
            <span class="pal-name">{{ x.t.name }}</span>
            <span class="pal-cat">{{ x.cat }}</span>
          </button>
        </div>
      </section>

      <section class="rail-sec">
        <h3>Capas ({{ items.length }})</h3>
        <p v-if="!items.length" class="hint">Aún no hay componentes.</p>
        <div class="layers">
          <div v-for="item in items" :key="item.id" class="layer-row" :class="{ active: item.id === selectedId }" @click="selectItem(item.id)">
            <span class="layer-name">{{ item.name }}</span>
            <span class="layer-ops">
              <button
                class="eye"
                :class="{ off: layerHidden(item) }"
                @click.stop="toggleLayerEye(item)"
                :title="layerHidden(item) ? 'Mostrar (animado)' : 'Ocultar (animado)'"
              >👁</button>
              <button @click.stop="move(item, 1)" title="Subir (z+)">▲</button>
              <button @click.stop="move(item, -1)" title="Bajar (z-)">▼</button>
              <button @click.stop="duplicateItem(item)" title="Duplicar">⧉</button>
              <button @click.stop="removeItem(item.id)" title="Quitar">✕</button>
            </span>
          </div>
        </div>
      </section>

      <section v-if="selected" class="rail-sec inspector">
        <h3>Posición — {{ selected.name }}</h3>
        <div class="xy">
          <label>X <input type="number" :value="selected.pos.x" @input="selected.pos.x = +($event.target as HTMLInputElement).value; clampPos(selected)" /></label>
          <label>Y <input type="number" :value="selected.pos.y" @input="selected.pos.y = +($event.target as HTMLInputElement).value; clampPos(selected)" /></label>
        </div>
        <div class="anchors">
          <button @click="anchor('l','t')">↖</button><button @click="anchor('c','t')">↑</button><button @click="anchor('r','t')">↗</button>
          <button @click="anchor('l','m')">←</button><button @click="anchor('c','m')">•</button><button @click="anchor('r','m')">→</button>
          <button @click="anchor('l','b')">↙</button><button @click="anchor('c','b')">↓</button><button @click="anchor('r','b')">↘</button>
        </div>

        <h3 class="content-head">Contenido</h3>
        <p v-if="!selectedFields.length" class="hint">Este componente no tiene texto editable.</p>
        <div v-for="f in selectedFields" :key="f.path" class="cfield">
          <label :title="f.path">{{ f.leaf }}</label>
          <textarea v-if="f.long" rows="2" :value="f.value" @input="editVar(f.path, ($event.target as HTMLTextAreaElement).value)"></textarea>
          <input v-else type="text" :value="f.value" @input="editVar(f.path, ($event.target as HTMLInputElement).value)" />
        </div>
      </section>

      <section class="rail-sec">
        <h3>Design System</h3>
        <p class="hint">Aplica un tema a todos los componentes DS.</p>
        <div class="themes">
          <button class="theme-chip none" :class="{ active: !activeThemeName }" @click="clearTheme">Ninguno</button>
          <button
            v-for="t in allThemes"
            :key="t.name"
            class="theme-chip"
            :class="{ active: t.name === activeThemeName }"
            :style="{ background: t.grad }"
            @click="applyTheme(t.name)"
          >{{ t.name }}</button>
        </div>
        <div class="remote-theme">
          <div class="remote-theme-hint">
            <span class="remote-theme-dot" :class="{ on: wsConnected }"></span>
            <span>Los temas enviados por <strong>POST /api/design-systems</strong> aparecen aqui al instante.</span>
          </div>
          <p v-if="lastRemoteTheme" class="remote-theme-last">Ultimo tema recibido: <strong>{{ lastRemoteTheme }}</strong></p>
        </div>
      </section>

      <section class="rail-sec">
        <h3>Colección</h3>
        <input class="col-name" v-model="collectionName" placeholder="Nombre del layout" />
        <label v-if="!showId" class="chan">Canal <input v-model="channelId" /></label>
        <div class="col-actions">
          <button class="btn" @click="saveCollection" title="Guardar en este navegador">💾 Local</button>
          <button class="btn" @click="saveToServer" title="Guardar en el servidor para activarla por id">☁ Servidor</button>
          <button class="btn" @click="newCollection">＋ Nueva</button>
        </div>

        <p v-if="loadingCollections && !serverCollections.length" class="hint lib-loading">Cargando librería…</p>
        <div v-if="serverCollections.length" class="saved-list">
          <div class="lib-label">☁ Librería (servidor)</div>
          <div v-for="c in serverCollections" :key="c.id" class="saved-row">
            <button class="saved-load" @click="activateServerCollection(c.id)" :title="`${c.elementCount} elementos · activar por id`">▶ {{ c.name }}</button>
            <button class="saved-del" @click="deleteServerCollection(c.id)" title="Eliminar del servidor">✕</button>
          </div>
        </div>

        <div v-if="savedCollections.length" class="saved-list">
          <div v-for="c in savedCollections" :key="c.id" class="saved-row">
            <button class="saved-load" @click="loadCollection(c)" :title="`${c.items.length} componentes`">{{ c.name }}</button>
            <button class="saved-del" @click="deleteCollection(c)" title="Eliminar">✕</button>
          </div>
        </div>
      </section>
    </aside>

    <!-- CANVAS -->
    <div class="lc-main">
      <div class="lc-toolbar">
        <div class="zoom">
          <span>{{ Math.round(scale * 100) }}%</span>
          <button @click="setScale(scale - 0.1)">-</button>
          <button @click="setScale(scale + 0.1)">+</button>
          <button class="btn-sm" @click="fit">Ajustar</button>
          <button class="btn-sm" @click="toggleOrientation" :title="`Cambiar a ${orientation === 'landscape' ? 'vertical' : 'horizontal'}`">
            {{ orientation === 'portrait' ? '▯ Portrait 9:16' : '▭ Landscape 16:9' }}
          </button>
        </div>
        <button class="activate" @click="activate" :disabled="isSending">
          {{ isSending ? 'Enviando…' : '🚀 Activar colección' }}
        </button>
      </div>

      <div class="lc-stage" ref="containerRef">
        <div class="lc-sizer" :style="sizerStyle">
          <div class="lc-canvas" :style="stageStyle" @mousedown="onCanvasClick">
            <ElementRenderer v-if="themeStyleEl" :key="'theme-' + activeThemeName" :element="themeStyleEl" :variables="{}" />
            <div
              v-for="(item, i) in items"
              :key="item.id"
              class="lc-layer"
              :data-layer="item.id"
              :class="{ selected: item.id === selectedId, 'dsm-toggle': !!item.showVar, 'dsm-out': layerHidden(item) }"
              :style="{ left: item.pos.x + 'px', top: item.pos.y + 'px', zIndex: i + 1 }"
              @mousedown.stop="onDown(item, $event)"
            >
              <ElementRenderer v-for="el in renderModel(item)" :key="el.id" :element="el" :variables="mergedVars" />
            </div>
          </div>
        </div>
        <!-- Empty state: overlay sibling (NOT v-if on the stage) so the scroll
             container keeps measuring for the fit/ResizeObserver. -->
        <div v-if="!items.length" class="lc-empty">
          <div class="lc-empty-glyph">＋</div>
          <div class="lc-empty-title">Lienzo vacío</div>
          <div class="lc-empty-sub">Arrastra un componente desde la izquierda o carga un pack para empezar.</div>
          <Button v-if="collectionPresets.length" variant="secondary" size="sm" @click="loadPreset(collectionPresets[0])">
            Cargar {{ collectionPresets[0].name }}
          </Button>
        </div>
      </div>
    </div>

    <div v-if="toast" class="lc-toast" :class="toast.type">{{ toast.message }}</div>
  </div>
</template>

<style scoped>
.lc { flex: 1; min-height: 0; display: flex; background: var(--app-bg); color: var(--app-ink); }

/* rail */
.lc-rail { width: 320px; flex-shrink: 0; border-right: 1px solid var(--app-line); background: var(--app-panel); overflow-y: auto; padding: 6px 0 30px; }
.rail-sec { padding: 12px 14px; border-bottom: 1px solid var(--app-line); }
.rail-sec h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: var(--tracking-label); color: var(--app-accent); }
.hint { margin: 0 0 8px; font-size: 11px; color: var(--app-muted); }

.packs { display: flex; flex-direction: column; gap: 6px; }
.pack { display: flex; flex-direction: column; gap: 2px; text-align: left; background: var(--app-raised); border: 1px solid var(--app-line); border-radius: 8px; padding: 9px 11px; cursor: pointer; color: var(--app-ink); }
.pack:hover { background: var(--app-hover); border-color: var(--app-brand); }
.pack-name { font-size: 13px; font-weight: 700; }
.pack-desc { font-size: 10px; color: var(--app-muted); }

.themes { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.theme-chip { border: 2px solid transparent; border-radius: 8px; padding: 7px 11px; cursor: pointer; color: #fff; font-size: 11px; font-weight: 700; text-shadow: 0 1px 2px rgba(0,0,0,.6); }
.theme-chip.none { background: var(--app-raised); color: var(--app-ink); text-shadow: none; }
.theme-chip.active { border-color: #fff; box-shadow: 0 0 0 2px var(--app-accent); }
.remote-theme { display: flex; flex-direction: column; gap: 6px; }
.remote-theme-hint { display: flex; gap: 8px; align-items: flex-start; font-size: 11.5px; color: #b8c0cf; line-height: 1.5; background: var(--surface-inset); border: 1px solid var(--app-line); border-radius: 8px; padding: 9px 11px; }
.remote-theme-hint strong { color: var(--app-accent); }
.remote-theme-hint em { color: #c4a7ff; font-style: italic; }
.remote-theme-dot { width: 9px; height: 9px; border-radius: 999px; background: #ef4444; flex: 0 0 auto; margin-top: 3px; }
.remote-theme-dot.on { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
.remote-theme-last { margin: 2px 0 0; font-size: 11px; color: var(--app-muted); }
.remote-theme-last strong { color: var(--app-ink); }

.palette { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; max-height: 240px; overflow-y: auto; }
.pal-item { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; text-align: left; background: var(--app-raised); border: 1px solid var(--app-line); border-radius: 6px; padding: 7px 9px; cursor: pointer; color: var(--app-ink); }
.pal-item:hover { background: var(--app-hover); border-color: var(--app-line-strong); }
.pal-name { font-size: 12px; font-weight: 600; }
.pal-cat { font-size: 10px; color: var(--app-muted); }

.layers { display: flex; flex-direction: column; gap: 3px; }
.layer-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 5px 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
.layer-row:hover { background: var(--app-hover); }
.layer-row.active { background: var(--app-selected-bg); border-color: var(--app-selected-line); }
.layer-name { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.layer-ops { display: flex; gap: 2px; flex-shrink: 0; align-items: center; }
.layer-ops button { background: transparent; border: none; color: var(--app-muted); cursor: pointer; padding: 2px 4px; font-size: 11px; border-radius: 4px; }
.layer-ops button:hover { background: var(--app-hover); color: #fff; }
/* visibility eye: bright when shown, dimmed + struck through when the layer is hidden */
.layer-ops .eye { font-size: 13px; line-height: 1; opacity: .95; }
.layer-ops .eye.off { opacity: .35; text-decoration: line-through; }

.inspector .xy { display: flex; gap: 10px; margin-bottom: 10px; }
.inspector .xy label { flex: 1; font-size: 11px; color: var(--app-muted); display: flex; flex-direction: column; gap: 3px; }
.inspector input[type="number"] { width: 100%; background: var(--surface-inset); border: 1px solid var(--app-line); color: #fff; border-radius: 6px; padding: 6px 8px; }
.content-head { margin: 16px 0 8px; border-top: 1px solid var(--app-line); padding-top: 12px; }
.cfield { display: flex; flex-direction: column; gap: 4px; margin-bottom: 9px; }
.cfield label { font-size: 11px; color: #9aa6bd; font-family: ui-monospace, Menlo, monospace; }
.cfield input, .cfield textarea { width: 100%; background: var(--surface-inset); border: 1px solid var(--app-line); color: #fff; border-radius: 6px; padding: 7px 9px; font-size: 13px; font-family: inherit; }
.cfield input:focus, .cfield textarea:focus { outline: none; border-color: var(--app-accent); box-shadow: var(--focus-ring); }
.cfield textarea { resize: vertical; }
.anchors { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.anchors button { background: var(--app-raised); border: 1px solid var(--app-line); color: var(--app-ink); border-radius: 6px; padding: 7px 0; cursor: pointer; font-size: 13px; }
.anchors button:hover { background: var(--app-brand); color: #fff; border-color: var(--app-brand); }

.col-name { width: 100%; background: var(--surface-inset); border: 1px solid var(--app-line); color: #fff; border-radius: 6px; padding: 7px 9px; margin-bottom: 8px; }
.chan { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--app-muted); margin-bottom: 8px; }
.chan input { flex: 1; background: var(--surface-inset); border: 1px solid var(--app-line); color: #fff; border-radius: 6px; padding: 6px 8px; }
.col-actions { display: flex; gap: 8px; }
.btn { flex: 1; background: var(--app-raised); border: 1px solid var(--app-line); color: var(--app-ink); border-radius: 6px; padding: 8px; cursor: pointer; font-size: 12px; }
.btn:hover { background: var(--app-hover); }
.saved-list { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.lib-label { font-size: 10px; text-transform: uppercase; letter-spacing: var(--tracking-label); color: var(--app-accent); margin: 2px 0; }
.saved-row { display: flex; gap: 4px; }
.saved-load { flex: 1; text-align: left; background: var(--surface-inset); border: 1px solid var(--app-line); color: var(--app-ink); border-radius: 6px; padding: 6px 9px; cursor: pointer; font-size: 12px; }
.saved-load:hover { border-color: var(--app-accent); }
.saved-del { background: transparent; border: 1px solid var(--app-line); color: var(--app-muted); border-radius: 6px; padding: 0 9px; cursor: pointer; }
.saved-del:hover { background: #7f1d1d; color: #fff; }

/* main / canvas */
.lc-main { flex: 1; min-width: 0; display: flex; flex-direction: column; background: #0d1117; }
.lc-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--app-line); background: var(--app-panel); }
.zoom { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--app-ink); }
.zoom button { background: transparent; border: 1px solid var(--app-line); color: var(--app-ink); border-radius: 4px; padding: 3px 9px; cursor: pointer; }
.zoom button:hover { background: var(--app-hover); color: #fff; }
.btn-sm { font-size: 12px; }
/* Primary publish action — BRAND gradient (purple→cyan). Red is reserved strictly
   for destructive actions (✕ delete buttons). */
.activate { background: linear-gradient(135deg, var(--brand, #9333ea), var(--brand-2, #22d3ee)); color: #fff; border: none; padding: 9px 18px; border-radius: 6px; font-weight: 700; cursor: pointer; }
.activate:hover { filter: brightness(1.1); }
.activate:disabled { background: var(--app-line-strong); cursor: not-allowed; filter: none; }

.lc-stage { position: relative; flex: 1; min-height: 0; overflow: auto; display: grid; place-content: safe center; padding: 28px;
  background-image: linear-gradient(45deg, var(--app-bg) 25%, transparent 25%), linear-gradient(-45deg, var(--app-bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--app-bg) 75%), linear-gradient(-45deg, transparent 75%, var(--app-bg) 75%);
  background-size: 22px 22px; background-position: 0 0, 0 11px, 11px -11px, -11px 0; }
.lc-sizer { position: relative; flex-shrink: 0; }
.lc-canvas { position: relative; transform-origin: top left; border: 1px dashed var(--app-line-strong); box-shadow: 0 0 60px rgba(0,0,0,.5); }
.lc-layer { position: absolute; cursor: grab; }
.lc-layer:hover { outline: 1px dashed rgba(34,211,238,.5); outline-offset: 3px; }
.lc-layer.selected { outline: 2px solid var(--app-accent); outline-offset: 3px; cursor: grabbing; }
/* Empty-state overlay — centered over the (still-mounted, still-measured) stage. */
.lc-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; text-align: center; pointer-events: none; }
.lc-empty > * { pointer-events: auto; }
.lc-empty-glyph { font-size: 38px; opacity: .4; }
.lc-empty-title { font-size: 16px; font-weight: 700; color: var(--app-ink); }
.lc-empty-sub { font-size: 13px; color: var(--app-muted); max-width: 300px; line-height: 1.5; margin-bottom: 8px; }

.lc-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); padding: 10px 22px; border-radius: 8px; font-size: 13px; font-weight: 600; color: #fff; z-index: 100; box-shadow: 0 6px 20px rgba(0,0,0,.45); }
.lc-toast.success { background: #16a34a; }
.lc-toast.error { background: #dc2626; }
</style>
