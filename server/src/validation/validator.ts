import Ajv from 'ajv';
import { readFileSync } from 'fs';
import { join } from 'path';

const ajv = new Ajv({ allowUnionTypes: true });

// Load schemas
const elementSchema = JSON.parse(
  readFileSync(join(__dirname, 'schemas/element.schema.json'), 'utf-8')
);
const sceneSchema = JSON.parse(
  readFileSync(join(__dirname, 'schemas/scene.schema.json'), 'utf-8')
);
const variablesSchema = JSON.parse(
  readFileSync(join(__dirname, 'schemas/variables.schema.json'), 'utf-8')
);

// Compile validators
const validateElement = ajv.compile(elementSchema);
const validateScene = ajv.compile(sceneSchema);
const validateVariablesSchema = ajv.compile(variablesSchema);

export interface ValidationError {
  code: string;
  message: string;
  details: {
    path: string;
    reason?: string;
  };
}

// Bound an element tree's nesting depth and total node count BEFORE the recursive Ajv validator (and
// the recursive render/clone helpers) ever touch it, so a maliciously deep or huge tree cannot
// overflow the call stack. The guard is iterative (an explicit stack) so it never recurses itself,
// and it short-circuits at the depth limit — a deep linear chain is rejected in O(depth-limit) steps.
export const MAX_ELEMENT_DEPTH = 64;
export const MAX_ELEMENT_NODES = 20_000;

function elementBoundError(reason: string): ValidationError {
  return {
    code: 'VALIDATION_ERROR',
    message: 'Element tree exceeds nesting limits',
    details: { path: 'root', reason },
  };
}

function boundElementTree(root: unknown): ValidationError | null {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  let count = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const { node, depth } = current;
    if (!node || typeof node !== 'object') continue;
    const record = node as { children?: unknown; elements?: unknown };
    // Follow element children and scene elements — both are recursion points for the validator.
    for (const key of ['children', 'elements'] as const) {
      const branch = record[key];
      if (!Array.isArray(branch)) continue;
      if (depth + 1 > MAX_ELEMENT_DEPTH) {
        return elementBoundError(`element nesting exceeds ${MAX_ELEMENT_DEPTH} levels`);
      }
      for (const child of branch) {
        count += 1;
        if (count > MAX_ELEMENT_NODES) {
          return elementBoundError(`element tree exceeds ${MAX_ELEMENT_NODES} nodes`);
        }
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return null;
}

export function validateElementNode(data: unknown): ValidationError | null {
  const bounded = boundElementTree(data);
  if (bounded) return bounded;
  if (!validateElement(data)) {
    const error = validateElement.errors?.[0];
    if (!error) return null;

    return {
      code: 'VALIDATION_ERROR',
      message: `Element validation failed: ${error.schemaPath}`,
      details: {
        path: error.instancePath || 'root',
        reason: error.message,
      },
    };
  }
  return null;
}

export function validateSceneNode(data: unknown): ValidationError | null {
  const bounded = boundElementTree(data);
  if (bounded) return bounded;
  if (!validateScene(data)) {
    const error = validateScene.errors?.[0];
    if (!error) return null;

    return {
      code: 'VALIDATION_ERROR',
      message: `Scene validation failed: ${error.schemaPath}`,
      details: {
        path: error.instancePath || 'root',
        reason: error.message,
      },
    };
  }
  return null;
}

export function validateVariables(
  data: unknown
): ValidationError | null {
  if (!validateVariablesSchema(data)) {
    const error = validateVariablesSchema.errors?.[0];
    if (!error) return null;

    return {
      code: 'VALIDATION_ERROR',
      message: `Variables validation failed`,
      details: {
        path: error.instancePath || 'root',
        reason: error.message,
      },
    };
  }
  return null;
}

export function isValidChannelId(channelId: unknown): channelId is string {
  return (
    typeof channelId === 'string' &&
    channelId.length > 0 &&
    channelId.length <= 100
  );
}
