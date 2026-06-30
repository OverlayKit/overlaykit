import { describe, it, expect } from 'vitest';
import {
  parseHtmlToElements,
  elementsToHtml,
  extractStyleCss,
  createStyleElement,
} from '../../src/utils/converter';
import type { ElementNode } from '@overlaykit/renderer/types/element';

describe('elementsToHtml', () => {
  it('serializes tag, id, kebab-cased styles, attributes and text content', () => {
    const els: ElementNode[] = [
      {
        id: 'box',
        tag: 'div',
        styles: { backgroundColor: 'red', fontSize: '20px' },
        attributes: { class: 'card', 'data-x': '1' },
        content: 'Hi',
      },
    ];
    const html = elementsToHtml(els);
    expect(html).toContain('<div');
    expect(html).toContain('id="box"');
    expect(html).toContain('background-color: red');
    expect(html).toContain('font-size: 20px');
    expect(html).toContain('class="card"');
    expect(html).toContain('data-x="1"');
    expect(html).toContain('>Hi</div>');
  });

  it('recurses into children and self-closes void tags', () => {
    const els: ElementNode[] = [
      { id: 'wrap', tag: 'div', styles: {}, children: [
        { id: 'img', tag: 'img', styles: {}, attributes: { src: 'a.png' } },
        { id: 't', tag: 'span', styles: {}, content: 'x' },
      ] },
    ];
    const html = elementsToHtml(els);
    expect(html).toContain('<img');
    expect(html).toContain('/>'); // void tag self-closed
    expect(html).toContain('<span');
    expect(html).toContain('>x</span>');
    expect(html).toContain('</div>');
  });

  it('drops top-level <style> nodes (they belong in the CSS pane)', () => {
    const els: ElementNode[] = [
      createStyleElement('.a{color:red}'),
      { id: 'd', tag: 'div', styles: {}, content: 'x' },
    ];
    expect(elementsToHtml(els)).not.toContain('<style');
  });
});

describe('extractStyleCss', () => {
  it('concatenates the content of top-level <style> nodes', () => {
    const els: ElementNode[] = [
      createStyleElement('.a{color:red}'),
      createStyleElement('.b{color:blue}'),
      { id: 'd', tag: 'div', styles: {}, content: 'x' },
    ];
    const css = extractStyleCss(els);
    expect(css).toContain('.a{color:red}');
    expect(css).toContain('.b{color:blue}');
  });

  it('returns empty string when there are no style nodes', () => {
    expect(extractStyleCss([{ id: 'd', tag: 'div', styles: {} }])).toBe('');
  });
});

describe('round-trip: elements -> HTML -> elements', () => {
  it('preserves tag, id, class and nested text through a parse', () => {
    const original: ElementNode[] = [
      { id: 'root', tag: 'div', styles: { color: 'white' }, attributes: { class: 'lt' }, children: [
        { id: 'name', tag: 'div', styles: {}, content: 'Alex' },
      ] },
    ];
    const back = parseHtmlToElements(elementsToHtml(original));
    expect(back).toHaveLength(1);
    expect(back[0].tag).toBe('div');
    expect(back[0].id).toBe('root');
    expect(back[0].attributes?.class).toBe('lt');
    const child = back[0].children?.[0];
    expect(child?.tag).toBe('div');
    expect(child?.content).toBe('Alex');
  });
});
