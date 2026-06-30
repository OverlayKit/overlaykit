import { ElementNode } from '@overlaykit/renderer/types/element';

/**
 * Parses HTML string into ElementNode[]
 */
export function parseHtmlToElements(html: string): ElementNode[] {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const body = doc.body;

    // Helper to generate IDs if missing
    let idCounter = 0;
    const generateId = () => `el-${Date.now()}-${idCounter++}`;

    const mapNode = (node: Element): ElementNode => {
        const id = node.id || generateId();

        const styles: Record<string, string> = {};
        // Index iteration (not `for..of`): CSSStyleDeclaration is iterable in real
        // browsers but not in every DOM implementation (e.g. happy-dom under test).
        const style = (node as HTMLElement).style;
        for (let s = 0; s < style.length; s++) {
            const rule = style[s];
            styles[rule] = style.getPropertyValue(rule);
        }

        const attributes: Record<string, string> = {};
        // Use getAttribute('class') rather than node.className: on SVG elements
        // className is an SVGAnimatedString object, not a string, which breaks
        // serialization and fails server-side attribute validation.
        const className = node.getAttribute('class');
        if (className) {
            attributes['class'] = className;
        }

        for (let i = 0; i < node.attributes.length; i++) {
            const attr = node.attributes[i];
            if (attr.name !== 'id' && attr.name !== 'style' && attr.name !== 'class') {
                attributes[attr.name] = attr.value;
            }
        }

        if (node.tagName.toLowerCase() === 'div' && node.childNodes.length === 1 && node.childNodes[0].nodeType === Node.TEXT_NODE) {
            // Treat simple divs with text as text nodes if desired, or just content
            // But for protocol "box" is fine.
        }

        let content: string | undefined = undefined;
        // Simple content extraction if it's just text
        if (node.childNodes.length > 0 && Array.from(node.childNodes).every(n => n.nodeType === Node.TEXT_NODE || n.nodeType === Node.COMMENT_NODE)) {
            content = node.textContent?.trim() || undefined;
        }

        const children: ElementNode[] = [];
        // Only process element children if we didn't treat them as content
        if (!content) {
            for (const child of Array.from(node.children)) {
                children.push(mapNode(child));
            }
        }


        return {
            id,
            tag: node.tagName.toLowerCase(),
            content,
            styles,
            attributes: Object.keys(attributes).length ? attributes : undefined,
            children: children.length ? children : undefined
        };
    };

    const elements: ElementNode[] = [];
    for (const child of Array.from(body.children)) {
        elements.push(mapNode(child));
    }
    return elements;
}

/**
 * Creates a Style element node from CSS string
 */
export function createStyleElement(css: string): ElementNode {
    return {
        id: 'global-styles',
        tag: 'style',
        content: css,
        styles: {}
    };
}

// ---- Inverse direction: ElementNode[] -> HTML/CSS export ----

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function camelToKebab(s: string): string {
    return s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

function escapeAttr(v: string): string {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeText(v: string): string {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stylesToString(styles?: Record<string, string>): string {
    if (!styles) return '';
    return Object.entries(styles)
        .filter(([, v]) => v !== '' && v != null)
        .map(([k, v]) => `${camelToKebab(k)}: ${v}`)
        .join('; ');
}

function serializeNode(el: ElementNode, indent: string): string {
    const attrs: string[] = [];
    if (el.id) attrs.push(`id="${escapeAttr(el.id)}"`);
    const styleStr = stylesToString(el.styles);
    if (styleStr) attrs.push(`style="${escapeAttr(styleStr)}"`);
    if (el.attributes) {
        for (const [k, v] of Object.entries(el.attributes)) {
            if (k === 'id' || k === 'style') continue;
            attrs.push(`${k}="${escapeAttr(String(v))}"`);
        }
    }
    const head = `${el.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}`;
    if (VOID_TAGS.has(el.tag)) return `${indent}<${head} />`;

    let inner = '';
    if (el.tag === 'style') {
        inner = el.content || '';
    } else if (el.content) {
        inner = escapeText(el.content);
    } else if (el.children && el.children.length) {
        inner = '\n' + el.children.map((c) => serializeNode(c, indent + '  ')).join('\n') + '\n' + indent;
    }
    return `${indent}<${head}>${inner}</${el.tag}>`;
}

/** Serialize the non-<style> top-level nodes of a scene to HTML (for code mode). */
export function elementsToHtml(elements: ElementNode[]): string {
    return elements
        .filter((e) => e.tag !== 'style')
        .map((e) => serializeNode(e, ''))
        .join('\n');
}

/** Pull the CSS out of a scene's top-level <style> nodes (theme + component CSS). */
export function extractStyleCss(elements: ElementNode[]): string {
    return elements
        .filter((e) => e.tag === 'style')
        .map((e) => e.content || '')
        .join('\n\n')
        .trim();
}
