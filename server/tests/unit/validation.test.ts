import { describe, it, expect } from 'vitest';
import {
  validateElementNode,
  validateSceneNode,
  validateVariables,
  isValidChannelId,
} from '../../src/validation/validator';

describe('Validation', () => {
  describe('validateElementNode', () => {
    it('should accept valid element', () => {
      const element = {
        id: 'test-1',
        tag: 'div',
        styles: { color: 'red' },
      };
      const result = validateElementNode(element);
      expect(result).toBeNull();
    });

    it('should require id', () => {
      const element = {
        tag: 'div',
        styles: {},
      };
      const result = validateElementNode(element);
      expect(result).not.toBeNull();
      expect(result?.code).toBe('VALIDATION_ERROR');
    });

    it('should require tag', () => {
      const element = {
        id: 'test-1',
        styles: {},
      };
      const result = validateElementNode(element);
      expect(result).not.toBeNull();
      expect(result?.code).toBe('VALIDATION_ERROR');
    });

    it('should require styles', () => {
      const element = {
        id: 'test-1',
        tag: 'div',
      };
      const result = validateElementNode(element);
      expect(result).not.toBeNull();
      expect(result?.code).toBe('VALIDATION_ERROR');
    });

    it('should accept element with optional properties', () => {
      const element = {
        id: 'test-1',
        tag: 'div',
        styles: { color: 'red' },
        content: 'Test content',
        attributes: { class: 'btn' },
        children: [
          {
            id: 'child-1',
            tag: 'span',
            styles: {},
          },
        ],
      };
      const result = validateElementNode(element);
      expect(result).toBeNull();
    });

    it('should accept element with animations', () => {
      const element = {
        id: 'test-1',
        tag: 'div',
        styles: {},
        animations: [
          {
            name: 'slideIn',
            duration: 500,
            keyframes: [
              { offset: 0, styles: { opacity: '0' } },
              { offset: 1, styles: { opacity: '1' } },
            ],
          },
        ],
      };
      const result = validateElementNode(element);
      expect(result).toBeNull();
    });

    it('should accept element with autoRemove', () => {
      const element = {
        id: 'test-1',
        tag: 'div',
        styles: {},
        autoRemove: {
          delay: 5000,
          exitAnimation: {
            name: 'slideOut',
            duration: 300,
            keyframes: [
              { offset: 0, styles: { opacity: '1' } },
              { offset: 1, styles: { opacity: '0' } },
            ],
          },
        },
      };
      const result = validateElementNode(element);
      expect(result).toBeNull();
    });

    it('accepts declared typed controls and rejects unknown control types or malformed paths', () => {
      const element = {
        id: 'score',
        tag: 'section',
        styles: {},
        controls: [
          { id: 'score.home', label: 'Home', type: 'number', path: 'score.home', min: 0, max: 99, step: 1 },
          {
            id: 'score.color',
            label: 'Color',
            type: 'select',
            path: 'score.color',
            options: [{ label: 'Cyan', value: 'cyan' }],
          },
        ],
      };
      expect(validateElementNode(element)).toBeNull();
      expect(validateElementNode({
        ...element,
        controls: [{ id: 'bad', label: 'Bad', type: 'slider', path: 'score.home' }],
      })).not.toBeNull();
      expect(validateElementNode({
        ...element,
        controls: [{ id: 'bad', label: 'Bad', type: 'text', path: 'score[home]' }],
      })).not.toBeNull();
    });

    it('should accept element with dashboard render fields', () => {
      const element = {
        id: 'el-1',
        tag: 'div',
        styles: {},
        position: { x: 10, y: 20 },
        size: { width: 100, height: 50 },
        animationIn: 'fadeIn',
        animationDuration: 1,
        autoRemoveDelay: 5,
      };
      const result = validateElementNode(element);
      expect(result).toBeNull();
    });

    it('should reject unknown element properties', () => {
      const element = {
        id: 'el-1',
        tag: 'div',
        styles: {},
        bogusField: true,
      };
      const result = validateElementNode(element);
      expect(result).not.toBeNull();
    });

    it('should reject invalid styles', () => {
      const element = {
        id: 'test-1',
        tag: 'div',
        styles: { color: 123 }, // Should be string
      };
      const result = validateElementNode(element);
      expect(result).not.toBeNull();
    });
  });

  describe('validateSceneNode', () => {
    it('should accept valid scene', () => {
      const scene = {
        id: 'scene-1',
        name: 'Main Scene',
        elements: [
          {
            id: 'el-1',
            tag: 'div',
            styles: {},
          },
        ],
      };
      const result = validateSceneNode(scene);
      expect(result).toBeNull();
    });

    it('should require id, name, and elements', () => {
      const scene = {
        name: 'Main Scene',
      };
      const result = validateSceneNode(scene);
      expect(result).not.toBeNull();
    });

    it('should accept scene with backgroundMusic', () => {
      const scene = {
        id: 'scene-1',
        name: 'Main Scene',
        elements: [],
        backgroundMusic: {
          url: '/music/bg.mp3',
          volume: 0.5,
          loop: true,
          preload: true,
        },
      };
      const result = validateSceneNode(scene);
      expect(result).toBeNull();
    });

    it('should accept scene with meta', () => {
      const scene = {
        id: 'scene-1',
        name: 'Main Scene',
        elements: [],
        meta: { author: 'user', version: 1 },
      };
      const result = validateSceneNode(scene);
      expect(result).toBeNull();
    });

    it('should require URL in backgroundMusic', () => {
      const scene = {
        id: 'scene-1',
        name: 'Main Scene',
        elements: [],
        backgroundMusic: {
          volume: 0.5,
        },
      };
      const result = validateSceneNode(scene);
      expect(result).not.toBeNull();
    });

    it('should accept a landscape orientation', () => {
      const scene = { id: 'scene-1', name: 'Main', elements: [], orientation: 'landscape' };
      expect(validateSceneNode(scene)).toBeNull();
    });

    it('should accept a portrait orientation', () => {
      const scene = { id: 'scene-1', name: 'Main', elements: [], orientation: 'portrait' };
      expect(validateSceneNode(scene)).toBeNull();
    });

    it('should reject an unknown orientation', () => {
      const scene = { id: 'scene-1', name: 'Main', elements: [], orientation: 'diagonal' };
      expect(validateSceneNode(scene)).not.toBeNull();
    });
  });

  describe('validateVariables', () => {
    it('should accept valid variables', () => {
      const variables = {
        name: 'Alice',
        count: 10,
        enabled: true,
      };
      const result = validateVariables(variables);
      expect(result).toBeNull();
    });

    it('should accept empty object', () => {
      const result = validateVariables({});
      expect(result).toBeNull();
    });

    it('should accept string values', () => {
      const result = validateVariables({ name: 'test' });
      expect(result).toBeNull();
    });

    it('should accept number values', () => {
      const result = validateVariables({ count: 42 });
      expect(result).toBeNull();
    });

    it('should accept boolean values', () => {
      const result = validateVariables({ enabled: false });
      expect(result).toBeNull();
    });

    it('should reject invalid variable names', () => {
      const variables = {
        '123invalid': 'test',
        '-invalid': 'test',
      };
      const result = validateVariables(variables);
      expect(result).not.toBeNull();
    });

    it('should accept valid variable names with underscores and numbers', () => {
      const variables = {
        var_1: 'test',
        var_2: 'test',
        _private: 'test',
      };
      const result = validateVariables(variables);
      expect(result).toBeNull();
    });

    it('should accept nested object values', () => {
      const variables = {
        user: { firstName: 'Frederic', lastName: 'Colins' },
      };
      const result = validateVariables(variables);
      expect(result).toBeNull();
    });

    it('should reject array values', () => {
      const variables = {
        items: [1, 2, 3], // arrays are not valid variable values
      };
      const result = validateVariables(variables);
      expect(result).not.toBeNull();
    });
  });

  describe('isValidChannelId', () => {
    it('should accept valid channel IDs', () => {
      expect(isValidChannelId('main')).toBe(true);
      expect(isValidChannelId('alerts')).toBe(true);
      expect(isValidChannelId('game-stats')).toBe(true);
      expect(isValidChannelId('channel_123')).toBe(true);
    });

    it('should reject empty string', () => {
      expect(isValidChannelId('')).toBe(false);
    });

    it('should reject non-string values', () => {
      expect(isValidChannelId(null)).toBe(false);
      expect(isValidChannelId(undefined)).toBe(false);
      expect(isValidChannelId(123)).toBe(false);
      expect(isValidChannelId({})).toBe(false);
    });

    it('should reject channel IDs longer than 100 characters', () => {
      const longChannelId = 'a'.repeat(101);
      expect(isValidChannelId(longChannelId)).toBe(false);
    });

    it('should accept channel IDs up to 100 characters', () => {
      const maxChannelId = 'a'.repeat(100);
      expect(isValidChannelId(maxChannelId)).toBe(true);
    });
  });
});
