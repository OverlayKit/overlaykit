import { Variables } from '../types/element';

/**
 * Get nested value from object using dot notation
 * @param obj - Object to traverse
 * @param path - Dot-separated path (e.g. "user.name")
 * @returns Value or undefined
 */
function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : undefined;
  }, obj);
}

// Tokens that explicitly HIDE a data-motion-show layer. Empty / undefined / null /
// 'true' / '1' (and anything else) count as VISIBLE — visibility is the default and
// a layer only hides when its flag is set to one of these explicit falsy values.
const HIDDEN_TOKENS = new Set(['false', '0', 'no', 'off']);

/**
 * Visibility rule for data-motion-show flags, shared by renderer + composer + panel.
 * Empty / undefined / null / 'true' / '1' => visible; only explicit falsy tokens hide.
 * @param value - Raw flag value (any type)
 * @returns True if the layer should be visible
 */
export function isVisible(value: unknown): boolean {
  return !HIDDEN_TOKENS.has(String(value ?? '').trim().toLowerCase());
}

/**
 * Interpolate variables in text using {{varName}} syntax
 * Supports nested variables like {{user.name}}
 * @param text - Text with {{varName}} placeholders
 * @param variables - Map of variable names to values
 * @returns Interpolated text
 */
export function interpolate(text: string | null | undefined, variables: Variables): string {
  if (!text) return text || '';

  // Updated regex to include dots (hello {{user.name}})
  return text.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g, (match, varName) => {
    const value = getNestedValue(variables, varName);
    
    if (value === undefined || value === null) {
      return match; // Return placeholder if variable not found
    }
    return String(value);
  });
}

/**
 * Interpolate variables in an object's string values
 * Useful for CSS properties that might contain interpolations
 * @param obj - Object with string values
 * @param variables - Map of variable names to values
 * @returns New object with interpolated values
 */
export function interpolateObject<T extends Record<string, any>>(
  obj: T,
  variables: Variables
): T {
  const result: any = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = interpolate(value, variables);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into nested objects (e.g. styles: { color: '#{{colorCode}}' })
      result[key] = interpolateObject(value as Record<string, any>, variables);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Check if a string contains interpolation placeholders
 * @param text - Text to check
 * @returns True if text contains {{varName}} patterns
 */
export function hasInterpolation(text: string | null | undefined): boolean {
  if (!text) return false;
  return /\{\{[a-zA-Z_][a-zA-Z0-9_.]*\}\}/.test(text);
}

/**
 * Extract variable names from text
 * @param text - Text with {{varName}} placeholders
 * @returns Array of variable names
 */
export function extractVariableNames(text: string | null | undefined): string[] {
  if (!text) return [];

  const matches = text.match(/\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g);
  if (!matches) return [];

  return matches.map((match) => match.slice(2, -2));
}