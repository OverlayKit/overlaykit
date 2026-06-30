<!--
  Action bundle authoring surface.

  A non-coder names a bundle of ComponentActions (the SAME model VisualEditor uses
  for per-element triggers) and runs it from the panel or a webhook via the
  server's POST /api/actions/:id/run. The left column lists saved bundles; the right
  pane edits the selected bundle's name, channel, and ordered list of actions. Each
  action reuses VisualEditor's action-editing UX (kind <select> + kind-specific
  inputs), so the authoring vocabulary is identical across the editor.

  Targets are populated live: scene.activate offers a <select> of saved collections
  (GET /api/collections) and sound.play reuses SoundPicker (GET /api/sounds). The
  "Probar" button hits /run so the user can verify the bundle drives production
  without leaving the editor.
-->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import type { ComponentAction, ComponentActionKind } from '@overlaykit/renderer/types/element';
import SoundPicker from './SoundPicker.vue';

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3000';
// The editor's channel (?channel=…) — actions default to it and the scene-activate
// target list is scoped to it, so a streamer on 'alerts' doesn't get 'main' scenes.
const channelId = new URLSearchParams(location.search).get('channel') || 'main';

// --- Action bundle shape (matches the server contract) ---
interface ActionBundle {
  id: string;
  name: string;
  icon?: string;
  channelId?: string;
  actions: ComponentAction[];
  updatedAt?: number;
}

// --- The same ACTION_KINDS list VisualEditor exposes (identical labels) ---
const ACTION_KINDS: Array<{ v: ComponentActionKind; label: string }> = [
  { v: 'scene.activate', label: 'Cambiar de escena (colección)' },
  { v: 'element.show', label: 'Mostrar componente' },
  { v: 'element.hide', label: 'Ocultar componente' },
  { v: 'element.update', label: 'Actualizar texto del componente' },
  { v: 'element.delete', label: 'Eliminar componente' },
  { v: 'variables.update', label: 'Actualizar variable' },
  { v: 'sound.play', label: 'Reproducir sonido' },
];

// Variable names (each dot-segment) must match the server's variables.schema
// pattern, else they ship but never interpolate — same rule VisualEditor uses.
const VAR_SEGMENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// A deterministic dot colour per bundle id, so the list reads at a glance.
const DOT_COLORS = ['#22d3ee', '#a855f7', '#f59e0b', '#34d399', '#f472b6', '#60a5fa', '#fb7185', '#facc15'];
function dotColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DOT_COLORS[h % DOT_COLORS.length];
}

// --- State ---
const bundles = ref<ActionBundle[]>([]);
const selectedId = ref<string | null>(null);
const collections = ref<Array<{ id: string; name: string }>>([]);
const loading = ref(true);
const saving = ref(false);

// Per-bundle inline test result: { dispatched, errors } (or an error string).
const testResults = ref<Record<string, { dispatched?: number; errors?: any[]; failed?: string } | null>>({});
const testingId = ref<string | null>(null);

const toast = ref<{ message: string; type: 'success' | 'error' } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(message: string, type: 'success' | 'error') {
  toast.value = { message, type };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = null; }, 2800);
}

const selected = computed<ActionBundle | null>(
  () => bundles.value.find((b) => b.id === selectedId.value) ?? null
);

// --- Loading: bundles + the collections used to populate scene.activate targets ---
async function loadBundles() {
  loading.value = true;
  try {
    const res = await fetch(`${API}/api/actions`, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    bundles.value = (json?.data?.actions ?? []).map((a: any): ActionBundle => ({
      id: a.id,
      name: a.name,
      icon: a.icon,
      channelId: a.channelId ?? 'main',
      actions: Array.isArray(a.actions) ? a.actions : [],
      updatedAt: a.updatedAt,
    }));
    // Keep the selection valid across reloads; otherwise select the first bundle.
    if (!bundles.value.some((b) => b.id === selectedId.value)) {
      selectedId.value = bundles.value[0]?.id ?? null;
    }
  } catch (e) {
    showToast('No se pudieron cargar las acciones: ' + e, 'error');
  } finally {
    loading.value = false;
  }
}

async function loadCollections() {
  try {
    const res = await fetch(`${API}/api/collections?channelId=${encodeURIComponent(channelId)}`, { credentials: 'include' });
    if (!res.ok) return;
    const json = await res.json();
    collections.value = (json?.data?.collections ?? []).map((c: any) => ({ id: c.id, name: c.name }));
  } catch {
    /* offline — scene.activate target falls back to a free-text input */
  }
}

// The LIVE components of the active scene on this channel — so element.show/hide/
// update/delete offer a pick-list of real components ("¿En qué año…", "Marcador")
// instead of an unguessable id. Refreshable, since the active scene can change.
const liveElements = ref<Array<{ id: string; label: string; hidden: boolean }>>([]);
async function loadLiveElements() {
  try {
    const res = await fetch(`${API}/api/elements?channelId=${encodeURIComponent(channelId)}`, { credentials: 'include' });
    if (!res.ok) return;
    liveElements.value = (await res.json())?.data?.elements ?? [];
  } catch {
    /* offline — element targets fall back to a free-text id input */
  }
}

onMounted(() => {
  void loadBundles();
  void loadCollections();
  void loadLiveElements();
});

// --- New / select / delete ---
let localCounter = 0;
function newBundle() {
  const id = `act-${Date.now()}-${localCounter++}`;
  const b: ActionBundle = { id, name: 'Nueva acción', channelId, actions: [] };
  bundles.value = [...bundles.value, b];
  selectedId.value = id;
}

async function deleteBundle(b: ActionBundle) {
  if (!window.confirm(`Eliminar la acción "${b.name}"?`)) return;
  try {
    // Only call the server for bundles that have actually been saved there. A
    // never-saved local draft (404 on the server) is just dropped locally.
    const res = await fetch(`${API}/api/actions/${encodeURIComponent(b.id)}`, { credentials: 'include', method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error('HTTP ' + res.status);
  } catch (e) {
    showToast('Error al eliminar: ' + e, 'error');
    return;
  }
  bundles.value = bundles.value.filter((x) => x.id !== b.id);
  delete testResults.value[b.id];
  if (selectedId.value === b.id) selectedId.value = bundles.value[0]?.id ?? null;
  showToast('Acción eliminada ✓', 'success');
}

// --- Action editing (mirrors VisualEditor's setAction* helpers exactly) ---
function addAction() {
  selected.value?.actions.push({ kind: 'scene.activate' });
}
function removeAction(ai: number) {
  selected.value?.actions.splice(ai, 1);
}
function setActionKind(a: ComponentAction, kind: ComponentActionKind) {
  // Clear fields from the previous kind so the saved payload only carries what the
  // new kind uses (target is an element id for element.* but a collection id for
  // scene.activate — a stale value would persist and misdispatch).
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

// --- Save (upsert) ---
// Upsert the current bundle on the server. Shared by Guardar and Probar so the
// server always has exactly what's on screen.
async function persistBundle(b: ActionBundle): Promise<void> {
  const res = await fetch(`${API}/api/actions`, { credentials: 'include',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: b.id,
      name: (b.name || '').trim() || 'Acción',
      channelId: (b.channelId || 'main').trim() || 'main',
      actions: b.actions,
    }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

async function saveBundle() {
  const b = selected.value;
  if (!b) return;
  const name = (b.name || '').trim();
  if (!name) { showToast('Ponle un nombre a la acción', 'error'); return; }
  saving.value = true;
  try {
    await persistBundle(b);
    const keepId = b.id;
    await loadBundles();
    selectedId.value = keepId;
    showToast('Acción guardada ✓', 'success');
  } catch (e) {
    showToast('Error al guardar: ' + e, 'error');
  } finally {
    saving.value = false;
  }
}

// --- Test ("Probar"): run the bundle now and show dispatched/errors inline ---
async function runBundle(b: ActionBundle) {
  testingId.value = b.id;
  testResults.value[b.id] = null;
  try {
    // Save-then-run: Probar tests exactly what's on screen, so persist the current
    // bundle first — otherwise a never-saved (or edited) draft 404s on /run. Also
    // refresh the live component list so element.* targets reflect the active scene.
    await persistBundle(b);
    void loadLiveElements();
    const res = await fetch(`${API}/api/actions/${encodeURIComponent(b.id)}/run`, { credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: (b.channelId || 'main').trim() || 'main' }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const dispatched = json?.data?.dispatched;
    const errors = json?.data?.errors ?? [];
    testResults.value[b.id] = { dispatched, errors };
    showToast(
      errors.length ? `Probada con ${errors.length} error(es)` : `Probada: ${dispatched ?? 0} despachada(s) ✓`,
      errors.length ? 'error' : 'success'
    );
  } catch (e) {
    testResults.value[b.id] = { failed: String(e) };
    showToast('Error al probar: ' + e, 'error');
  } finally {
    testingId.value = null;
  }
}
</script>

<template>
  <div class="am-shell">
    <div class="am-root">
    <!-- LEFT: saved actions list -->
    <aside class="am-list">
      <div class="am-list-head">
        <h3>Acciones</h3>
        <button class="am-new" @click="newBundle">＋ Nueva acción</button>
      </div>

      <p v-if="loading" class="am-muted am-pad">Cargando…</p>

      <div v-else-if="!bundles.length" class="am-empty">
        <p class="am-empty-title">Aún no hay acciones</p>
        <p class="am-muted">
          Crea tu primera acción para dispararla desde el panel o un webhook.
        </p>
        <button class="am-new am-empty-btn" @click="newBundle">＋ Crear acción</button>
      </div>

      <ul v-else class="am-items">
        <li
          v-for="b in bundles"
          :key="b.id"
          class="am-item"
          :class="{ selected: b.id === selectedId }"
          @click="selectedId = b.id"
        >
          <span class="am-dot" :style="{ background: dotColor(b.id) }">{{ b.icon || '' }}</span>
          <span class="am-item-name">{{ b.name || 'Sin nombre' }}</span>
          <span class="am-item-count">{{ b.actions.length }}</span>
        </li>
      </ul>
    </aside>

    <!-- RIGHT: editor for the selected action -->
    <section class="am-editor">
      <div class="am-intro">
        Crea acciones con nombre, asígnalas al panel o ejecútalas por webhook. Puedes probarlas aquí.
      </div>

      <div v-if="!selected" class="am-note">
        Selecciona una acción de la izquierda o crea una nueva con "＋ Nueva acción".
      </div>

      <div v-else class="am-form">
        <div class="am-form-head">
          <label class="am-field am-grow">Nombre
            <input v-model="selected.name" placeholder="Ej.: Iniciar intro" />
          </label>
          <label class="am-field am-channel">Canal
            <input v-model="selected.channelId" placeholder="main" />
          </label>
        </div>

        <div class="am-actions-block">
          <div class="am-actions-head">
            <span>Acciones</span>
            <button class="am-add" @click="addAction">＋ Acción</button>
          </div>

          <p v-if="!selected.actions.length" class="am-muted">
            Sin acciones todavía. Agrega una con "＋ Acción": cambiar de escena, mostrar/ocultar un
            componente, actualizar una variable o reproducir un sonido.
          </p>

          <div v-for="(act, ai) in selected.actions" :key="ai" class="am-action">
            <div class="am-action-head">
              <select :value="act.kind" @change="setActionKind(act, ($event.target as HTMLSelectElement).value as any)">
                <option v-for="ak in ACTION_KINDS" :key="ak.v" :value="ak.v">{{ ak.label }}</option>
              </select>
              <button class="danger" @click="removeAction(ai)" title="Quitar acción">✕</button>
            </div>

            <!-- scene.activate → pick a saved collection (id stored in target) -->
            <template v-if="act.kind === 'scene.activate'">
              <select
                v-if="collections.length"
                :value="act.target ?? ''"
                @change="setActionTarget(act, ($event.target as HTMLSelectElement).value)"
              >
                <option value="" disabled>Elige una colección…</option>
                <option v-for="c in collections" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
              <input
                v-else
                :value="act.target ?? ''" placeholder="id de la colección"
                @input="setActionTarget(act, ($event.target as HTMLInputElement).value)"
              />
            </template>

            <!-- element.show / hide / delete → pick a component of the LIVE scene -->
            <div
              v-else-if="act.kind === 'element.show' || act.kind === 'element.hide' || act.kind === 'element.delete'"
              class="am-inline"
            >
              <select
                v-if="liveElements.length"
                :value="act.target ?? ''"
                @change="setActionTarget(act, ($event.target as HTMLSelectElement).value)"
              >
                <option value="" disabled>Elige un componente…</option>
                <option v-for="el in liveElements" :key="el.id" :value="el.id">{{ el.label }}{{ el.hidden ? ' · oculto' : '' }}</option>
              </select>
              <input
                v-else
                :value="act.target ?? ''" placeholder="id del componente"
                @input="setActionTarget(act, ($event.target as HTMLInputElement).value)"
              />
              <button class="am-refresh" type="button" title="Actualizar los componentes de la escena activa" @click="loadLiveElements">↻</button>
            </div>

            <!-- element.update → pick a live component + new text -->
            <template v-else-if="act.kind === 'element.update'">
              <div class="am-inline">
                <select
                  v-if="liveElements.length"
                  :value="act.target ?? ''"
                  @change="setActionTarget(act, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="" disabled>Elige un componente…</option>
                  <option v-for="el in liveElements" :key="el.id" :value="el.id">{{ el.label }}</option>
                </select>
                <input v-else :value="act.target ?? ''" placeholder="id del componente" @input="setActionTarget(act, ($event.target as HTMLInputElement).value)" />
                <button class="am-refresh" type="button" title="Actualizar los componentes de la escena activa" @click="loadLiveElements">↻</button>
              </div>
              <input :value="act.updates?.content ?? ''" placeholder="nuevo texto" @input="setActionContent(act, ($event.target as HTMLInputElement).value)" />
            </template>

            <!-- variables.update → variable name + value -->
            <div v-else-if="act.kind === 'variables.update'" class="am-inline">
              <input :value="actionVarKey(act)" placeholder="variable" @input="setActionVar(act, ($event.target as HTMLInputElement).value, actionVarVal(act))" />
              <input :value="actionVarVal(act)" placeholder="valor" @input="setActionVar(act, actionVarKey(act), ($event.target as HTMLInputElement).value)" />
            </div>

            <!-- sound.play → reuse SoundPicker -->
            <SoundPicker
              v-else-if="act.kind === 'sound.play'"
              :model-value="act.sound"
              @update:model-value="act.sound = $event"
            />
          </div>
        </div>

        <div class="am-footer">
          <button class="am-save" :disabled="saving" @click="saveBundle">
            {{ saving ? 'Guardando…' : '💾 Guardar' }}
          </button>
          <button class="am-test" :disabled="testingId === selected.id" @click="runBundle(selected)">
            {{ testingId === selected.id ? 'Probando…' : '▶ Probar' }}
          </button>
          <button class="am-delete" @click="deleteBundle(selected)">Eliminar</button>
        </div>

        <!-- Inline test result -->
        <div v-if="testResults[selected.id]" class="am-result" :class="{ bad: !!testResults[selected.id]?.failed || !!testResults[selected.id]?.errors?.length }">
          <template v-if="testResults[selected.id]?.failed">
            Falló: {{ testResults[selected.id]?.failed }}
          </template>
          <template v-else>
            Despachadas: {{ testResults[selected.id]?.dispatched ?? 0 }}
            <span v-if="testResults[selected.id]?.errors?.length"> · Errores: {{ testResults[selected.id]?.errors?.length }}</span>
            <ul v-if="testResults[selected.id]?.errors?.length" class="am-errors">
              <li v-for="(err, i) in testResults[selected.id]?.errors" :key="i">{{ typeof err === 'string' ? err : JSON.stringify(err) }}</li>
            </ul>
          </template>
        </div>
      </div>
    </section>
    </div>

    <div v-if="toast" class="am-toast" :class="toast.type">{{ toast.message }}</div>
  </div>
</template>

<style scoped>
.am-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  width: 100%;
  background: var(--app-bg);
  color: var(--app-ink);
  overflow: hidden;
}

.am-root {
  flex: 1;
  min-height: 0;
  display: flex;
  width: 100%;
  background: var(--app-bg);
  color: var(--app-ink);
  overflow: hidden;
}

/* LEFT list */
.am-list {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--app-line);
  background: var(--app-panel);
  overflow: hidden;
}
.am-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 14px 10px;
  border-bottom: 1px solid var(--app-line);
}
.am-list-head h3 { margin: 0; font-size: 14px; color: #fff; }
.am-new {
  background: var(--app-brand); color: #fff; border: none; border-radius: 6px;
  padding: 6px 10px; font-size: 12px; font-weight: 600; cursor: pointer;
}
.am-new:hover { background: #a855f7; }

.am-items { list-style: none; margin: 0; padding: 8px; overflow-y: auto; flex: 1; }
.am-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: 6px; cursor: pointer;
  border: 1px solid transparent;
}
.am-item:hover { background: var(--app-hover); }
.am-item.selected { background: var(--app-selected-bg); border-color: var(--app-selected-line); color: #fff; }
.am-dot {
  width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; line-height: 1;
}
.am-item-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.am-item-count {
  font-size: 11px; color: var(--app-muted); background: var(--app-bg); border-radius: 10px;
  padding: 1px 8px; min-width: 20px; text-align: center;
}
.am-item.selected .am-item-count { background: #062f4a; color: #cbe6ff; }

.am-empty { padding: 24px 16px; text-align: center; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.am-empty-title { margin: 0; color: #fff; font-weight: 600; font-size: 14px; }
.am-empty-btn { margin-top: 6px; }
.am-pad { padding: 16px; }

/* RIGHT editor */
.am-editor { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow-y: auto; }
.am-intro {
  padding: 12px 20px; background: var(--app-panel); border-bottom: 1px solid var(--app-line);
  color: #cbd5e1; font-size: 12.5px;
}
.am-note { padding: 28px 20px; color: var(--app-muted); font-size: 13px; }

.am-form { padding: 18px 20px; display: flex; flex-direction: column; gap: 18px; max-width: 720px; }
.am-form-head { display: flex; gap: 12px; }
.am-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--app-muted); }
.am-grow { flex: 1; }
.am-channel { width: 130px; flex-shrink: 0; }

.am-form input,
.am-form select,
.am-action input,
.am-action select {
  background: var(--surface-inset); border: 1px solid var(--app-line); color: var(--app-ink);
  border-radius: 5px; padding: 7px 9px; font-size: 13px; box-sizing: border-box; width: 100%;
}
.am-form input:focus, .am-form select:focus { outline: none; border-color: var(--app-accent); box-shadow: var(--focus-ring); }

.am-actions-block {
  border: 1px solid var(--app-line); border-radius: 8px; background: var(--app-panel); padding: 12px;
  display: flex; flex-direction: column; gap: 10px;
}
.am-actions-head { display: flex; align-items: center; justify-content: space-between; color: var(--app-accent); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: var(--tracking-label); }
.am-add {
  background: var(--app-raised); border: 1px solid var(--app-line); color: var(--app-ink); border-radius: 6px;
  padding: 5px 10px; font-size: 12px; cursor: pointer;
}
.am-add:hover { background: var(--app-hover); }

.am-action {
  border-left: 2px solid var(--app-accent-line); padding: 8px 0 8px 10px; margin-left: 2px;
  display: flex; flex-direction: column; gap: 7px;
}
.am-action-head { display: flex; align-items: center; gap: 8px; }
.am-action-head select { flex: 1; }
.am-inline { display: flex; align-items: center; gap: 8px; }
.am-inline input, .am-inline select { flex: 1; min-width: 0; }
.am-refresh {
  flex: 0 0 auto; background: var(--app-raised); border: 1px solid var(--app-line); color: var(--app-ink);
  border-radius: 4px; padding: 4px 9px; cursor: pointer; font-size: 13px; line-height: 1;
}
.am-refresh:hover { background: var(--app-hover); }

.am-action-head button.danger {
  background: var(--app-raised); border: 1px solid var(--app-line); color: #d88; border-radius: 6px;
  padding: 4px 9px; cursor: pointer; flex-shrink: 0;
}
.am-action-head button.danger:hover { background: #5a2020; border-color: #a33; }

.am-footer { display: flex; gap: 10px; align-items: center; }
.am-save {
  background: #16a34a; color: #fff; border: none; border-radius: 6px;
  padding: 9px 18px; font-weight: 600; font-size: 13px; cursor: pointer;
}
.am-save:hover:not(:disabled) { background: #15803d; }
.am-test {
  background: var(--brand, #9333ea); color: #fff; border: none; border-radius: 6px;
  padding: 9px 16px; font-weight: 600; font-size: 13px; cursor: pointer;
}
.am-test:hover:not(:disabled) { filter: brightness(1.12); }
.am-save:disabled, .am-test:disabled { background: var(--app-line-strong); cursor: not-allowed; }
.am-delete {
  margin-left: auto; background: transparent; border: 1px solid var(--app-line); color: var(--app-muted);
  border-radius: 6px; padding: 9px 14px; font-size: 13px; cursor: pointer;
}
.am-delete:hover { background: #3a1d1d; border-color: #7f1d1d; color: #fca5a5; }

.am-result {
  border: 1px solid #1f5132; background: #112417; color: #bbf7d0;
  border-radius: 8px; padding: 10px 12px; font-size: 12.5px;
}
.am-result.bad { border-color: #7f1d1d; background: #2a1414; color: #fca5a5; }
.am-errors { margin: 6px 0 0; padding-left: 18px; }
.am-errors li { margin: 2px 0; }

.am-muted { color: var(--app-muted); font-size: 12px; margin: 0; }

.am-toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  padding: 10px 22px; border-radius: 8px; font-size: 13px; font-weight: 600;
  color: #fff; z-index: 100; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
}
.am-toast.success { background: #16a34a; }
.am-toast.error { background: #dc2626; }
</style>
