import { ElementNode } from '../types/element';
import { logger } from './logger';

const PRESERVED_TEMPLATE_ATTRIBUTES = new Set([
    'data-content-template',
    'data-style-templates',
    'data-attr-templates',
]);

/**
 * Check if a string contains interpolation placeholders
 */
/**
 * Check if a string contains interpolation placeholders
 */
function hasInterpolation(text: string | null | undefined): boolean {
    if (!text) return false;
    return /\{\{[a-zA-Z_][a-zA-Z0-9_.]*\}\}/.test(text);
}

/**
 * Preserves template information in element attributes so that client-side
 * interpolation can work properly even after server-side processing
 */
export function preserveTemplatesInElements(elements: ElementNode[]): ElementNode[] {
    return elements.map(element => preserveTemplatesInElement(element));
}

/**
 * Preserve template information in a single element
 */
export function preserveTemplatesInElement(element: ElementNode): ElementNode {
    const processedElement = { ...element };

    // Preserve original content template if it contains interpolation
    if (element.content && hasInterpolation(element.content)) {
        logger.debug('Preserving content template', { content: element.content });

        // Store original template in data attribute
        if (!processedElement.attributes) {
            processedElement.attributes = {};
        }
        processedElement.attributes['data-content-template'] = element.content;
    }

    // Preserve templates in styles
    if (element.styles) {
        const styleTemplates: Record<string, string> = {};
        let hasStyleTemplates = false;

        for (const [key, value] of Object.entries(element.styles)) {
            if (typeof value === 'string' && hasInterpolation(value)) {
                logger.debug('Preserving style template', { key, value });
                styleTemplates[key] = value;
                hasStyleTemplates = true;
            }
        }

        if (hasStyleTemplates) {
            if (!processedElement.attributes) {
                processedElement.attributes = {};
            }
            processedElement.attributes['data-style-templates'] = JSON.stringify(styleTemplates);
        }
    }

    // Preserve templates in other attributes
    if (element.attributes) {
        const attrTemplates: Record<string, string> = {};
        let hasAttrTemplates = false;

        for (const [key, value] of Object.entries(element.attributes)) {
            if (PRESERVED_TEMPLATE_ATTRIBUTES.has(key)) continue;
            if (typeof value === 'string' && hasInterpolation(value)) {
                logger.debug('Preserving attribute template', { key, value });
                attrTemplates[key] = value;
                hasAttrTemplates = true;
            }
        }

        if (hasAttrTemplates) {
            if (!processedElement.attributes) {
                processedElement.attributes = {};
            }
            processedElement.attributes['data-attr-templates'] = JSON.stringify(attrTemplates);
        }
    }

    // Recursively process children
    if (element.children && element.children.length > 0) {
        processedElement.children = preserveTemplatesInElements(element.children);
    }

    return processedElement;
}

/**
 * Extract templates from preserved attributes
 */
export function extractTemplatesFromAttributes(element: ElementNode): {
    contentTemplate?: string;
    styleTemplates?: Record<string, string>;
    attrTemplates?: Record<string, string>;
} {
    const result: {
        contentTemplate?: string;
        styleTemplates?: Record<string, string>;
        attrTemplates?: Record<string, string>;
    } = {};

    if (!element.attributes) return result;

    // Extract content template
    if (element.attributes['data-content-template']) {
        result.contentTemplate = element.attributes['data-content-template'];
    }

    // Extract style templates
    if (element.attributes['data-style-templates']) {
        try {
            result.styleTemplates = JSON.parse(element.attributes['data-style-templates']);
        } catch (error) {
            console.warn('[DEBUG TEMPLATE] Failed to parse style templates:', error);
        }
    }

    // Extract attribute templates
    if (element.attributes['data-attr-templates']) {
        try {
            result.attrTemplates = JSON.parse(element.attributes['data-attr-templates']);
        } catch (error) {
            console.warn('[DEBUG TEMPLATE] Failed to parse attribute templates:', error);
        }
    }

    return result;
}
