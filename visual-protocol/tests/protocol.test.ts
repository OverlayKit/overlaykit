import { describe, expect, it } from 'vitest';
import {
  VisualProtocolError,
  canonicalVisualJson,
  visualSha256,
  type VisualIntent,
} from '../src/index.js';

describe('visual protocol canonicalization', () => {
  it('hashes visual JSON independent of object insertion order', () => {
    const left: VisualIntent = {
      id: 'intent-1',
      task: 'announce',
      subject: { type: 'person', name: 'Rodrigo Vicente', role: 'Arquitecto de software' },
      desiredEffect: 'notice',
      importance: 'primary',
    };
    const right = {
      importance: 'primary',
      desiredEffect: 'notice',
      subject: { role: 'Arquitecto de software', name: 'Rodrigo Vicente', type: 'person' },
      task: 'announce',
      id: 'intent-1',
    };

    expect(canonicalVisualJson(left)).toBe(canonicalVisualJson(right));
    expect(visualSha256(left)).toMatch(/^[0-9a-f]{64}$/u);
    expect(visualSha256(left)).toBe(visualSha256(right));
  });

  it('rejects cyclic or non-json visual values', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => canonicalVisualJson(cyclic)).toThrowError(VisualProtocolError);
    expect(() => canonicalVisualJson({ invalid: undefined })).toThrowError(VisualProtocolError);
  });
});
