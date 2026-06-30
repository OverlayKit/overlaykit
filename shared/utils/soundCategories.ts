// Single Spanish vocabulary for the bundled sound catalog's categories, shared by
// the editor SoundPicker and the panel soundboard so they never drift. The catalog
// manifest stores English keys (alerts/stingers/transitions/ui); display these.

export const SOUND_CATEGORY_LABELS: Record<string, string> = {
  alerts: 'Alertas',
  stingers: 'Cortinillas',
  transitions: 'Transiciones',
  ui: 'Interfaz',
  ambient: 'Ambiente',
};

/** Preferred display order (others fall to the end, alphabetically). */
export const SOUND_CATEGORY_ORDER = ['alerts', 'stingers', 'transitions', 'ui', 'ambient'];

/** Friendly Spanish label for a catalog category key (falls back to the raw key). */
export function soundCategoryLabel(key: string): string {
  return SOUND_CATEGORY_LABELS[key] || key;
}
