import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useChannelStore } from '../../src/store/channels';
import { useVariablesStore } from '../../src/store/variables';
import { ElementNode } from '../../src/types/element';
import { Scene } from '../../src/types/scene';

describe('Pinia Stores', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('useChannelStore', () => {
    it('should initialize channel on first access', () => {
      const store = useChannelStore();
      store.initializeChannel('test');
      const channel = store.getChannel('test');
      expect(channel).toBeDefined();
      expect(channel?.isConnected).toBe(false);
      expect(channel?.isConnecting).toBe(false);
    });

    it('should add element to channel', () => {
      const store = useChannelStore();
      const element: ElementNode = {
        id: 'test-1',
        tag: 'div',
        styles: { color: 'red' },
      };
      store.addElement('main', element);
      const elements = store.getElements('main');
      expect(elements).toHaveLength(1);
      expect(elements[0].id).toBe('test-1');
    });

    it('should retrieve element by id', () => {
      const store = useChannelStore();
      const element: ElementNode = {
        id: 'test-1',
        tag: 'div',
        styles: {},
        content: 'Test',
      };
      store.addElement('main', element);
      const retrieved = store.getElement('main', 'test-1');
      expect(retrieved).toEqual(element);
    });

    it('should update element', () => {
      const store = useChannelStore();
      const element: ElementNode = {
        id: 'test-1',
        tag: 'div',
        styles: { color: 'red' },
        content: 'Initial',
      };
      store.addElement('main', element);
      store.updateElement('main', 'test-1', { content: 'Updated' });
      const updated = store.getElement('main', 'test-1');
      expect(updated?.content).toBe('Updated');
      expect(updated?.styles.color).toBe('red');
    });

    it('should remove element', () => {
      const store = useChannelStore();
      const element: ElementNode = {
        id: 'test-1',
        tag: 'div',
        styles: {},
      };
      store.addElement('main', element);
      expect(store.getElements('main')).toHaveLength(1);
      store.removeElement('main', 'test-1');
      expect(store.getElements('main')).toHaveLength(0);
    });

    it('should set scene and clear previous elements', () => {
      const store = useChannelStore();
      // Add initial elements
      store.addElement('main', {
        id: 'old-1',
        tag: 'div',
        styles: {},
      });
      store.addElement('main', {
        id: 'old-2',
        tag: 'div',
        styles: {},
      });

      // Set new scene
      const scene: Scene = {
        id: 'scene-1',
        name: 'New Scene',
        elements: [
          { id: 'new-1', tag: 'div', styles: {} },
          { id: 'new-2', tag: 'div', styles: {} },
        ],
      };
      store.setScene('main', scene);

      const elements = store.getElements('main');
      expect(elements).toHaveLength(2);
      expect(elements.map((e) => e.id)).toEqual(['new-1', 'new-2']);
    });

    it('should clear all elements in channel', () => {
      const store = useChannelStore();
      store.addElement('main', { id: '1', tag: 'div', styles: {} });
      store.addElement('main', { id: '2', tag: 'div', styles: {} });
      store.clearElements('main');
      expect(store.getElements('main')).toHaveLength(0);
    });

    it('should set channel connection state', () => {
      const store = useChannelStore();
      store.initializeChannel('test');
      store.setChannelConnecting('test', true);
      expect(store.getChannel('test')?.isConnecting).toBe(true);
      store.setChannelConnected('test', true);
      expect(store.getChannel('test')?.isConnected).toBe(true);
    });

    it('should handle multiple channels independently', () => {
      const store = useChannelStore();
      store.addElement('alerts', { id: 'alert-1', tag: 'div', styles: {} });
      store.addElement('chat', { id: 'chat-1', tag: 'div', styles: {} });
      expect(store.getElements('alerts')).toHaveLength(1);
      expect(store.getElements('chat')).toHaveLength(1);
      expect(store.getElements('alerts')[0].id).toBe('alert-1');
      expect(store.getElements('chat')[0].id).toBe('chat-1');
    });

    it('should return empty array for non-existent channel', () => {
      const store = useChannelStore();
      expect(store.getElements('non-existent')).toEqual([]);
      expect(store.getElement('non-existent', 'test')).toBeUndefined();
    });
  });

  describe('useVariablesStore', () => {
    it('should set variables for a channel', () => {
      const store = useVariablesStore();
      store.setVariables('main', { name: 'Alice', count: 10 });
      const vars = store.getVariables('main');
      expect(vars.name).toBe('Alice');
      expect(vars.count).toBe(10);
    });

    it('should merge variables on multiple sets', () => {
      const store = useVariablesStore();
      store.setVariables('main', { name: 'Alice' });
      store.setVariables('main', { count: 10 });
      const vars = store.getVariables('main');
      expect(vars.name).toBe('Alice');
      expect(vars.count).toBe(10);
    });

    it('should update individual variable', () => {
      const store = useVariablesStore();
      store.setVariables('main', { name: 'Alice', count: 5 });
      store.updateVariable('main', 'count', 15);
      const vars = store.getVariables('main');
      expect(vars.count).toBe(15);
      expect(vars.name).toBe('Alice');
    });

    it('should get single variable by name', () => {
      const store = useVariablesStore();
      store.setVariables('main', { name: 'Alice', count: 10 });
      expect(store.getVariable('main', 'name')).toBe('Alice');
      expect(store.getVariable('main', 'count')).toBe(10);
      expect(store.getVariable('main', 'missing')).toBeUndefined();
    });

    it('should clear variables for a channel', () => {
      const store = useVariablesStore();
      store.setVariables('main', { name: 'Alice' });
      store.clearVariables('main');
      expect(store.getVariables('main')).toEqual({});
    });

    it('should handle multiple channels independently', () => {
      const store = useVariablesStore();
      store.setVariables('main', { name: 'Alice' });
      store.setVariables('alerts', { message: 'New alert' });
      expect(store.getVariable('main', 'name')).toBe('Alice');
      expect(store.getVariable('alerts', 'message')).toBe('New alert');
      expect(store.getVariable('main', 'message')).toBeUndefined();
    });

    it('should support all variable types', () => {
      const store = useVariablesStore();
      store.setVariables('main', {
        stringVar: 'test',
        numberVar: 42,
        booleanVar: true,
      });
      const vars = store.getVariables('main');
      expect(vars.stringVar).toBe('test');
      expect(vars.numberVar).toBe(42);
      expect(vars.booleanVar).toBe(true);
    });
  });
});
