import { ref, computed, onMounted, onBeforeUnmount, nextTick, type Ref } from 'vue';

// Shared canvas zoom/fit machinery for the editor stages (Componente preview +
// Layout composer). Lifted verbatim from the two surfaces that had divergent
// copies, parameterized by a `dims` getter so it follows orientation changes.
//
// Contract preserved from the originals:
//  - the SIZER reserves the *scaled* footprint (transform alone doesn't resize
//    the layout box → off-screen clipping), while the STAGE keeps natural dims
//    + transform:scale (transform-origin must stay top-left at the call site).
//  - auto-fit on mount (after nextTick) and on container resize, but ONLY when
//    the user hasn't explicitly zoomed (userZoomed gate) — a three-pane layout
//    resizes the container constantly, so manual zoom must survive it.
export interface StageZoomOptions {
  maxScale?: number; // upper clamp (App.vue used 3, LayoutComposer used 2)
  pad?: number; // breathing room around the stage (px)
}

// `containerRef` is owned by the caller (bound via a string template ref) and
// passed in, so it's a real script usage and the scroll container measures it.
export function useStageZoom(
  dims: () => { w: number; h: number },
  containerRef: Ref<HTMLElement | null>,
  opts: StageZoomOptions = {}
) {
  const maxScale = opts.maxScale ?? 3;
  const pad = opts.pad ?? 32;

  const scale = ref(1);
  const userZoomed = ref(false);

  const clampScale = (v: number) => Math.round(Math.min(maxScale, Math.max(0.1, v)) * 100) / 100;

  // Reserves the scaled footprint so the scroll container centers/scrolls on
  // what is actually visible.
  const sizerStyle = computed(() => ({
    width: `${dims().w * scale.value}px`,
    height: `${dims().h * scale.value}px`,
  }));
  // Natural canvas size + transform:scale (the sizer above reserves the scaled
  // box). width/height are bound so an orientation flip resizes the stage.
  const stageStyle = computed(() => ({
    width: `${dims().w}px`,
    height: `${dims().h}px`,
    transform: `scale(${scale.value})`,
  }));

  const setScale = (v: number) => {
    scale.value = clampScale(v);
    userZoomed.value = true;
  };

  const computeFit = () => {
    const el = containerRef.value;
    if (!el) return scale.value;
    const cw = el.clientWidth - pad * 2;
    const ch = el.clientHeight - pad * 2;
    if (cw <= 0 || ch <= 0) return scale.value;
    return clampScale(Math.min(cw / dims().w, ch / dims().h, 1));
  };
  const fit = () => {
    scale.value = computeFit();
    userZoomed.value = false;
  };

  let ro: ResizeObserver | null = null;
  onMounted(async () => {
    await nextTick();
    fit();
    ro = new ResizeObserver(() => { if (!userZoomed.value) scale.value = computeFit(); });
    if (containerRef.value) ro.observe(containerRef.value);
  });
  onBeforeUnmount(() => { ro?.disconnect(); });

  return { scale, userZoomed, sizerStyle, stageStyle, setScale, fit };
}
