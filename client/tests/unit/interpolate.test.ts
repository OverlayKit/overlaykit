import { describe, it, expect } from 'vitest';
import {
  interpolate,
  interpolateObject,
  hasInterpolation,
  extractVariableNames,
} from '../../src/utils/interpolate';
import { Variables } from '../../src/types/variables';

describe('Interpolation Utils', () => {
  describe('interpolate', () => {
    it('should replace single variable', () => {
      const text = 'Hello {{name}}!';
      const variables: Variables = { name: 'World' };
      const result = interpolate(text, variables);
      expect(result).toBe('Hello World!');
    });

    it('should replace multiple variables', () => {
      const text = '{{greeting}} {{name}}, you have {{count}} messages';
      const variables: Variables = { greeting: 'Hi', name: 'Alice', count: 5 };
      const result = interpolate(text, variables);
      expect(result).toBe('Hi Alice, you have 5 messages');
    });

    it('should handle numeric variables', () => {
      const text = 'Progress: {{percent}}%';
      const variables: Variables = { percent: 75 };
      const result = interpolate(text, variables);
      expect(result).toBe('Progress: 75%');
    });

    it('should handle boolean variables', () => {
      const text = 'Is enabled: {{isEnabled}}';
      const variables: Variables = { isEnabled: true };
      const result = interpolate(text, variables);
      expect(result).toBe('Is enabled: true');
    });

    it('should leave unmatched variables as placeholders', () => {
      const text = 'Hello {{name}}, your balance is {{balance}}';
      const variables: Variables = { name: 'Alice' };
      const result = interpolate(text, variables);
      expect(result).toBe('Hello Alice, your balance is {{balance}}');
    });

    it('should handle null and undefined text', () => {
      expect(interpolate(null, {})).toBe('');
      expect(interpolate(undefined, {})).toBe('');
    });

    it('should handle empty string', () => {
      const text = '';
      const result = interpolate(text, {});
      expect(result).toBe('');
    });

    it('should handle text without variables', () => {
      const text = 'Plain text without variables';
      const result = interpolate(text, {});
      expect(result).toBe('Plain text without variables');
    });

    it('should not replace invalid variable names', () => {
      const text = 'Value: {{123invalid}} and {{-invalid}}';
      const variables: Variables = { '123invalid': 'test', '-invalid': 'test' };
      const result = interpolate(text, variables);
      expect(result).toBe('Value: {{123invalid}} and {{-invalid}}');
    });

    it('should allow underscores and numbers after first character', () => {
      const text = '{{var_1}} {{var_2}} {{_var}}';
      const variables: Variables = { var_1: 'a', var_2: 'b', _var: 'c' };
      const result = interpolate(text, variables);
      expect(result).toBe('a b c');
    });
  });

  describe('interpolateObject', () => {
    it('should interpolate string values in object', () => {
      const obj = { content: 'Hello {{name}}', title: 'Welcome' };
      const variables: Variables = { name: 'Alice' };
      const result = interpolateObject(obj, variables);
      expect(result.content).toBe('Hello Alice');
      expect(result.title).toBe('Welcome');
    });

    it('should preserve non-string values', () => {
      const obj = { width: 100, color: 'red', enabled: true };
      const result = interpolateObject(obj, {});
      expect(result.width).toBe(100);
      expect(result.color).toBe('red');
      expect(result.enabled).toBe(true);
    });

    it('should handle mixed types', () => {
      const obj = { label: 'Width: {{width}}px', width: 100, styles: { color: '#{{colorCode}}' } };
      const variables: Variables = { width: 50, colorCode: 'FF0000' };
      const result = interpolateObject(obj, variables);
      expect(result.label).toBe('Width: 50px');
      expect(result.width).toBe(100);
      expect(result.styles.color).toBe('#FF0000');
    });
  });

  describe('hasInterpolation', () => {
    it('should detect interpolation placeholders', () => {
      expect(hasInterpolation('Hello {{name}}')).toBe(true);
      expect(hasInterpolation('{{var1}} and {{var2}}')).toBe(true);
    });

    it('should return false for text without placeholders', () => {
      expect(hasInterpolation('Plain text')).toBe(false);
      expect(hasInterpolation('{{123}} is invalid')).toBe(false);
    });

    it('should handle null and undefined', () => {
      expect(hasInterpolation(null)).toBe(false);
      expect(hasInterpolation(undefined)).toBe(false);
    });
  });

  describe('extractVariableNames', () => {
    it('should extract single variable name', () => {
      const text = 'Hello {{name}}';
      const names = extractVariableNames(text);
      expect(names).toEqual(['name']);
    });

    it('should extract multiple variable names', () => {
      const text = '{{greeting}} {{name}}, you have {{count}} messages';
      const names = extractVariableNames(text);
      expect(names).toEqual(['greeting', 'name', 'count']);
    });

    it('should handle duplicate variable names', () => {
      const text = '{{name}} and {{name}} again';
      const names = extractVariableNames(text);
      expect(names).toEqual(['name', 'name']);
    });

    it('should return empty array for text without variables', () => {
      expect(extractVariableNames('Plain text')).toEqual([]);
      expect(extractVariableNames('')).toEqual([]);
      expect(extractVariableNames(null)).toEqual([]);
      expect(extractVariableNames(undefined)).toEqual([]);
    });

    it('should not extract invalid variable names', () => {
      const text = '{{123}} {{-invalid}} {{valid_name}}';
      const names = extractVariableNames(text);
      expect(names).toEqual(['valid_name']);
    });
  });
});
