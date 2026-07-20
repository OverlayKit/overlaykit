<!--
  Canonical ElementRenderer for OverlayKit.
  Single source of truth used by the production client overlay, the editor
  preview, and the dashboard preview, so what an author sees renders identically
  in OBS. Owns interpolation, animation (AnimationRunner), auto-remove, and sound
  (SoundManager).
-->
<template>
  <component
    :is="element.tag"
    :id="element.id"
    ref="elementRef"
    :key="element.id"
    :class="elementClasses"
    :style="computedStyles"
    v-bind="element.attributes"
    @click="handleEvent('click')"
    @animationstart="handleEvent('animationstart')"
    @animationend="handleEvent('animationend')"
  >
    <template v-if="liveText !== null">
      {{ liveText }}
    </template>
    <template v-else-if="element.content">
      {{ interpolatedContent }}
    </template>
    <template
      v-for="child in element.children"
      :key="child.id"
    >
      <ElementRenderer
        :element="child"
        :variables="variables"
        :on-element-remove="onElementRemove"
        :on-action="onAction"
      />
    </template>
  </component>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { ElementNode, Variables, ComponentAction } from '../types/element';
import { interpolate, interpolateObject, isVisible } from '../utils/interpolate';
import { soundManager } from '../services/SoundManager';
import { animationRunner } from '../services/AnimationRunner';
import { logger } from '../utils/logger';

defineOptions({
  name: 'ElementRenderer'
});

interface Props {
  element: ElementNode;
  variables: Variables;
  onElementRemove?: (elementId: string) => void;
  // Feature B: a component trigger (countdown.complete / click / mounted) reports
  // its actions through this callback so the host (overlay) can dispatch them
  // server-authoritatively. The triggerType lets the host de-dupe re-fires (e.g.
  // 'mounted' after a scene re-activation). Absent in previews (editor/dashboard),
  // so authored events never fire while editing.
  onAction?: (actions: ComponentAction[], sourceId: string, triggerType: string) => void;
  // Motion System: position of this element among the scene's top-level elements.
  // Only the top-level caller passes it; it becomes --dsm-i so token-driven
  // entrances can stagger via calc(var(--ds-stagger) * var(--dsm-i)).
  staggerIndex?: number;
}

const props = defineProps<Props>();
const elementRef = ref<HTMLElement>();

// Live timed text the renderer drives itself (no controller push needed):
// data-clock => current local time HH:MM:SS; data-countdown="<seconds>" => mm:ss.
const liveText = ref<string | null>(null);
let liveTimer: ReturnType<typeof setInterval> | null = null;
// Feature B: ensure the countdown.complete trigger fires at most once per mount.
let completedFired = false;

// Feature B: fire a component trigger — collect the actions of all triggers whose
// `on` matches and hand them to the host's dispatcher. No-op when no actions are
// configured or no onAction is provided (e.g. editor/dashboard preview).
function dispatchTrigger(type: string): void {
  const triggers = props.element.triggers;
  if (!triggers || !triggers.length || !props.onAction) return;
  const actions = triggers.filter((t) => t.on === type).flatMap((t) => t.actions);
  if (actions.length) props.onAction(actions, props.element.id, type);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
function formatClock(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Extract preserved templates from attributes
const extractedTemplates = computed(() => {
  const result = {
    contentTemplate: undefined as string | undefined,
    styleTemplates: {} as Record<string, string>,
    attrTemplates: {} as Record<string, string>
  };

  if (!props.element.attributes) return result;

  // Extract content template
  if (props.element.attributes['data-content-template']) {
    result.contentTemplate = props.element.attributes['data-content-template'];
  }

  // Extract style templates
  if (props.element.attributes['data-style-templates']) {
    try {
      result.styleTemplates = JSON.parse(props.element.attributes['data-style-templates']);
    } catch {
      // Ignore malformed style templates
    }
  }

  // Extract attribute templates
  if (props.element.attributes['data-attr-templates']) {
    try {
      result.attrTemplates = JSON.parse(props.element.attributes['data-attr-templates']);
    } catch {
      // Ignore malformed attribute templates
    }
  }

  return result;
});

const interpolatedContent = computed(() => {
  // Use preserved template if available, otherwise use current content
  const contentToInterpolate = extractedTemplates.value.contentTemplate || props.element.content;
  return interpolate(contentToInterpolate, props.variables);
});

const computedStyles = computed(() => {
  // Start with current styles
  let baseStyles = { ...(props.element.styles || {}) };

  // Apply template interpolation for styles that have templates
  const styleTemplates = extractedTemplates.value.styleTemplates;
  if (Object.keys(styleTemplates).length > 0) {
    for (const [key, template] of Object.entries(styleTemplates)) {
      baseStyles[key] = interpolate(template, props.variables);
    }
  }

  // Apply standard interpolation to remaining styles
  baseStyles = interpolateObject(baseStyles, props.variables);

  // If the element carries position/size (dashboard format), convert to styles
  if (props.element.position && props.element.size) {
    baseStyles = {
      ...baseStyles,
      position: 'absolute',
      left: `${props.element.position.x}px`,
      top: `${props.element.position.y}px`,
      width: `${props.element.size.width}px`,
      height: `${props.element.size.height}px`,
    };
  }

  const result: Record<string, string> = { ...baseStyles };

  // Add animation styles (support both formats)
  // Format 1: Complex format with animations array
  if (props.element.animations && props.element.animations.length > 0) {
    const firstAnimation = props.element.animations[0];
    const animationName = animationRunner.createAnimation(firstAnimation);
    const animationCSS = animationRunner.getAnimationCSS(firstAnimation, animationName);
    Object.assign(result, animationCSS);
  }

  // Format 2: Simple format from dashboard (animationIn + duration)
  if (props.element.animationIn && !props.element.animations) {
    result.animation = convertSimpleAnimationToCSS(
      props.element.animationIn,
      props.element.animationDuration || 1
    );
  }

  // Motion System: expose the top-level index as --dsm-i (inherited by nested DS
  // components) so their entrance animations stagger on a scene intro.
  if (props.staggerIndex !== undefined) {
    result['--dsm-i'] = String(props.staggerIndex);
  }

  return result;
});

const elementClasses = computed(() => {
  const classes: Record<string, boolean> = {
    'dom-element': true,
    [`element-${props.element.tag}`]: true,
  };

  // Motion System: data-motion-pulse="<var.path>" pulses while that variable is truthy
  // (e.g. a LIVE indicator bound to flags.live).
  const pulseVar = props.element.attributes?.['data-motion-pulse'];
  if (pulseVar) {
    const v = interpolate(`{{${pulseVar}}}`, props.variables).trim().toLowerCase();
    classes['dsm-pulse'] = v !== '' && v !== 'false' && v !== '0' && v !== 'null' && v !== 'undefined';
  }

  // Motion System: data-motion-show="<var.path>" animates the element out (fade+slide)
  // when the bound variable is EXPLICITLY falsy, and back in otherwise — so it stays
  // visible by default and hides only when the flag is toggled off (live).
  const showVar = props.element.attributes?.['data-motion-show'];
  if (showVar) {
    classes['dsm-toggle'] = true;
    const v = interpolate(`{{${showVar}}}`, props.variables);
    classes['dsm-out'] = !isVisible(v);
  }

  return classes;
});

// Watchers
watch(() => props.variables, () => {
  // Variables changed, component will re-render
}, { deep: true });

// Motion System: data-motion-pop="<var.path>" re-triggers a pop when that variable
// changes. variables.update is incremental (no re-mount), so restart the animation
// by hand (remove class → reflow → add) on a leaf element with no entrance of its own.
const popVar = props.element.attributes?.['data-motion-pop'];
if (popVar) {
  watch(
    () => interpolate(`{{${popVar}}}`, props.variables),
    (next, prev) => {
      const el = elementRef.value;
      if (!el || next === prev) return;
      el.classList.remove('dsm-pop');
      void el.offsetWidth; // force reflow so the animation restarts
      el.classList.add('dsm-pop');
    }
  );
}

// Helper function to convert simple animation format to CSS
function convertSimpleAnimationToCSS(animationName: string, duration: number): string {
  const animationMap: Record<string, string> = {
    'fadeIn': `fadeIn ${duration}s ease-in`,
    'slideInLeft': `slideInLeft ${duration}s ease-out`,
    'slideInRight': `slideInRight ${duration}s ease-out`,
    'slideInUp': `slideInUp ${duration}s ease-out`,
    'slideInDown': `slideInDown ${duration}s ease-out`,
    'zoomIn': `zoomIn ${duration}s ease-out`,
    'bounceIn': `bounceIn ${duration}s ease-out`,
  };

  return animationMap[animationName] || `${animationName} ${duration}s ease-out`;
}

// Lifecycle hooks
onMounted(() => {
  // Live clock via data-clock, or countdown via data-countdown="<seconds>"
  const attrs = props.element.attributes;
  if (attrs?.['data-clock'] !== undefined) {
    liveText.value = formatClock(new Date());
    liveTimer = setInterval(() => {
      liveText.value = formatClock(new Date());
    }, 1000);
  } else if (attrs?.['data-countdown'] !== undefined) {
    let remaining = Number(attrs['data-countdown']);
    if (!Number.isNaN(remaining)) {
      liveText.value = formatCountdown(remaining);
      liveTimer = setInterval(() => {
        remaining -= 1;
        liveText.value = formatCountdown(remaining);
        if (remaining <= 0 && liveTimer) {
          clearInterval(liveTimer);
          liveTimer = null;
          // Feature B: the countdown reached zero — fire its actions (once).
          if (!completedFired) {
            completedFired = true;
            dispatchTrigger('countdown.complete');
          }
        }
      }, 1000);
    }
  }

  // Auto-remove: support both complex (autoRemove object) and simple (autoRemoveDelay) formats
  if (props.element.autoRemove) {
    scheduleAutoRemove();
  } else if (typeof props.element.autoRemoveDelay === 'number') {
    scheduleSimpleAutoRemove(props.element.autoRemoveDelay);
  }

  // Play event sounds bound to animationstart
  if (props.element.events) {
    for (const event of props.element.events) {
      if (event.type === 'animationstart' && event.sound) {
        soundManager.playSound(event.sound).catch((error) => {
          logger.warn('Failed to play event sound', { error: String(error) });
        });
      }
    }
  }

  // Feature B: fire the 'mounted' trigger (e.g. an intro reveal that, once shown,
  // schedules the next scene).
  dispatchTrigger('mounted');
});

onUnmounted(() => {
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
});

// Methods
function handleEvent(eventType: string): void {
  // Feature B: a DOM event (e.g. click) may also fire configured triggers.
  dispatchTrigger(eventType);

  if (!props.element.events) return;

  for (const event of props.element.events) {
    if (event.type === eventType) {
      if (event.sound) {
        soundManager.playSound(event.sound).catch((error) => {
          logger.warn('Failed to play event sound', { error: String(error) });
        });
      }

      if (event.handler) {
        logger.debug('Event handler called', { elementId: props.element.id, handler: event.handler });
        // Handler execution would be implemented by the consuming component
      }
    }
  }
}

function scheduleAutoRemove(): void {
  if (!props.element.autoRemove) return;

  setTimeout(async () => {
    if (elementRef.value && props.element.autoRemove?.exitAnimation) {
      try {
        await animationRunner.applyExitAnimation(
          elementRef.value,
          props.element.autoRemove.exitAnimation
        );
      } catch (error) {
        logger.warn('Exit animation failed', { error: String(error) });
      }
    }

    if (props.onElementRemove) {
      props.onElementRemove(props.element.id);
    }
  }, props.element.autoRemove.delay);
}

// Simple auto-remove for dashboard format (delay in seconds)
function scheduleSimpleAutoRemove(delayInSeconds: number): void {
  const delayInMs = delayInSeconds * 1000;

  setTimeout(() => {
    if (props.onElementRemove) {
      props.onElementRemove(props.element.id);
    }
  }, delayInMs);
}
</script>

<style scoped>
.dom-element {
  box-sizing: border-box;
}

/* NOTE: do not force `display` per tag here. Scoped styles carry a [data-v-*]
   attribute, so a rule like `.element-div { display: block }` (specificity
   0-0-2-0) would override a template's `.my-bar { display: flex }` (0-0-1-0)
   and silently break every flex/grid layout. The browser's UA defaults already
   provide the correct display for each tag (div/p → block, span → inline,
   style → none), and templates set their own when they need something else. */

.element-h1,
.element-h2,
.element-h3,
.element-h4,
.element-h5,
.element-h6 {
  margin: 0;
}

/* Simple Animation Keyframes (for the dashboard's simple animationIn format) */
@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes slideInLeft {
  from {
    transform: translateX(-100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes slideInRight {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes slideInUp {
  from {
    transform: translateY(100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes slideInDown {
  from {
    transform: translateY(-100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

@keyframes zoomIn {
  from {
    transform: scale(0.5);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

@keyframes bounceIn {
  0% {
    transform: scale(0.3);
    opacity: 0;
  }
  50% {
    transform: scale(1.05);
    opacity: 1;
  }
  70% {
    transform: scale(0.9);
  }
  100% {
    transform: scale(1);
  }
}
</style>
