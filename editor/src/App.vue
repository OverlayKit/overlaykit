<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import CodeEditor from './components/CodeEditor.vue';
import VisualEditor from './components/VisualEditor.vue';
import LayoutComposer from './components/LayoutComposer.vue';
import ActionsManager from './components/ActionsManager.vue';
import TopBar from './components/TopBar.vue';
import ElementRenderer from '@overlaykit/renderer/components/ElementRenderer.vue';
import { parseHtmlToElements, createStyleElement, elementsToHtml, extractStyleCss } from './utils/converter';
import { ElementNode } from '@overlaykit/renderer/types/element';
import { templateCategories, type EditorTemplate } from './templates';
import { designSystems, tokensToCss, normalizeTokens, type DesignTokens } from './design/tokens';
import { injectMotionPatterns } from '@overlaykit/renderer/services/motionPatterns';
import { useStageZoom } from './composables/useStageZoom';

// --- State ---
const appMode = ref<'component' | 'layout' | 'actions'>('component');
const activeTab = ref<'templates' | 'visual' | 'code' | 'variables' | 'payload'>('templates');

// HTML/CSS (Code Tab)
const htmlCode = ref(`<main>
   <div id="animation-1" class="animation">
    <div class="red">/</div>
    <div class="white light mask">
      <div>{{user.firstName}}</div>
    </div>
    <div class="white light mask">
      <div>{{user.lastName}}</div>
    </div>
  </div>
</main>`);

const cssCode = ref(`:root {
  --red: #cf4c4e;
}
.animation {
  width: 20em;
  height: 4em;
  margin: 1em auto;
  position: relative;
  font-family: sans-serif;
  text-transform: uppercase;
}
.red { color: var(--red); }
.white { color: white; }
.light { font-weight: 300; }
.mask { overflow: hidden; position: relative; }

@keyframes animation-1-slash {
  0% { opacity: 0; transform: translate3d(6em, 0, 0); }
  45% { opacity: 1; }
  50% { transform: translate3d(0, 0, 0); }
}

#animation-1 > div:first-child {
  font-size: 4.8em;
  top: -.13em;
  position: absolute;
  animation: 4s cubic-bezier(.19, .76, .32 ,1) infinite alternate both animation-1-slash;
}
`);

// Variables (Variables Tab)
const variablesCode = ref(`{
  "user": {
    "firstName": "Frederic",
    "lastName": "Colins"
  }
}`);

// Canvas (overlay frame) natural size — everything renders inside this stage.
// Orientation drives 16:9 (landscape) vs 9:16 (portrait, mobile/Shorts); the
// chosen orientation ships in the scene so the overlay renders to match.
const orientation = ref<'landscape' | 'portrait'>('landscape');
const canvas = computed(() => (orientation.value === 'portrait' ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 }));

// Canvas zoom/fit (scale, sizer, stage transform, fit-on-resize) — shared with
// LayoutComposer via useStageZoom; dims follow the orientation-aware canvas.
const containerRef = ref<HTMLElement | null>(null);
const { scale, sizerStyle, stageStyle: canvasStyle, setScale, fit: fitToView } =
    useStageZoom(() => canvas.value, containerRef, { maxScale: 3, pad: 32 });

// Flip 16:9 ↔ 9:16, then re-fit on the next tick (the new dims change the
// best-fit scale; fitToView clears userZoomed so the stage recenters).
const toggleOrientation = () => {
    orientation.value = orientation.value === 'landscape' ? 'portrait' : 'landscape';
    nextTick(() => fitToView());
};

onMounted(() => {
    // Canvas fit + resize observer are owned by useStageZoom (its own hooks).
    // Motion patterns (.dsm-enter/.dsm-pop/.dsm-pulse, reduced-motion, kill switch)
    // so DS component entrances/emphasis read the --ds-* motion tokens in preview.
    injectMotionPatterns(document);
    connectThemeFeed();
    savedComponents.value = loadSavedComponents();
});
onBeforeUnmount(() => {
    // Stop the feed BEFORE close(): onclose fires on a later tick, so flag + null
    // it now or it would schedule a reconnect the clearTimeout can't cancel.
    themeFeedClosed = true;
    if (themeWs) themeWs.onclose = null;
    themeWs?.close();
    if (themeReconnect) clearTimeout(themeReconnect);
});

// Live design systems pushed over WebSocket by POST /api/design-systems are
// appended to the theme picker so the Visual tab can apply them.
const WS_URL = (import.meta as any).env?.VITE_WS_URL || 'ws://localhost:8080/ws';
let themeWs: WebSocket | null = null;
let themeReconnect: ReturnType<typeof setTimeout> | null = null;
let themeFeedClosed = false;
// Reactive connection state for the TopBar StatusDot (the socket itself is a
// non-reactive `let`).
const themeConnected = ref(false);
// "Recibidos por IA" tray: themes pushed live that the user can apply on demand.
// We never auto-apply — silently re-skinning the active theme could clobber work
// the streamer is mid-edit on. Newest first; capped so the chip list stays compact.
const receivedThemes = ref<DesignTokens[]>([]);
function receiveTheme(ds: any) {
    if (!ds || !ds.tokens) return;
    const t = normalizeTokens(ds.tokens, ds.name || 'Tema IA');
    // Keep feeding the preset list so the Visual tab's Design System picker lists it.
    const idx = customThemes.value.findIndex((x) => x.name === t.name);
    if (idx >= 0) customThemes.value[idx] = t; else customThemes.value.push(t);
    // Surface it in the tray for one-click apply instead of auto-skinning the live
    // theme (de-dupe by name, newest first, keep the last 5).
    receivedThemes.value = [t, ...receivedThemes.value.filter((x) => x.name !== t.name)].slice(0, 5);
    showToast(`Tema "${t.name}" recibido ✓`, 'success');
}
// One-click apply from the tray: set the working token set to a clone (visualTokens
// is a static snapshot) and drop the chip from the tray.
function applyReceivedTheme(t: DesignTokens) {
    visualTokens.value = { ...t };
    receivedThemes.value = receivedThemes.value.filter((x) => x.name !== t.name);
    showToast(`Tema "${t.name}" aplicado ✓`, 'success');
}
function dismissReceivedTheme(t: DesignTokens) {
    receivedThemes.value = receivedThemes.value.filter((x) => x.name !== t.name);
}
function connectThemeFeed() {
    try {
        themeWs = new WebSocket(WS_URL);
        themeWs.onopen = () => { themeConnected.value = true; themeWs?.send(JSON.stringify({ type: 'subscribe', channelId })); };
        themeWs.onmessage = (ev) => {
            try {
                const m = JSON.parse(ev.data);
                if (m.type === 'design.system') receiveTheme(m.designSystem);
                else if (m.type === 'subscription.confirmed' && m.state?.designSystem) receiveTheme(m.state.designSystem);
            } catch { /* ignore non-JSON frames */ }
        };
        themeWs.onclose = () => { themeConnected.value = false; if (!themeFeedClosed) themeReconnect = setTimeout(connectThemeFeed, 3000); };
        themeWs.onerror = () => themeWs?.close();
    } catch (e) {
        console.error('theme feed connect failed', e);
    }
}

const codeElements = ref<ElementNode[]>([]);
const parsedVariables = ref<Record<string, any>>({});
const isSending = ref(false);

// Server base URL — localStorage is the primary store; the server is a best-effort
// cross-device backup (see saveComponentToServer). Matches LayoutComposer's convention.
const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3000';

// Target channel for sends/backups. Read from ?channel= so a Componente send lands
// on the same channel the streamer's overlay is subscribed to (defaults to 'main').
const channelId = new URLSearchParams(location.search).get('channel') || 'main';
const showId = new URLSearchParams(location.search).get('show');

// Authoring mode: 'code' (HTML/CSS) or 'visual' (structured tree)
const authoringMode = ref<'code' | 'visual'>('code');

// Cloud handoff: the dashboard "Editar" button opens the editor on a saved scene
// via ?collection=<id>. Fetch it and hydrate code mode (HTML/CSS/variables) from
// the scene so the operator can tweak and re-send. Best-effort: silent if the
// server is offline or the id is unknown (so the editor still opens normally).
const collectionParam = new URLSearchParams(location.search).get('collection');
if (collectionParam) {
    onMounted(async () => {
        try {
            const r = await fetch(`${API}/api/collections/${encodeURIComponent(collectionParam)}`, { credentials: 'include' });
            if (!r.ok) return;
            const j = await r.json();
            const scene = j?.data?.scene;
            if (!scene || !Array.isArray(scene.elements)) return;
            const css = extractStyleCss(scene.elements);
            if (css) cssCode.value = css;
            htmlCode.value = elementsToHtml(scene.elements);
            if (j.data.variables && typeof j.data.variables === 'object') {
                variablesCode.value = JSON.stringify(j.data.variables, null, 2);
            }
            authoringMode.value = 'code';
            updatePreview();
            showToast(`Escena "${scene.name || collectionParam}" cargada`, 'success');
        } catch {
            /* server offline / not found — editor opens with its defaults */
        }
    });
}

// Visual mode: a structured ElementNode tree of the EDITABLE elements only. The
// component's own CSS (componentStyleEl) and the Design System tokens
// (themeStyleEl) ride alongside as separate <style> nodes so they never appear
// as editable rows in the tree.
const visualTree = ref<ElementNode[]>([
    {
        id: 'v-root',
        tag: 'div',
        content: 'Hola {{user.firstName}}',
        styles: { color: '#ffffff', fontSize: '40px', fontWeight: '700', padding: '16px', fontFamily: 'system-ui, sans-serif' },
    },
]);
// The loaded component's class-based CSS (DS components style via var(--ds-*) in
// a <style> node, not inline styles). Kept out of the editable tree.
const componentStyleEl = ref<ElementNode | null>(null);
// Variables object that drives {{...}} interpolation in visual mode (structured
// editor in the Visual tab edits this directly).
const visualVariables = ref<Record<string, any>>({ user: { firstName: 'Frederic', lastName: 'Colins' } });
// Design System: the working token set for visual mode (null = no theme, use the
// components' baked-in var() fallbacks). The Visual tab picks a preset + tweaks.
const visualTokens = ref<DesignTokens | null>(null);
// Live-pushed themes appended to the built-in presets.
const customThemes = ref<DesignTokens[]>([]);
const themePresets = computed<DesignTokens[]>(() => [...designSystems, ...customThemes.value]);
// The --ds-* <style> node for the active token set, prepended to the scene.
const themeStyleEl = computed<ElementNode | null>(() =>
    visualTokens.value ? { id: 'ds-theme', tag: 'style', content: tokensToCss(visualTokens.value), styles: {} } : null
);

// The preview + payload render the active authoring mode's elements. In visual
// mode we prepend the theme + component style nodes so DS components are themed.
const renderElements = computed<ElementNode[]>(() => {
    if (authoringMode.value !== 'visual') return codeElements.value;
    return [
        ...(themeStyleEl.value ? [themeStyleEl.value] : []),
        ...(componentStyleEl.value ? [componentStyleEl.value] : []),
        ...visualTree.value,
    ];
});

// Variables feeding the preview/payload depend on the active authoring mode.
const activeVariables = computed(() => (authoringMode.value === 'visual' ? visualVariables.value : parsedVariables.value));

// Pair each renderable with the scene-intro staggerIndex (skipping <style>/<script>
// nodes), exactly like the production overlay (ProductionView), so the preview's
// entrance choreography matches what ships — the Motion `stagger` token is otherwise
// un-previewable and multi-component scenes diverge.
const staggeredRenderElements = computed(() => {
    let i = 0;
    return renderElements.value.map((element) => ({
        element,
        staggerIndex: element.tag === 'style' || element.tag === 'script' ? undefined : i++,
    }));
});

// --- Saved components ("Mis componentes") ---
// A saved component is a LOSSLESS snapshot of the current working state. Because the
// authoring source of truth differs by mode (Code → html/css/variables strings;
// Visual → visualTree/visualVariables/visualTokens/componentStyleEl, with htmlCode NOT
// regenerated from the tree), we snapshot BOTH representations so loading round-trips
// regardless of which tab the user authored in.
interface SavedComponent {
    id: string;
    name: string;
    createdAt: number;
    authoringMode: 'code' | 'visual';
    activeTab: 'templates' | 'visual' | 'code' | 'variables' | 'payload';
    htmlCode: string;
    cssCode: string;
    variablesCode: string;
    visualTree: ElementNode[];
    componentStyleEl: ElementNode | null;
    visualVariables: Record<string, any>;
    visualTokens: DesignTokens | null;
}

const COMPONENTS_KEY = 'overlaykit:components';
const savedComponents = ref<SavedComponent[]>([]);

// JSON deep clone — deepClone() throws DataCloneError on Vue reactive
// proxies, and our snapshots are plain JSON (ElementNode trees, token objects),
// so a JSON round-trip is both correct and proxy-safe.
function deepClone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
}

const slug = (s: string) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cmp';

function loadSavedComponents(): SavedComponent[] {
    try {
        const list = JSON.parse(localStorage.getItem(COMPONENTS_KEY) || '[]');
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}
function saveSavedComponents(list: SavedComponent[]) {
    localStorage.setItem(COMPONENTS_KEY, JSON.stringify(list));
}

// Dirty tracking: true once the user mutates any authoring source. Cleared on every
// load (template or saved component) and on save, so the dirty-guard only prompts when
// there is genuinely unsaved work to lose. The deep watch fires once immediately at
// setup — we swallow that first fire so the editor doesn't open "dirty".
const dirty = ref(false);
let dirtyArmed = false;
watch(
    [htmlCode, cssCode, variablesCode, visualTree, visualVariables, visualTokens],
    () => { if (dirtyArmed) dirty.value = true; },
    { deep: true, immediate: true }
);
dirtyArmed = true;

// Best-effort cross-device backup. localStorage is authoritative; never let a server
// outage block a local save.
async function saveComponentToServer(snap: SavedComponent) {
    try {
        await fetch(`${API}/api/collections`, { credentials: 'include',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: snap.id,
                name: snap.name,
                channelId,
                scene: { id: snap.id, name: snap.name, elements: renderElements.value },
                variables: activeVariables.value,
            }),
        });
    } catch {
        /* server offline — localStorage already holds the component */
    }
}

function saveComponent() {
    const name = (window.prompt('Nombre del componente') || '').trim();
    if (!name) return;
    const snap: SavedComponent = {
        id: 'cmp-' + slug(name) + '-' + Date.now(),
        name,
        createdAt: Date.now(),
        authoringMode: authoringMode.value,
        activeTab: activeTab.value,
        htmlCode: htmlCode.value,
        cssCode: cssCode.value,
        variablesCode: variablesCode.value,
        visualTree: deepClone(visualTree.value),
        componentStyleEl: componentStyleEl.value ? deepClone(componentStyleEl.value) : null,
        visualVariables: deepClone(visualVariables.value),
        visualTokens: visualTokens.value ? deepClone(visualTokens.value) : null,
    };
    savedComponents.value = [...savedComponents.value, snap];
    saveSavedComponents(savedComponents.value);
    dirty.value = false;
    showToast('Componente guardado ✓', 'success');
    void saveComponentToServer(snap);
}

function loadSavedComponent(c: SavedComponent) {
    if (dirty.value && !window.confirm('Reemplazar el trabajo actual sin guardar?')) return;
    htmlCode.value = c.htmlCode;
    cssCode.value = c.cssCode;
    variablesCode.value = c.variablesCode;
    visualTree.value = deepClone(c.visualTree);
    componentStyleEl.value = c.componentStyleEl ? deepClone(c.componentStyleEl) : null;
    visualVariables.value = deepClone(c.visualVariables);
    visualTokens.value = c.visualTokens ? deepClone(c.visualTokens) : null;
    authoringMode.value = c.authoringMode;
    activeTab.value = c.activeTab || 'visual';
    dirty.value = false;
}

function deleteSavedComponent(c: SavedComponent) {
    if (!window.confirm(`Eliminar "${c.name}"?`)) return;
    savedComponents.value = savedComponents.value.filter((x) => x.id !== c.id);
    saveSavedComponents(savedComponents.value);
}

// Non-blocking send feedback (toast)
const toast = ref<{ message: string; type: 'success' | 'error' } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
const showToast = (message: string, type: 'success' | 'error') => {
    toast.value = { message, type };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.value = null; }, 2800);
};

// Replay entrance animations (re-mount the preview subtree)
const previewKey = ref(0);
const replayAnimations = () => { previewKey.value++; };

// Preview background: see the overlay over different stream backdrops
const previewBg = ref<'transparent' | 'dark' | 'light'>('transparent');
const previewBgLabel = computed(() => ({ transparent: 'Transparente', dark: 'Oscuro', light: 'Claro' }[previewBg.value]));
const cyclePreviewBg = () => {
    previewBg.value = previewBg.value === 'transparent' ? 'dark' : previewBg.value === 'dark' ? 'light' : 'transparent';
};

// Layout State
const sidebarWidth = ref(500); // px
const isSidebarVisible = ref(true);
const isResizing = ref(false);

// --- Logic ---

const updatePreview = () => {
    try {
        // Parse HTML/CSS
        const domElements = parseHtmlToElements(htmlCode.value);
        const styleElement = createStyleElement(cssCode.value);
        codeElements.value = [styleElement, ...domElements];

        // Parse Variables
        parsedVariables.value = JSON.parse(variablesCode.value);
    } catch (e) {
        console.error("Parse error:", e);
    }
};

// Full Payload Construction (for Inspector & Sending)
// clearPrevious: true so a Componente send REPLACES whatever scene is live (e.g. a
// prior Layout activation) instead of ambiguously merging onto it. The server reads
// clearPrevious from the body of POST /api/scenes/activate (defaults to true there).
const fullPayload = computed(() => {
    return JSON.stringify({
        channelId,
        clearPrevious: true,
        scene: {
            id: "editor-preview",
            name: "Editor Preview",
            elements: renderElements.value,
            orientation: orientation.value
        },
        variables: activeVariables.value
    }, null, 2);
});

// Send the current runtime snapshot to Preview. Legacy standalone use keeps the
// channel activation endpoint until it is opened from a Show-aware Studio URL.
const sendToProduction = async () => {
    isSending.value = true;
    try {
        const path = showId
            ? `/api/shows/${encodeURIComponent(showId)}/production/preview`
            : '/api/scenes/activate';
        const body = showId
            ? JSON.stringify({ scene: JSON.parse(fullPayload.value).scene, variables: activeVariables.value })
            : fullPayload.value;
        const res = await fetch(`${API}${path}`, { credentials: 'include',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        showToast(showId ? 'Enviado a Preview' : 'Escena activada', 'success');
    } catch (e) {
        showToast('Error al enviar: ' + e, 'error');
    } finally {
        isSending.value = false;
    }
};

// Load a starter template into the editor and drop the user straight into the
// Visual GUI so they customize the chosen component (content, variables, design
// system, motion, position) instead of starting from zero. The Code/Variables
// tabs are kept in sync so power users can still drop to code.
const loadTemplate = (t: EditorTemplate) => {
    if (dirty.value && !window.confirm('Reemplazar el trabajo actual sin guardar?')) return;
    htmlCode.value = t.html;
    cssCode.value = t.css;
    variablesCode.value = t.variables;
    try {
        visualTree.value = parseHtmlToElements(t.html);
        componentStyleEl.value = t.css && t.css.trim()
            ? { ...createStyleElement(t.css), id: `tpl-style-${t.id}` }
            : null;
        visualVariables.value = t.variables ? JSON.parse(t.variables) : {};
    } catch (e) {
        console.error('loadTemplate parse error:', e);
    }
    activeTab.value = 'visual';
    dirty.value = false;
};

// Resize Logic
const startResize = () => {
    isResizing.value = true;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', stopResize);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none'; // Prevent selection during drag
};

const handleMouseMove = (e: MouseEvent) => {
    if (isResizing.value) {
        // Clamp width between 300px and 800px (or window width - 200px)
        const newWidth = Math.max(300, Math.min(e.clientX, window.innerWidth - 300));
        sidebarWidth.value = newWidth;
    }
};

const stopResize = () => {
    isResizing.value = false;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', stopResize);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
};

// Toggle Sidebar
const toggleSidebar = () => {
    isSidebarVisible.value = !isSidebarVisible.value;
};

watch([htmlCode, cssCode, variablesCode], updatePreview, { immediate: true });

// Tie the authoring mode to the active authoring tab (Visual / Code); other tabs
// keep the last authoring mode so the preview and payload stay consistent.
watch(activeTab, (t) => {
    if (t === 'visual') authoringMode.value = 'visual';
    else if (t === 'code') authoringMode.value = 'code';
});

</script>

<template>
  <div class="app-root">
    <TopBar
      :mode="appMode"
      :channel="channelId"
      :dirty="dirty"
      :connected="themeConnected"
      :sending="isSending"
      :show-primary="appMode === 'component'"
      @update:mode="appMode = $event as typeof appMode"
      @activate="sendToProduction"
    />

    <LayoutComposer v-if="appMode === 'layout'" />
    <ActionsManager v-else-if="appMode === 'actions'" />

    <div v-else class="editor-layout">
    <div
        class="sidebar"
        v-show="isSidebarVisible"
        :style="{ width: `${sidebarWidth}px` }"
    >
        <div class="tabs">
            <button :class="{ active: activeTab === 'templates' }" @click="activeTab = 'templates'">Plantillas</button>
            <button :class="{ active: activeTab === 'visual' }" @click="activeTab = 'visual'">Visual</button>
            <button :class="{ active: activeTab === 'code' }" @click="activeTab = 'code'">Código</button>
            <button :class="{ active: activeTab === 'variables' }" @click="activeTab = 'variables'">Variables</button>
            <button :class="{ active: activeTab === 'payload' }" @click="activeTab = 'payload'">Payload</button>
        </div>

        <!-- TEMPLATES TAB -->
        <div v-show="activeTab === 'templates'" class="tab-content templates-tab">
            <div class="templates-intro">
                <h3>Plantillas</h3>
                <p>Elige una plantilla para empezar sin fricción y personalízala.</p>
            </div>
            <div class="templates-scroll">
                <!-- Mis componentes: snapshots saved from the current working state. Shown
                     first, above the built-in categories. Hidden entirely when empty. -->
                <div v-if="savedComponents.length" class="template-category">
                    <div class="template-category-name">Mis componentes</div>
                    <div class="template-grid">
                        <div v-for="c in savedComponents" :key="c.id" class="template-card">
                            <div class="template-card-name">{{ c.name }}</div>
                            <div class="template-card-desc">
                                {{ c.authoringMode === 'visual' ? 'Visual' : 'Código' }} · guardado
                            </div>
                            <div class="saved-card-actions">
                                <button class="template-use-btn" @click="loadSavedComponent(c)">Usar</button>
                                <button class="saved-delete-btn" title="Eliminar" @click="deleteSavedComponent(c)">🗑</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-for="cat in templateCategories" :key="cat.id" class="template-category">
                    <div class="template-category-name">{{ cat.name }}</div>
                    <div class="template-grid">
                        <div v-for="t in cat.templates" :key="t.id" class="template-card">
                            <div class="template-card-name">{{ t.name }}</div>
                            <div class="template-card-desc">{{ t.description }}</div>
                            <button class="template-use-btn" @click="loadTemplate(t)">Usar / Personalizar</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- VISUAL TAB -->
        <div v-show="activeTab === 'visual'" class="tab-content">
            <VisualEditor
                :tree="visualTree"
                :variables="visualVariables"
                :tokens="visualTokens"
                :themes="themePresets"
                @update:tokens="visualTokens = $event"
            />
        </div>

        <!-- CODE TAB -->
        <div v-show="activeTab === 'code'" class="tab-content code-split">
            <div class="panel">
                <h3>HTML</h3>
                <CodeEditor v-model="htmlCode" language="html" />
            </div>
            <div class="panel">
                <h3>CSS</h3>
                <CodeEditor v-model="cssCode" language="css" />
            </div>
        </div>

        <!-- VARIABLES TAB -->
        <div v-show="activeTab === 'variables'" class="tab-content">
            <div class="panel">
                <h3>Variables (JSON)</h3>
                <CodeEditor v-model="variablesCode" language="json" />
            </div>
        </div>

        <!-- PAYLOAD TAB -->
        <div v-show="activeTab === 'payload'" class="tab-content">
            <div class="panel">
                <h3>Payload generado (solo lectura)</h3>
                <CodeEditor :model-value="fullPayload" language="json" />
            </div>
        </div>
    </div>

    <!-- Resizer Handle -->
    <div 
        class="resizer" 
        v-show="isSidebarVisible"
        @mousedown="startResize"
        :class="{ resizing: isResizing }"
    ></div>

    <div class="preview-area">
      <div class="toolbar">
        <div class="left-controls">
             <button class="icon-btn" @click="toggleSidebar" title="Toggle Sidebar">
                {{ isSidebarVisible ? '◀' : '▶' }}
            </button>
            <div class="zoom-controls">
                <span>Scale: {{ Math.round(scale * 100) }}%</span>
                <button @click="setScale(scale - 0.1)" title="Alejar">-</button>
                <button @click="setScale(scale + 0.1)" title="Acercar">+</button>
                <button class="icon-btn" @click="fitToView" title="Ajustar a la vista">Ajustar</button>
            </div>
            <button class="icon-btn" @click="toggleOrientation" :title="orientation === 'landscape' ? 'Cambiar a vertical (9:16)' : 'Cambiar a horizontal (16:9)'">
                {{ orientation === 'portrait' ? '▯ 9:16' : '▭ 16:9' }}
            </button>
            <button class="icon-btn" @click="replayAnimations" title="Reproducir animaciones de entrada">▶ Reproducir</button>
            <button class="icon-btn" @click="cyclePreviewBg" title="Fondo de la vista previa">Fondo: {{ previewBgLabel }}</button>
        </div>

        <div class="actions">
            <button class="icon-btn save-btn" @click="saveComponent" title="Guardar componente en Mis componentes">
                💾 Guardar componente
            </button>
        </div>
      </div>
      
      <div class="canvas-container" :class="`bg-${previewBg}`" ref="containerRef">
        <div class="canvas-sizer" :style="sizerStyle">
            <div class="canvas" :style="canvasStyle">
                <div :key="previewKey" style="display: contents">
                    <template v-for="item in staggeredRenderElements" :key="item.element.id">
                        <ElementRenderer :element="item.element" :variables="activeVariables" :stagger-index="item.staggerIndex" />
                    </template>
                </div>
            </div>
        </div>
      </div>
    </div>

    <!-- Received themes pushed live by the local API. One-click "Aplicar" instead of auto-skinning the active theme. -->
    <div v-if="receivedThemes.length" class="ai-tray">
        <div class="ai-tray-head">Temas recibidos</div>
        <div v-for="t in receivedThemes" :key="t.name" class="ai-chip">
            <span class="ai-chip-swatch" :style="{ background: t.grad }"></span>
            <span class="ai-chip-name" :title="t.name">{{ t.name }}</span>
            <button class="ai-chip-apply" @click="applyReceivedTheme(t)" title="Aplicar este tema">Aplicar</button>
            <button class="ai-chip-x" @click="dismissReceivedTheme(t)" title="Descartar">✕</button>
        </div>
    </div>

    <div v-if="toast" class="toast" :class="toast.type">{{ toast.message }}</div>
    </div>
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}
.editor-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  width: 100%;
  background: var(--app-bg);
  overflow: hidden;
}

.sidebar {
  /* Width handled by style binding */
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--app-line);
  flex-shrink: 0;
}

.resizer {
    width: 6px;
    cursor: col-resize;
    background: var(--app-panel);
    border-left: 1px solid var(--app-line);
    border-right: 1px solid var(--app-line);
    transition: background 0.2s;
    z-index: 20;
}

.resizer:hover, .resizer.resizing {
    background: var(--brand, #9333ea);
}

.tabs {
    display: flex;
    background: var(--app-panel);
    border-bottom: 1px solid var(--app-line);
}

.tabs button {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--app-muted);
    padding: 12px;
    cursor: pointer;
    font-weight: bold;
    border-right: 1px solid var(--app-line);
}

.tabs button.active {
    background: var(--app-bg);
    color: white;
    border-bottom: 2px solid var(--brand, #9333ea);
}

.tab-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.code-split {
    display: flex;
    flex-direction: column;
}

.panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.panel h3 {
  margin: 0;
  padding: 8px 12px;
  background: var(--app-bg); /* Darker than tab for contrast */
  color: var(--app-accent);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: var(--tracking-label);
  border-bottom: 1px solid var(--app-line);
  border-top: 1px solid var(--app-line);
}

.preview-area {
  flex: 1; /* Takes remaining space */
  display: flex;
  flex-direction: column;
  background: #0d1117;
  min-width: 0; /* Important for flex child to shrink properly */
}

.toolbar {
  padding: 10px 20px;
  background: var(--app-panel);
  border-bottom: 1px solid var(--app-line);
  color: white;
  display: flex;
  justify-content: space-between;
  align-items: center;
  z-index: 10;
}

.left-controls {
    display: flex;
    gap: 15px;
    align-items: center;
}

.zoom-controls {
    display: flex;
    gap: 10px;
    align-items: center;
}

.icon-btn {
    background: transparent;
    border: 1px solid var(--app-line);
    color: var(--app-ink);
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
}

.icon-btn:hover {
    background: var(--app-hover);
    color: white;
}

.actions {
    display: flex;
    align-items: center;
    gap: 10px;
}

/* Secondary save action — neutral so red stays reserved for SEND/destructive. */
.save-btn {
    padding: 8px 14px;
    font-weight: 600;
    font-size: 13px;
}

.canvas-container {
  flex: 1;
  min-height: 0; /* allow this flex child to shrink so overflow:auto works */
  display: grid;
  /* `safe center` centers the stage when it fits and falls back to start-aligned
     (scrollable) when it overflows — so the top/left is never clipped off-screen. */
  place-content: safe center;
  overflow: auto;
  padding: 32px;
}

/* Preview backdrops (does not affect the payload; only the editor canvas) */
.canvas-container.bg-transparent {
  background-image: linear-gradient(45deg, var(--app-bg) 25%, transparent 25%),
                    linear-gradient(-45deg, var(--app-bg) 25%, transparent 25%),
                    linear-gradient(45deg, transparent 75%, var(--app-bg) 75%),
                    linear-gradient(-45deg, transparent 75%, var(--app-bg) 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
}
.canvas-container.bg-dark { background: #0d1117; }
.canvas-container.bg-light { background: #e5e7eb; }

/* Non-blocking send toast */
.toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  padding: 10px 22px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  z-index: 100;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
}
.toast.success { background: var(--success, #16a34a); }
.toast.error { background: var(--danger, #dc2626); }

/* "Recibidos por IA" tray — compact floating chip list, bottom-right corner. */
.ai-tray {
  position: fixed;
  bottom: 18px;
  right: 18px;
  width: 268px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  background: var(--app-bar);
  border: 1px solid var(--app-line-strong);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  z-index: 90;
}
.ai-tray-head {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: var(--tracking-label);
  color: var(--brand-2, #22d3ee);
}
.ai-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--app-panel);
  border: 1px solid var(--app-line-strong);
  border-radius: 8px;
  padding: 6px 8px;
}
.ai-chip-swatch { width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0; }
.ai-chip-name { flex: 1; min-width: 0; font-size: 12px; color: var(--app-ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-chip-apply {
  background: linear-gradient(135deg, var(--brand, #9333ea), var(--brand-2, #22d3ee));
  color: #fff; border: none; border-radius: 5px; padding: 4px 10px;
  font-size: 11px; font-weight: 700; cursor: pointer; flex-shrink: 0;
}
.ai-chip-apply:hover { filter: brightness(1.1); }
.ai-chip-x { background: transparent; border: none; color: var(--app-muted); cursor: pointer; font-size: 12px; padding: 2px 4px; flex-shrink: 0; }
.ai-chip-x:hover { color: #fca5a5; }

/* Reserves the scaled footprint so the scroll container measures the *visible*
   size, not the unscaled 1920x1080 layout box. */
.canvas-sizer {
  position: relative;
  flex-shrink: 0;
}

.canvas {
  /* width/height bound via canvasStyle (orientation-driven) */
  background: transparent; /* Elements render on top */
  position: relative;
  transform-origin: top left; /* scale from the sizer's top-left corner */
  box-shadow: 0 0 50px rgba(0,0,0,0.5);
  border: 1px dashed var(--app-line-strong);
}

/* Templates gallery */
.templates-tab { padding: 0; }
.templates-intro { padding: 14px 16px; border-bottom: 1px solid var(--app-line); }
.templates-intro h3 { margin: 0 0 4px; color: #fff; font-size: 14px; }
.templates-intro p { margin: 0; color: var(--app-muted); font-size: 12px; }
.templates-scroll { flex: 1; overflow-y: auto; padding: 12px 16px; }
.template-category { margin-bottom: 18px; }
.template-category-name { color: var(--app-accent); font-size: 11px; text-transform: uppercase; letter-spacing: var(--tracking-label); margin-bottom: 8px; }
.template-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.template-card { background: var(--app-raised); border: 1px solid var(--app-line); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.template-card-name { color: #fff; font-weight: 600; font-size: 13px; }
.template-card-desc { color: var(--app-muted); font-size: 11px; flex: 1; }
.template-use-btn { background: var(--brand, #9333ea); color: #fff; border: none; border-radius: 4px; padding: 7px 10px; font-size: 12px; font-weight: 600; cursor: pointer; }
.template-use-btn:hover { filter: brightness(1.12); }

/* Saved component card: "Usar" stretches, delete is a compact icon at the end. */
.saved-card-actions { display: flex; gap: 6px; align-items: stretch; }
.saved-card-actions .template-use-btn { flex: 1; }
.saved-delete-btn { background: transparent; border: 1px solid var(--app-line); color: var(--app-muted); border-radius: 4px; padding: 0 9px; font-size: 13px; cursor: pointer; }
.saved-delete-btn:hover { background: #3a1d1d; border-color: #7f1d1d; color: #fca5a5; }
</style>
