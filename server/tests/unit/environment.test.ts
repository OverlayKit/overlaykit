import { describe, expect, it } from 'vitest';
import { config, validateConfig } from '../../src/config/environment';

describe('secure network defaults', () => {
  it('binds both listeners to loopback unless explicitly configured', () => {
    expect(config.host).toBe('127.0.0.1');
    expect(config.wsHost).toBe('127.0.0.1');
    expect(() => validateConfig()).not.toThrow();
  });
});
