import { logger } from '../utils/logger';
import { Animation } from '../types/element';

export class AnimationRunner {
  private styleSheet: CSSStyleSheet | null = null;
  private animationCounter = 0;

  constructor() {
    this.initializeStyleSheet();
  }

  /**
   * Create and inject CSS animation into the document
   */
  public createAnimation(animation: Animation): string {
    const animationName = `anim-${++this.animationCounter}-${Date.now()}`;

    const keyframes: string[] = [];
    for (const keyframe of animation.keyframes) {
      const percentage = Math.round(keyframe.offset * 100);
      const styles = Object.entries(keyframe.styles)
        .map(([key, value]) => `${this.camelToKebab(key)}: ${value}`)
        .join('; ');
      keyframes.push(`${percentage}% { ${styles} }`);
    }

    const rule = `@keyframes ${animationName} { ${keyframes.join(' ')} }`;

    try {
      if (this.styleSheet && this.styleSheet.insertRule) {
        this.styleSheet.insertRule(rule, this.styleSheet.cssRules.length);
      }
      logger.debug('Animation created', { name: animationName, duration: animation.duration });
    } catch (error) {
      logger.error('Failed to create animation', { error: String(error) });
    }

    return animationName;
  }

  /**
   * Get CSS animation string for an element
   */
  public getAnimationCSS(
    animation: Animation,
    animationName: string
  ): Record<string, string> {
    return {
      animation: `${animationName} ${animation.duration}ms ${animation.easing || 'ease'} forwards`,
      animationFillMode: 'forwards',
    };
  }

  /**
   * Apply exit animation to an element
   */
  public applyExitAnimation(
    element: HTMLElement,
    animation: Animation
  ): Promise<void> {
    return new Promise((resolve) => {
      const animationName = this.createAnimation(animation);
      const cssAnimation = this.getAnimationCSS(animation, animationName);

      // Apply animation styles
      for (const [key, value] of Object.entries(cssAnimation)) {
        element.style.setProperty(this.camelToKebab(key), value);
      }

      // Resolve after animation completes
      const handleAnimationEnd = () => {
        element.removeEventListener('animationend', handleAnimationEnd);
        resolve();
      };

      element.addEventListener('animationend', handleAnimationEnd);

      // Fallback timeout in case animationend doesn't fire
      setTimeout(() => {
        element.removeEventListener('animationend', handleAnimationEnd);
        resolve();
      }, animation.duration + 100);
    });
  }

  /**
   * Clear all created animations
   */
  public clearAnimations(): void {
    try {
      if (this.styleSheet) {
        while (this.styleSheet.cssRules.length > 0) {
          this.styleSheet.deleteRule(0);
        }
      }
    } catch (error) {
      logger.warn('Failed to clear animations', { error: String(error) });
    }
    this.animationCounter = 0;
  }

  // Private methods

  private initializeStyleSheet(): void {
    try {
      const style = document.createElement('style');
      style.id = 'overlaykit-animations';
      style.textContent = '';
      document.head.appendChild(style);

      if (style.sheet) {
        this.styleSheet = style.sheet;
      }
    } catch (error) {
      logger.error('Failed to initialize animation stylesheet', {
        error: String(error),
      });
    }
  }

  private camelToKebab(str: string): string {
    return str.replace(/([a-z0-9]|(?=[A-Z]))([A-Z])/g, '$1-$2').toLowerCase();
  }
}

export const animationRunner = new AnimationRunner();
