<!--
  Visual authoring mode: a structured ElementNode tree with a per-element
  inspector PLUS global panels to customize the loaded component end-to-end —
  Variables (content), Design System (theme + token overrides), and Motion. The
  tree edits in place (it is the payload); the Design System tokens are emitted
  to the parent which serializes them into a --ds-* <style> node shipped with the
  scene. DS components are class-based (var(--ds-*)), so their look is customized
  via the Design System panel, not inline styles.
-->
<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import type { ElementNode, Animation, ComponentTrigger, ComponentAction, ComponentActionKind } from '@overlaykit/renderer/types/element';
import type { DesignTokens } from '../design/tokens';
import SoundPicker from './SoundPicker.vue';
import { bindMotionShow, unbindMotionShow, isBoundToShow } from '../composables/useMotionShow';
import { interpolate } from '@overlaykit/renderer/utils/interpolate';
import { SegmentedControl, Slider } from '@overlaykit/ui';

// Saved collections, so the "Cambiar de escena" action target is a PICKLIST (by
// name) instead of an unguessable id typed by hand. Best-effort; falls back to a
// free-text id input when the catalog is empty/unreachable (offline-safe).
const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3000';
const collections = ref<Array<{ id: string; name: string }>>([]);
onMounted(async () => {
  try {
    const res = await fetch(`${API}/api/collections`, { credentials: 'include' });
    if (res.ok) collections.value = (await res.json())?.data?.collections ?? [];
  } catch { /* offline — the free-text fallback still works */ }
});

const props = defineProps<{
  tree: ElementNode[];
  variables: Record<string, any>;
  tokens: DesignTokens | null;
  themes: DesignTokens[];
}>();
const emit = defineEmits<{ (e: 'update:tokens', v: DesignTokens | null): void }>();

const selectedId = ref<string | null>(props.tree[0]?.id ?? null);

let idCounter = 0;
const newId = () => `v-${Date.now()}-${idCounter++}`;

// --- Tree flattening for display (style/script nodes are never editable rows) ---
interface FlatRow { node: ElementNode; depth: number; }
function flatten(nodes: ElementNode[], depth: number, acc: FlatRow[]): FlatRow[] {
  for (const n of nodes) {
    if (n.tag === 'style' || n.tag === 'script') continue;
    acc.push({ node: n, depth });
    if (n.children && n.children.length) flatten(n.children, depth + 1, acc);
  }
  return acc;
}
const rows = computed(() => flatten(props.tree, 0, []));

// Friendly label for a node, for the element.* action target picker: interpolated
// content (so "{{user.name}}" → "Alex Ríos") else its class else its id.
function nodeLabel(node: ElementNode): string {
  const t = interpolate(node.content ?? '', props.variables).trim();
  if (t && !/^\{\{.*\}\}$/.test(t)) return t.length > 32 ? t.slice(0, 32) + '…' : t;
  return (node.attributes?.class as string | undefined) || node.id;
}
// The components a trigger can target = this component's own elements (they become
// live by these ids once sent), so element.show/hide/update/delete is a pick-list.
const targetOptions = computed(() => rows.value.map((r) => ({ id: r.node.id, label: nodeLabel(r.node) })));

function findNode(nodes: ElementNode[], id: string): ElementNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return null;
}
const selected = computed(() => (selectedId.value ? findNode(props.tree, selectedId.value) : null));

// When the tree is replaced (e.g. a template is loaded), keep a valid selection.
watch(
  () => props.tree,
  (t) => { if (!selectedId.value || !findNode(t, selectedId.value)) selectedId.value = t[0]?.id ?? null; },
);

// A class-based DS component styles itself via var(--ds-*) in a <style> node, so
// inline-style edits don't represent it — surface that to the user.
const isClassNode = computed(() => !!selected.value?.attributes?.class);

// --- Tree operations (mutate the reactive tree in place) ---
function makeElement(): ElementNode {
  return {
    id: newId(),
    tag: 'div',
    content: 'Nuevo texto',
    styles: { color: '#ffffff', fontSize: '24px', padding: '8px' },
  };
}
function addElement() {
  const el = makeElement();
  props.tree.push(el);
  selectedId.value = el.id;
}
function addChild() {
  const s = selected.value;
  if (!s) return;
  if (!s.children) s.children = [];
  const el = makeElement();
  s.children.push(el);
  selectedId.value = el.id;
}
function removeNode(nodes: ElementNode[], id: string): boolean {
  const i = nodes.findIndex((n) => n.id === id);
  if (i !== -1) {
    nodes.splice(i, 1);
    return true;
  }
  for (const n of nodes) {
    if (n.children && removeNode(n.children, id)) return true;
  }
  return false;
}
function deleteSelected() {
  if (!selectedId.value) return;
  removeNode(props.tree, selectedId.value);
  selectedId.value = rows.value[0]?.node.id ?? null;
}

// --- Inspector: content / tag ---
function setTag(v: string) { if (selected.value) selected.value.tag = v; }
function setContent(v: string) { if (selected.value) selected.value.content = v; }

// --- Inspector: styles (set/get with delete-on-empty + auto position) ---
function styleVal(key: string): string {
  return selected.value?.styles?.[key] ?? '';
}
function setStyle(key: string, val: string) {
  const s = selected.value;
  if (!s) return;
  if (!s.styles) s.styles = {};
  if (val === '') {
    delete s.styles[key];
  } else {
    s.styles[key] = val;
    // left/top only take effect with a positioning context
    if ((key === 'left' || key === 'top') && !s.styles.position) {
      s.styles.position = 'absolute';
    }
  }
}

// --- Inspector: color swatches ---
// A native <input type="color"> needs a valid hex; when the current style value
// is rgba()/a gradient/empty, fall back to a sensible default WITHOUT touching
// the text value (mirror of the panel's asHex guard).
function toHex(value: string, fallback = '#000000'): string {
  return /^#([0-9a-fA-F]{3,8})$/.test(value.trim()) ? value.trim() : fallback;
}
// Color-ish style fields get a swatch next to the text input.
const COLOR_STYLE_FIELDS: Array<{ key: string; label: string; placeholder: string; fallback: string }> = [
  { key: 'color', label: 'Color', placeholder: '#ffffff', fallback: '#ffffff' },
  { key: 'background', label: 'Fondo', placeholder: '—', fallback: '#000000' },
];
// Pure-color DS tokens that can carry a swatch (grad/surface/shadow/font may be
// gradients/stacks, so they stay text-only).
const SWATCH_TOKENS = new Set<keyof DesignTokens>(['accent', 'accent2', 'text', 'muted', 'onAccent']);

// --- Inspector: typography ---
const FONT_FAMILIES: Array<{ label: string; value: string }> = [
  { label: 'Heredar', value: '' },
  { label: 'System UI', value: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' },
  { label: 'Inter', value: "'Inter', system-ui, sans-serif" },
  { label: 'Montserrat', value: "'Montserrat', system-ui, sans-serif" },
  { label: 'Rajdhani', value: "'Rajdhani', system-ui, sans-serif" },
  { label: 'Roboto Condensed', value: "'Roboto Condensed', system-ui, sans-serif" },
  { label: 'Georgia', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Courier New', value: "'Courier New', ui-monospace, monospace" },
];
const FONT_WEIGHTS = ['300', '400', '600', '700', '800'];
const TEXT_ALIGNS: Array<{ v: string; label: string }> = [
  { v: 'left', label: 'Izq' },
  { v: 'center', label: 'Centro' },
  { v: 'right', label: 'Der' },
];
const TEXT_TRANSFORMS: Array<{ v: string; label: string }> = [
  { v: '', label: 'Ninguna' },
  { v: 'uppercase', label: 'MAYÚS' },
  { v: 'lowercase', label: 'minús' },
  { v: 'capitalize', label: 'Capitalize' },
];
// +/- stepper for fontSize (px). Parses the leading number; ignores non-px units.
function stepFontSize(delta: number) {
  const cur = styleVal('fontSize');
  const n = parseFloat(cur);
  const next = Math.max(1, Math.round((Number.isFinite(n) ? n : 16) + delta));
  setStyle('fontSize', `${next}px`);
}

// --- Inspector: anchor positioning grid (mirror of LayoutComposer.anchor) ---
// Position the element against a 1920×1080 stage using left/top (+ translate for
// centered axes). Edge cells sit 48px from the canvas border. The X/Y text
// inputs remain for fine-tuning.
const STAGE = { w: 1920, h: 1080, margin: 48 };
const ANCHORS: Array<{ hp: 'l' | 'c' | 'r'; vp: 't' | 'm' | 'b'; title: string }> = [
  { hp: 'l', vp: 't', title: 'Arriba izquierda' }, { hp: 'c', vp: 't', title: 'Arriba centro' }, { hp: 'r', vp: 't', title: 'Arriba derecha' },
  { hp: 'l', vp: 'm', title: 'Centro izquierda' }, { hp: 'c', vp: 'm', title: 'Centro' }, { hp: 'r', vp: 'm', title: 'Centro derecha' },
  { hp: 'l', vp: 'b', title: 'Abajo izquierda' }, { hp: 'c', vp: 'b', title: 'Abajo centro' }, { hp: 'r', vp: 'b', title: 'Abajo derecha' },
];
function setAnchor(hp: 'l' | 'c' | 'r', vp: 't' | 'm' | 'b') {
  const m = STAGE.margin;
  const left = hp === 'l' ? `${m}px` : hp === 'c' ? '50%' : `${STAGE.w - m}px`;
  const top = vp === 't' ? `${m}px` : vp === 'm' ? '50%' : `${STAGE.h - m}px`;
  // translate so the element's own box is anchored to the cell (not its corner).
  const tx = hp === 'l' ? '0' : hp === 'c' ? '-50%' : '-100%';
  const ty = vp === 't' ? '0' : vp === 'm' ? '-50%' : '-100%';
  setStyle('left', left);
  setStyle('top', top);
  if (tx === '0' && ty === '0') setStyle('transform', '');
  else setStyle('transform', `translate(${tx}, ${ty})`);
}

// --- Inspector: structured animation presets ---
const ANIM_PRESETS = ['none', 'fadeIn', 'slideInLeft', 'slideInRight', 'zoomIn', 'bounceIn'];
function presetKeyframes(name: string): Animation['keyframes'] {
  switch (name) {
    case 'fadeIn':
      return [{ offset: 0, styles: { opacity: '0' } }, { offset: 1, styles: { opacity: '1' } }];
    case 'slideInLeft':
      return [{ offset: 0, styles: { opacity: '0', transform: 'translateX(-48px)' } }, { offset: 1, styles: { opacity: '1', transform: 'translateX(0)' } }];
    case 'slideInRight':
      return [{ offset: 0, styles: { opacity: '0', transform: 'translateX(48px)' } }, { offset: 1, styles: { opacity: '1', transform: 'translateX(0)' } }];
    case 'zoomIn':
      return [{ offset: 0, styles: { opacity: '0', transform: 'scale(0.6)' } }, { offset: 1, styles: { opacity: '1', transform: 'scale(1)' } }];
    case 'bounceIn':
      return [{ offset: 0, styles: { opacity: '0', transform: 'scale(0.3)' } }, { offset: 0.6, styles: { opacity: '1', transform: 'scale(1.05)' } }, { offset: 1, styles: { transform: 'scale(1)' } }];
    default:
      return [];
  }
}
const currentAnim = computed(() => selected.value?.animations?.[0]?.name ?? 'none');
const currentAnimDuration = computed(() => selected.value?.animations?.[0]?.duration ?? 600);
function setAnimation(name: string, duration: number) {
  const s = selected.value;
  if (!s) return;
  if (name === 'none') {
    delete s.animations;
    return;
  }
  // The element schema requires integer durations — round so a typed decimal
  // doesn't 400 on send (the preview tolerates decimals, production doesn't).
  s.animations = [{ name, duration: Math.max(0, Math.round(duration)) || 600, easing: 'ease-out', keyframes: presetKeyframes(name) }];
}

// --- Inspector: auto-remove ---
const autoRemoveEnabled = computed(() => !!selected.value?.autoRemove);
const autoRemoveDelay = computed(() => selected.value?.autoRemove?.delay ?? 5000);
function setAutoRemove(enabled: boolean, delay: number) {
  const s = selected.value;
  if (!s) return;
  if (enabled) s.autoRemove = { delay: Math.max(0, Math.round(delay)) || 5000 };
  else delete s.autoRemove;
}

const TAGS = ['div', 'span', 'h1', 'h2', 'h3', 'p', 'img', 'button'];

// --- Events / Actions panel (Feature B): author per-element triggers + actions ---
const TRIGGER_TYPES: Array<{ v: ComponentTrigger['on']; label: string }> = [
  { v: 'countdown.complete', label: 'La cuenta regresiva llega a 0' },
  { v: 'click', label: 'Al hacer clic' },
  { v: 'mounted', label: 'Al aparecer' },
];
const ACTION_KINDS: Array<{ v: ComponentActionKind; label: string }> = [
  { v: 'scene.activate', label: 'Cambiar de escena (colección)' },
  { v: 'element.show', label: 'Mostrar componente' },
  { v: 'element.hide', label: 'Ocultar componente' },
  { v: 'element.update', label: 'Actualizar texto del componente' },
  { v: 'element.delete', label: 'Eliminar componente' },
  { v: 'variables.update', label: 'Actualizar variable' },
  { v: 'sound.play', label: 'Reproducir sonido' },
];
const triggers = computed<ComponentTrigger[]>(() => selected.value?.triggers ?? []);
// The countdown.complete trigger fires from the element that owns data-countdown.
// The server hoists it there on send, so it works wherever it's attached AS LONG AS
// the component HAS a countdown element somewhere — surface that instead of demanding
// the exact element be selected.
const selectedHasCountdown = computed(() => selected.value?.attributes?.['data-countdown'] !== undefined);
function treeHasCountdown(nodes: ElementNode[]): boolean {
  return nodes.some((n) => n.attributes?.['data-countdown'] !== undefined || (n.children ? treeHasCountdown(n.children) : false));
}
const componentHasCountdown = computed(() => treeHasCountdown(props.tree));
function addTrigger() {
  const s = selected.value;
  if (!s) return;
  if (!s.triggers) s.triggers = [];
  s.triggers.push({ on: 'countdown.complete', actions: [] });
}
function removeTrigger(ti: number) { selected.value?.triggers?.splice(ti, 1); }
function setTriggerOn(ti: number, on: ComponentTrigger['on']) {
  const t = selected.value?.triggers?.[ti];
  if (t) t.on = on;
}
function addAction(ti: number) { selected.value?.triggers?.[ti]?.actions.push({ kind: 'scene.activate' }); }
function removeAction(ti: number, ai: number) { selected.value?.triggers?.[ti]?.actions.splice(ai, 1); }
function setActionKind(a: ComponentAction, kind: ComponentActionKind) {
  // Clear fields from the previous kind so the inspector + shipped payload only
  // carry what the new kind uses (target means an element id for element.* but a
  // collection id for scene.activate — a stale value would ship and misdispatch).
  a.kind = kind;
  delete a.target;
  delete a.updates;
  delete a.variables;
  delete a.sound;
}
function setActionTarget(a: ComponentAction, v: string) { a.target = v; }
function setActionContent(a: ComponentAction, v: string) { a.updates = { content: v }; }
function actionVarKey(a: ComponentAction): string { return Object.keys(a.variables || {})[0] ?? ''; }
function actionVarVal(a: ComponentAction): string {
  const k = actionVarKey(a);
  return k ? String((a.variables as Record<string, any>)[k] ?? '') : '';
}
function setActionVar(a: ComponentAction, key: string, val: string) {
  // A single top-level variable name (the server merges it into the channel).
  a.variables = key && VAR_SEGMENT.test(key) ? { [key]: val } : {};
}

// --- Variables panel: edit the component's {{...}} values from the GUI ---
const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
function setByPath(obj: any, path: string, value: any) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isObj(o[keys[i]])) o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}
const variableFields = computed(() => {
  const out: Array<{ path: string; leaf: string; value: string; long: boolean }> = [];
  const walk = (obj: any, prefix: string) => {
    for (const k of Object.keys(obj || {})) {
      const v = obj[k];
      const path = prefix ? `${prefix}.${k}` : k;
      if (isObj(v)) walk(v, path);
      else out.push({ path, leaf: k, value: String(v ?? ''), long: typeof v === 'string' && (v.length > 22 || /url|logo|image|img/i.test(k)) });
    }
  };
  walk(props.variables, '');
  return out;
});
function editVar(path: string, value: string) { setByPath(props.variables, path, value); }
const newVarKey = ref('');
const newVarVal = ref('');
// Variable names (each dot-segment) must match the server's variables.schema
// pattern, else they ship but never interpolate. Validate before allowing add.
const VAR_SEGMENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function isValidVarKey(key: string): boolean {
  const segs = key.split('.');
  return segs.length > 0 && segs.every((s) => VAR_SEGMENT.test(s));
}
const newVarKeyValid = computed(() => isValidVarKey(newVarKey.value.trim()));
function addVariable() {
  const key = newVarKey.value.trim();
  if (!key || !isValidVarKey(key)) return;
  setByPath(props.variables, key, newVarVal.value);
  newVarKey.value = '';
  newVarVal.value = '';
}

// --- Design System panel: pick a theme preset + override individual tokens ---
const COLOR_TOKENS: Array<[keyof DesignTokens, string, string]> = [
  ['accent', 'Acento', '#22d3ee'],
  ['accent2', 'Acento 2', '#a855f7'],
  ['text', 'Texto', '#ffffff'],
  ['muted', 'Texto tenue', '#9aa'],
  ['onAccent', 'Texto sobre acento', '#0b0b16'],
  ['surface', 'Superficie', 'rgba(20,18,33,.92)'],
  ['surface2', 'Superficie 2', 'rgba(255,255,255,.06)'],
  ['border', 'Borde', 'rgba(168,85,247,.35)'],
  ['grad', 'Degradado', 'linear-gradient(...)'],
  ['radius', 'Radio', '16px'],
  ['shadow', 'Sombra', '0 12px 36px rgba(0,0,0,.55)'],
  ['glow', 'Glow', 'rgba(34,211,238,.5)'],
  ['font', 'Fuente', "'Inter', system-ui"],
  ['fontImport', 'Importar fuente (URL https)', 'https://fonts.googleapis.com/...'],
];
const MOTION_TOKENS: Array<[keyof DesignTokens, string, string]> = [
  ['durSlow', 'Dur. entrada', '480ms'],
  ['durBase', 'Dur. énfasis', '300ms'],
  ['durFast', 'Dur. rápida / salida', '150ms'],
  ['easeEntrance', 'Ease entrada', 'cubic-bezier(.16,1,.3,1)'],
  ['easeEmphasis', 'Ease énfasis', 'cubic-bezier(.34,1.56,.64,1)'],
  ['easeExit', 'Ease salida', 'cubic-bezier(.4,0,1,1)'],
  ['stagger', 'Escalonado', '80ms'],
];
const currentPreset = computed(() => props.tokens?.name ?? '');
function pickPreset(name: string) {
  if (!name) { emit('update:tokens', null); return; }
  const t = props.themes.find((x) => x.name === name);
  emit('update:tokens', t ? { ...t } : null);
}
function tokenVal(key: keyof DesignTokens): string {
  return (props.tokens?.[key] as string) ?? '';
}
function setToken(key: keyof DesignTokens, val: string) {
  const base: any = props.tokens ? { ...props.tokens } : {};
  if (val === '') delete base[key]; else base[key] = val;
  // A manual token edit makes this a custom theme: rename so the picker reflects
  // the divergence (and re-picking a preset fires a real change event to reset).
  base.name = 'Personalizado';
  // If nothing meaningful remains, clear the theme (use component fallbacks).
  const hasTokens = Object.keys(base).some((k) => k !== 'name' && base[k]);
  emit('update:tokens', hasTokens ? base : null);
}

// --- Inspector: visibility (animated show/hide) ---
// Bind the selected node to a `flags.show_<id>` variable so it surfaces in the
// Panel de Control as a live show/hide switch. See composables/useMotionShow.
const canToggleVisibility = computed(() => (selected.value ? isBoundToShow(selected.value) : false));
function setVisibilityToggle(enabled: boolean) {
  const s = selected.value;
  if (!s) return;
  if (enabled) bindMotionShow(s, props.variables);
  else unbindMotionShow(s);
}

// --- Motion presets: one-click curve/duration sets via setToken ---
type MotionPreset = Partial<Record<keyof DesignTokens, string>>;
const MOTION_PRESETS: Array<{ label: string; tokens: MotionPreset }> = [
  {
    label: 'Suave',
    tokens: { durSlow: '600ms', durBase: '320ms', durFast: '160ms', easeEntrance: 'cubic-bezier(.25,.8,.25,1)', easeEmphasis: 'cubic-bezier(.25,.8,.25,1)', easeExit: 'cubic-bezier(.4,0,1,1)', stagger: '90ms' },
  },
  {
    label: 'Enérgico',
    tokens: { durSlow: '420ms', durBase: '240ms', durFast: '130ms', easeEntrance: 'cubic-bezier(.16,1,.3,1)', easeEmphasis: 'cubic-bezier(.34,1.56,.64,1)', easeExit: 'cubic-bezier(.4,0,1,1)', stagger: '60ms' },
  },
  {
    label: 'Corporativo',
    tokens: { durSlow: '500ms', durBase: '300ms', durFast: '150ms', easeEntrance: 'cubic-bezier(.4,0,.2,1)', easeEmphasis: 'cubic-bezier(.4,0,.2,1)', easeExit: 'cubic-bezier(.4,0,1,1)', stagger: '70ms' },
  },
  {
    label: 'Juguetón',
    tokens: { durSlow: '360ms', durBase: '220ms', durFast: '110ms', easeEntrance: 'cubic-bezier(.34,1.7,.5,1)', easeEmphasis: 'cubic-bezier(.34,1.8,.5,1)', easeExit: 'cubic-bezier(.5,0,1,1)', stagger: '100ms' },
  },
];
function applyMotionPreset(p: MotionPreset) {
  for (const [key, val] of Object.entries(p)) setToken(key as keyof DesignTokens, val);
}

// --- Inspector tabs (Contenido / Estilo / Movimiento / Visibilidad) ---
const inspTab = ref<'contenido' | 'estilo' | 'movimiento' | 'visibilidad'>('contenido');
const INSP_TABS = [
  { value: 'contenido', label: 'Contenido' },
  { value: 'estilo', label: 'Estilo' },
  { value: 'movimiento', label: 'Movimiento' },
  { value: 'visibilidad', label: 'Visibilidad' },
];
// Scalar views over the themeable --ds-* tokens for the kit sliders (parseInt
// strips the px/ms unit; setToken re-adds it).
const radiusNum = computed(() => parseInt(tokenVal('radius')) || 16);
const durBaseNum = computed(() => parseInt(tokenVal('durBase')) || 300);
const staggerNum = computed(() => parseInt(tokenVal('stagger')) || 80);
</script>

<template>
  <div class="visual-editor">
    <!-- Element tree -->
    <div class="ve-tree">
      <div class="ve-tree-actions">
        <button @click="addElement">＋ Elemento</button>
        <button @click="addChild" :disabled="!selected">＋ Hijo</button>
        <button class="danger" @click="deleteSelected" :disabled="!selected">🗑</button>
      </div>
      <div class="ve-tree-list">
        <div
          v-for="row in rows"
          :key="row.node.id"
          class="ve-tree-row"
          :class="{ selected: row.node.id === selectedId }"
          :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }"
          @click="selectedId = row.node.id"
        >
          <span class="ve-tag">{{ row.node.tag }}</span>
          <span class="ve-label">{{ row.node.content || row.node.attributes?.class || row.node.id }}</span>
        </div>
        <div v-if="!rows.length" class="ve-empty">Sin elementos. Pulsa “＋ Elemento”.</div>
      </div>
    </div>

    <!-- Inspector: tabbed (Contenido / Estilo / Movimiento / Visibilidad) -->
    <div class="ve-inspector">
      <div class="ve-tabs">
        <SegmentedControl :model-value="inspTab" :options="INSP_TABS" size="sm" @update:model-value="inspTab = $event as typeof inspTab" />
      </div>

      <!-- ── CONTENIDO ── -->
      <div v-show="inspTab === 'contenido'" class="ve-tabpane">
      <template v-if="selected">
        <div class="ve-section-title">Inspector — {{ selected.tag }}</div>

        <div v-if="isClassNode" class="ve-note">
          Componente del Design System (clase <code>{{ selected.attributes?.class }}</code>).
          Su color/tipografía se ajustan en <strong>Sistema de Diseño</strong> y su texto en <strong>Variables</strong>.
        </div>

        <label class="ve-field">Tag
          <select :value="selected.tag" @change="setTag(($event.target as HTMLSelectElement).value)">
            <option v-for="t in TAGS" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>

        <label class="ve-field">Contenido / placeholder
          <textarea
            :value="selected.content ?? ''"
            rows="2"
            placeholder="Texto o {{user.name}}"
            @input="setContent(($event.target as HTMLTextAreaElement).value)"
          ></textarea>
        </label>
      </template>
      <div v-else class="ve-note">Selecciona un elemento del árbol para editar su contenido.</div>

      <!-- Variables (nivel componente) -->
      <details class="ve-panel" open>
        <summary>Variables</summary>
        <div class="ve-panel-body">
          <p v-if="!variableFields.length" class="ve-muted">Este componente no tiene variables. Agrega una abajo.</p>
          <label v-for="f in variableFields" :key="f.path" class="ve-field">{{ f.path }}
            <textarea v-if="f.long" rows="2" :value="f.value" @input="editVar(f.path, ($event.target as HTMLTextAreaElement).value)"></textarea>
            <input v-else :value="f.value" @input="editVar(f.path, ($event.target as HTMLInputElement).value)" />
          </label>
          <div class="ve-add-var">
            <input v-model="newVarKey" placeholder="nueva.clave" :class="{ invalid: newVarKey.trim() && !newVarKeyValid }" />
            <input v-model="newVarVal" placeholder="valor" />
            <button @click="addVariable" :disabled="!newVarKeyValid">＋</button>
          </div>
          <p v-if="newVarKey.trim() && !newVarKeyValid" class="ve-muted ve-warn">
            Cada segmento debe empezar por letra/_ y usar solo letras, números o _ (ej. <code>quiz.optionA</code>).
          </p>
        </div>
      </details>
      </div>

      <!-- ── ESTILO ── -->
      <div v-show="inspTab === 'estilo'" class="ve-tabpane">
      <template v-if="selected">
        <div class="ve-grid">
          <label v-for="f in COLOR_STYLE_FIELDS" :key="f.key" class="ve-field">{{ f.label }}
            <div class="ve-swatch-row">
              <input
                type="color"
                class="ve-swatch"
                :value="toHex(styleVal(f.key), f.fallback)"
                @input="setStyle(f.key, ($event.target as HTMLInputElement).value)"
              />
              <input :value="styleVal(f.key)" :placeholder="f.placeholder" @input="setStyle(f.key, ($event.target as HTMLInputElement).value)" />
            </div>
          </label>
          <label class="ve-field">Padding
            <input :value="styleVal('padding')" placeholder="8px" @input="setStyle('padding', ($event.target as HTMLInputElement).value)" />
          </label>
        </div>

        <div class="ve-subtitle">Tipografía</div>
        <label class="ve-field">Fuente
          <select :value="styleVal('fontFamily')" @change="setStyle('fontFamily', ($event.target as HTMLSelectElement).value)">
            <option v-for="ff in FONT_FAMILIES" :key="ff.label" :value="ff.value">{{ ff.label }}</option>
          </select>
        </label>
        <label class="ve-field">Grosor
          <div class="ve-seg">
            <button
              v-for="w in FONT_WEIGHTS"
              :key="w"
              type="button"
              :class="{ active: styleVal('fontWeight') === w }"
              @click="setStyle('fontWeight', styleVal('fontWeight') === w ? '' : w)"
            >{{ w }}</button>
          </div>
        </label>
        <div class="ve-grid">
          <label class="ve-field">Tamaño fuente
            <div class="ve-stepper">
              <button type="button" @click="stepFontSize(-1)" title="−1px">−</button>
              <input :value="styleVal('fontSize')" placeholder="24px" @input="setStyle('fontSize', ($event.target as HTMLInputElement).value)" />
              <button type="button" @click="stepFontSize(1)" title="+1px">＋</button>
            </div>
          </label>
          <label class="ve-field">Interlineado
            <input :value="styleVal('lineHeight')" placeholder="1.4" @input="setStyle('lineHeight', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="ve-field">Espaciado letras
            <input :value="styleVal('letterSpacing')" placeholder="0.02em" @input="setStyle('letterSpacing', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="ve-field">Transformar
            <select :value="styleVal('textTransform')" @change="setStyle('textTransform', ($event.target as HTMLSelectElement).value)">
              <option v-for="tt in TEXT_TRANSFORMS" :key="tt.label" :value="tt.v">{{ tt.label }}</option>
            </select>
          </label>
        </div>
        <label class="ve-field">Alineación
          <div class="ve-seg">
            <button
              v-for="ta in TEXT_ALIGNS"
              :key="ta.v"
              type="button"
              :class="{ active: styleVal('textAlign') === ta.v }"
              @click="setStyle('textAlign', styleVal('textAlign') === ta.v ? '' : ta.v)"
            >{{ ta.label }}</button>
          </div>
        </label>
      </template>
      <div v-else class="ve-note">Selecciona un elemento del árbol para editar su estilo.</div>

      <!-- Forma + Sistema de Diseño (nivel componente, --ds-*) -->
      <div class="ve-subtitle">Forma</div>
      <Slider
        label="Redondez"
        :model-value="radiusNum"
        :min="0"
        :max="40"
        :step="1"
        :value-text="radiusNum + 'px'"
        @update:model-value="setToken('radius', $event + 'px')"
      />
      <details class="ve-panel" open>
        <summary>Sistema de Diseño</summary>
        <div class="ve-panel-body">
          <label class="ve-field">Tema
            <select :value="currentPreset" @change="pickPreset(($event.target as HTMLSelectElement).value)">
              <option value="">(Ninguno)</option>
              <option v-for="t in themes" :key="t.name" :value="t.name">{{ t.name }}</option>
              <option v-if="currentPreset === 'Personalizado'" value="Personalizado">Personalizado</option>
            </select>
          </label>
          <div class="ve-grid">
            <label v-for="[key, label, ph] in COLOR_TOKENS" :key="key" class="ve-field" :class="{ wide: key === 'grad' || key === 'fontImport' || key === 'shadow' }">{{ label }}
              <div v-if="SWATCH_TOKENS.has(key)" class="ve-swatch-row">
                <input
                  type="color"
                  class="ve-swatch"
                  :value="toHex(tokenVal(key))"
                  @input="setToken(key, ($event.target as HTMLInputElement).value)"
                />
                <input :value="tokenVal(key)" :placeholder="ph" @input="setToken(key, ($event.target as HTMLInputElement).value)" />
              </div>
              <input v-else :value="tokenVal(key)" :placeholder="ph" @input="setToken(key, ($event.target as HTMLInputElement).value)" />
            </label>
          </div>
        </div>
      </details>
      </div>

      <!-- ── MOVIMIENTO ── -->
      <div v-show="inspTab === 'movimiento'" class="ve-tabpane">
      <template v-if="selected">
        <div class="ve-subtitle">Posición</div>
        <div class="ve-anchor-grid">
          <button
            v-for="a in ANCHORS"
            :key="a.hp + a.vp"
            type="button"
            class="ve-anchor"
            :title="a.title"
            @click="setAnchor(a.hp, a.vp)"
          ><span></span></button>
        </div>
        <div class="ve-grid">
          <label class="ve-field">X (left)
            <input :value="styleVal('left')" placeholder="—" @input="setStyle('left', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="ve-field">Y (top)
            <input :value="styleVal('top')" placeholder="—" @input="setStyle('top', ($event.target as HTMLInputElement).value)" />
          </label>
        </div>

        <label class="ve-field">Animación de entrada
          <div class="ve-inline">
            <select :value="currentAnim" @change="setAnimation(($event.target as HTMLSelectElement).value, currentAnimDuration)">
              <option v-for="a in ANIM_PRESETS" :key="a" :value="a">{{ a }}</option>
            </select>
            <input
              type="number"
              :value="currentAnimDuration"
              min="0"
              step="100"
              title="Duración (ms)"
              @input="setAnimation(currentAnim, Number(($event.target as HTMLInputElement).value))"
            />
            <span class="ve-unit">ms</span>
          </div>
        </label>

        <label class="ve-inline ve-checkbox">
          <input
            type="checkbox"
            :checked="autoRemoveEnabled"
            @change="setAutoRemove(($event.target as HTMLInputElement).checked, autoRemoveDelay)"
          />
          Auto-ocultar
          <input
            v-if="autoRemoveEnabled"
            type="number"
            :value="autoRemoveDelay"
            min="0"
            step="500"
            @input="setAutoRemove(true, Number(($event.target as HTMLInputElement).value))"
          />
          <span v-if="autoRemoveEnabled" class="ve-unit">ms</span>
        </label>
      </template>
      <div v-else class="ve-note">Selecciona un elemento del árbol para editar su movimiento.</div>

      <!-- Movimiento del tema (nivel componente, --ds-*) -->
      <details class="ve-panel" open>
        <summary>Movimiento (tema)</summary>
        <div class="ve-panel-body">
          <p class="ve-muted">Curvas y duraciones del tema (las entradas/énfasis de los componentes DS las usan vía <code>var(--ds-*)</code>).</p>
          <Slider
            label="Velocidad"
            :model-value="durBaseNum"
            :min="80"
            :max="800"
            :step="10"
            :value-text="durBaseNum + 'ms'"
            @update:model-value="setToken('durBase', $event + 'ms')"
          />
          <Slider
            label="Escalonado"
            :model-value="staggerNum"
            :min="0"
            :max="200"
            :step="5"
            :value-text="staggerNum + 'ms'"
            @update:model-value="setToken('stagger', $event + 'ms')"
          />
          <div class="ve-chips">
            <button v-for="p in MOTION_PRESETS" :key="p.label" type="button" class="ve-chip" @click="applyMotionPreset(p.tokens)">{{ p.label }}</button>
          </div>
          <div class="ve-grid">
            <label v-for="[key, label, ph] in MOTION_TOKENS" :key="key" class="ve-field" :class="{ wide: String(key).startsWith('ease') }">{{ label }}
              <input :value="tokenVal(key)" :placeholder="ph" @input="setToken(key, ($event.target as HTMLInputElement).value)" />
            </label>
          </div>
        </div>
      </details>
      </div>

      <!-- ── VISIBILIDAD ── -->
      <div v-show="inspTab === 'visibilidad'" class="ve-tabpane">
      <template v-if="selected">
        <div class="ve-subtitle">Visibilidad</div>
        <label class="ve-inline ve-checkbox">
          <input
            type="checkbox"
            :checked="canToggleVisibility"
            @change="setVisibilityToggle(($event.target as HTMLInputElement).checked)"
          />
          Se puede ocultar/mostrar (animado)
        </label>
        <p v-if="canToggleVisibility" class="ve-muted">
          Aparecerá en el Panel de Control como un interruptor para mostrar/ocultar en vivo.
        </p>

        <div class="ve-subtitle">Eventos / Acciones</div>
        <div class="ve-events">
          <p v-if="!triggers.length" class="ve-muted">
            Sin eventos. Ej.: cuando la cuenta regresiva llega a 0 → cambiar de escena, ocultar un componente o reproducir un sonido.
          </p>
          <div v-for="(trig, ti) in triggers" :key="ti" class="ve-trigger">
            <div class="ve-trigger-head">
              <span class="ve-when">Cuando</span>
              <select :value="trig.on" @change="setTriggerOn(ti, ($event.target as HTMLSelectElement).value as any)">
                <option v-for="tt in TRIGGER_TYPES" :key="tt.v" :value="tt.v">{{ tt.label }}</option>
              </select>
              <button class="danger" @click="removeTrigger(ti)" title="Quitar disparador">✕</button>
            </div>
            <p v-if="trig.on === 'countdown.complete' && !selectedHasCountdown && componentHasCountdown" class="ve-muted">
              Se enlazará automáticamente al temporizador de este componente (<code>data-countdown</code>) al enviar a producción.
            </p>
            <p v-else-if="trig.on === 'countdown.complete' && !componentHasCountdown" class="ve-muted ve-warn">
              Este componente no tiene una cuenta regresiva (<code>data-countdown</code>), así que este disparador no se activará. Usa una plantilla de cuenta regresiva.
            </p>
            <div v-for="(act, ai) in trig.actions" :key="ai" class="ve-action">
              <div class="ve-action-head">
                <select :value="act.kind" @change="setActionKind(act, ($event.target as HTMLSelectElement).value as any)">
                  <option v-for="ak in ACTION_KINDS" :key="ak.v" :value="ak.v">{{ ak.label }}</option>
                </select>
                <button class="danger" @click="removeAction(ti, ai)" title="Quitar acción">✕</button>
              </div>
              <select
                v-if="act.kind === 'scene.activate' && collections.length"
                :value="act.target ?? ''"
                @change="setActionTarget(act, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">— elige una colección —</option>
                <option v-for="c in collections" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
              <input
                v-else-if="act.kind === 'scene.activate'"
                :value="act.target ?? ''" placeholder="id de la colección"
                @input="setActionTarget(act, ($event.target as HTMLInputElement).value)"
              />
              <select
                v-else-if="act.kind === 'element.show' || act.kind === 'element.hide' || act.kind === 'element.delete'"
                :value="act.target ?? ''"
                @change="setActionTarget(act, ($event.target as HTMLSelectElement).value)"
              >
                <option value="" disabled>Elige un componente…</option>
                <option v-for="o in targetOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
              </select>
              <template v-else-if="act.kind === 'element.update'">
                <select :value="act.target ?? ''" @change="setActionTarget(act, ($event.target as HTMLSelectElement).value)">
                  <option value="" disabled>Elige un componente…</option>
                  <option v-for="o in targetOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
                </select>
                <input :value="act.updates?.content ?? ''" placeholder="nuevo texto" @input="setActionContent(act, ($event.target as HTMLInputElement).value)" />
              </template>
              <div v-else-if="act.kind === 'variables.update'" class="ve-inline">
                <input :value="actionVarKey(act)" placeholder="variable" @input="setActionVar(act, ($event.target as HTMLInputElement).value, actionVarVal(act))" />
                <input :value="actionVarVal(act)" placeholder="valor" @input="setActionVar(act, actionVarKey(act), ($event.target as HTMLInputElement).value)" />
              </div>
              <SoundPicker
                v-else-if="act.kind === 'sound.play'"
                :model-value="act.sound"
                @update:model-value="act.sound = $event"
              />
            </div>
            <button class="ve-add-sub" @click="addAction(ti)">＋ Acción</button>
          </div>
          <button class="ve-add-sub ve-add-trigger" @click="addTrigger">＋ Disparador</button>
        </div>
      </template>
      <div v-else class="ve-note">Selecciona un elemento del árbol para editar su visibilidad y eventos.</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.visual-editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}
.ve-tree {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--app-line);
  max-height: 32%;
}
.ve-tree-actions {
  display: flex;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--app-line);
}
.ve-tree-actions button {
  background: var(--app-raised);
  border: 1px solid var(--app-line);
  color: var(--app-ink);
  border-radius: 4px;
  padding: 5px 9px;
  font-size: 12px;
  cursor: pointer;
}
.ve-tree-actions button:hover:not(:disabled) { background: var(--app-hover); }
.ve-tree-actions button:disabled { opacity: 0.4; cursor: not-allowed; }
.ve-tree-actions button.danger:hover:not(:disabled) { background: #5a2020; border-color: #a33; }
.ve-tree-list { overflow-y: auto; flex: 1; }
.ve-tree-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--app-ink);
  border-bottom: 1px solid var(--app-line);
  white-space: nowrap;
  overflow: hidden;
}
.ve-tree-row:hover { background: var(--app-hover); }
.ve-tree-row.selected { background: var(--app-selected-bg); border-left: 2px solid var(--app-selected-line); color: #fff; }
.ve-tag {
  background: var(--app-line);
  color: var(--app-accent);
  border-radius: 3px;
  padding: 1px 6px;
  font-size: 11px;
  flex-shrink: 0;
}
.ve-label { overflow: hidden; text-overflow: ellipsis; opacity: 0.85; }
.ve-empty { padding: 14px; color: var(--app-faint); font-size: 12px; }

.ve-inspector {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
/* Sticky tab strip above the scrolling panes. */
.ve-tabs {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 10px 12px;
  background: var(--app-panel);
  border-bottom: 1px solid var(--app-line);
}
.ve-tabpane {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ve-section-title { color: #fff; font-size: 13px; font-weight: 700; }
.ve-subtitle { color: var(--app-accent); font-size: 11px; text-transform: uppercase; letter-spacing: var(--tracking-label); margin-top: 2px; }
.ve-field { display: flex; flex-direction: column; gap: 4px; color: var(--app-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
.ve-field.wide { grid-column: 1 / -1; }
.ve-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.ve-inline { display: flex; align-items: center; gap: 8px; }
.ve-checkbox { color: var(--app-ink); font-size: 12px; text-transform: none; letter-spacing: 0; flex-direction: row; }
.ve-unit { color: var(--app-faint); font-size: 11px; }
.ve-muted { color: var(--app-faint); font-size: 11px; margin: 0 0 4px; text-transform: none; letter-spacing: 0; }
.ve-note {
  background: #1f2a3a; border: 1px solid #2d4663; color: #cfe2ff;
  border-radius: 6px; padding: 8px 10px; font-size: 11.5px; line-height: 1.4;
}
.ve-note code { background: rgba(255,255,255,0.08); padding: 0 4px; border-radius: 3px; }

.ve-panel {
  border: 1px solid var(--app-line);
  border-radius: 6px;
  background: var(--app-panel);
}
.ve-panel > summary {
  cursor: pointer;
  padding: 9px 12px;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  user-select: none;
}
.ve-panel[open] > summary { border-bottom: 1px solid var(--app-line); }
.ve-panel-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.ve-add-var { display: flex; gap: 6px; align-items: center; }
.ve-add-var input { flex: 1; }
.ve-add-var button {
  background: var(--app-raised); border: 1px solid var(--app-line); color: var(--app-ink);
  border-radius: 4px; padding: 6px 10px; cursor: pointer;
}
.ve-add-var button:disabled { opacity: 0.4; cursor: not-allowed; }
.ve-add-var input.invalid { border-color: #b4533a; }
.ve-warn { color: #e0a08a; }

/* Events / Actions */
.ve-events { display: flex; flex-direction: column; gap: 10px; }
.ve-trigger { border: 1px solid var(--app-line); border-radius: 6px; padding: 10px; background: var(--app-panel); display: flex; flex-direction: column; gap: 8px; }
.ve-trigger-head { display: flex; align-items: center; gap: 8px; }
.ve-trigger-head select { flex: 1; }
.ve-when { color: var(--app-accent); font-size: 11px; text-transform: uppercase; }
.ve-action { border-left: 2px solid var(--app-accent-line); padding: 6px 0 6px 10px; margin-left: 4px; display: flex; flex-direction: column; gap: 6px; }
.ve-action-head { display: flex; align-items: center; gap: 8px; }
.ve-action-head select { flex: 1; }
.ve-action .ve-inline input { flex: 1; }
.ve-action input, .ve-trigger input { width: 100%; box-sizing: border-box; }
.ve-add-sub {
  align-self: flex-start;
  background: var(--app-raised); border: 1px solid var(--app-line); color: var(--app-ink);
  border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer;
}
.ve-add-sub:hover { background: var(--app-hover); }
.ve-add-trigger { align-self: stretch; text-align: center; }
.ve-trigger-head button.danger, .ve-action-head button.danger {
  background: var(--app-raised); border: 1px solid var(--app-line); color: #c98; border-radius: 4px;
  padding: 4px 8px; cursor: pointer; flex-shrink: 0;
}
.ve-trigger-head button.danger:hover, .ve-action-head button.danger:hover { background: #5a2020; border-color: #a33; }

.ve-inspector input,
.ve-inspector select,
.ve-inspector textarea {
  background: var(--surface-inset);
  border: 1px solid var(--app-line);
  color: var(--app-ink);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 13px;
  font-family: inherit;
}
.ve-inspector input[type='checkbox'] { width: auto; }
.ve-inspector input:focus,
.ve-inspector select:focus,
.ve-inspector textarea:focus { outline: none; border-color: var(--brand, #9333ea); box-shadow: var(--focus-ring); }

/* Color swatches */
.ve-swatch-row { display: flex; align-items: center; gap: 6px; }
.ve-swatch-row input:not([type='color']) { flex: 1; min-width: 0; }
.ve-inspector input.ve-swatch {
  width: 34px; height: 30px; padding: 2px; flex-shrink: 0; cursor: pointer;
  background: var(--surface-inset); border: 1px solid var(--app-line); border-radius: 4px;
}

/* Typography: segmented buttons + stepper */
.ve-seg { display: flex; gap: 4px; }
.ve-seg button {
  flex: 1; background: var(--app-raised); border: 1px solid var(--app-line); color: var(--app-ink);
  border-radius: 4px; padding: 5px 0; font-size: 11px; cursor: pointer;
}
.ve-seg button:hover { background: var(--app-hover); }
.ve-seg button.active { background: #3b1f63; border-color: var(--brand, #9333ea); color: #fff; }
.ve-stepper { display: flex; align-items: center; gap: 4px; }
.ve-stepper input { flex: 1; min-width: 0; text-align: center; }
.ve-stepper button {
  background: var(--app-raised); border: 1px solid var(--app-line); color: var(--app-ink);
  border-radius: 4px; padding: 5px 9px; font-size: 13px; cursor: pointer; flex-shrink: 0;
}
.ve-stepper button:hover { background: var(--app-hover); }

/* Anchor positioning grid */
.ve-anchor-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px;
  width: 96px; aspect-ratio: 16 / 9;
}
.ve-anchor {
  display: flex; align-items: center; justify-content: center;
  background: var(--app-raised); border: 1px solid var(--app-line); border-radius: 3px; cursor: pointer; padding: 0;
}
.ve-anchor span { width: 5px; height: 5px; border-radius: 50%; background: var(--app-faint); }
.ve-anchor:hover { background: var(--app-hover); border-color: var(--brand, #9333ea); }
.ve-anchor:hover span { background: #e9d5ff; }

/* Motion preset chips */
.ve-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ve-chip {
  background: var(--app-raised); border: 1px solid var(--app-line); color: var(--app-ink);
  border-radius: 14px; padding: 4px 12px; font-size: 11px; cursor: pointer;
}
.ve-chip:hover { background: var(--app-hover); border-color: var(--brand, #9333ea); }
</style>
