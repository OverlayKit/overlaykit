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

export function validateElementNode(data: unknown): ValidationError | null {
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
