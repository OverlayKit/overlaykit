import type { Animation, ElementNode, Variables } from '@overlaykit/protocol/element';
import type { Scene } from '@overlaykit/protocol/scene';
import {
  DOM_PROGRAM_TARGET,
  VISUAL_PROTOCOL_VERSION,
  type CompilationReceipt,
  type CompiledVisualBundle,
  type DomProgramArtifact,
  type RecipeId,
  type ResolvedVisualProgram,
  type SemanticBinding,
  VisualProtocolError,
  compilationReceiptHash,
  visualSha256,
} from '@overlaykit/visual-protocol';

export const OVERLAYKIT_VISUAL_TARGET_VERSION = '0.2.0' as const;

export type OverlayKitPreviewScene = Omit<Scene, 'variables'>;

export interface OverlayKitDomProgramArtifact extends DomProgramArtifact<
  OverlayKitPreviewScene,
  OverlayKitCueGraph
> {
  readonly bindingPlan: ReadonlyArray<SemanticBinding>;
}

export type OverlayKitBindingValue = string | number | boolean;

export interface OverlayKitPreviewCandidate {
  readonly scene: OverlayKitPreviewScene;
  readonly variables: Variables;
}

export interface OverlayKitCueGraph {
  readonly cues: ReadonlyArray<{
    readonly id: string;
    readonly steps: ReadonlyArray<{
      readonly id: string;
      readonly verb: string;
      readonly elementId: string;
      readonly durationMs?: number;
    }>;
  }>;
}

const BINDING_PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FORBIDDEN_BINDING_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function bindingSegments(binding: SemanticBinding): ReadonlyArray<string> {
  const segments = binding.source.split('.');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => !BINDING_PATH_SEGMENT.test(segment) || FORBIDDEN_BINDING_SEGMENTS.has(segment)
    )
  ) {
    throw new VisualProtocolError(
      'UNSAFE_VISUAL_BINDING_SOURCE',
      `Visual binding ${binding.id} has an unsafe source path`
    );
  }
  return segments;
}

function bindingValue(value: unknown, bindingId: string): OverlayKitBindingValue {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  throw new VisualProtocolError(
    'INVALID_VISUAL_BINDING_VALUE',
    `Visual binding ${bindingId} requires a string, boolean, or finite number`
  );
}

function assignBindingValue(
  variables: Record<string, unknown>,
  binding: SemanticBinding,
  value: OverlayKitBindingValue
): void {
  const segments = bindingSegments(binding);
  let current = variables;
  for (const segment of segments.slice(0, -1)) {
    if (Object.prototype.hasOwnProperty.call(current, segment)) {
      if (!isPlainRecord(current[segment])) {
        throw new VisualProtocolError(
          'VISUAL_BINDING_PATH_COLLISION',
          `Visual binding ${binding.id} collides with another source path`
        );
      }
    } else {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  const leaf = segments[segments.length - 1];
  if (Object.prototype.hasOwnProperty.call(current, leaf)) {
    throw new VisualProtocolError(
      'VISUAL_BINDING_PATH_COLLISION',
      `Visual binding ${binding.id} collides with another source path`
    );
  }
  current[leaf] = value;
}

function assertArtifactIdentity(artifact: OverlayKitDomProgramArtifact): void {
  const meta = artifact.scene.meta;
  const expectedEvidenceRef = `compilation:${compilationReceiptHash(artifact.manifest)}`;
  if (
    artifact.target !== DOM_PROGRAM_TARGET ||
    artifact.programHash !== artifact.manifest.programHash ||
    artifact.bundle.bundleHash !== artifact.manifest.bundleHash ||
    meta?.programHash !== artifact.programHash ||
    meta?.bundleHash !== artifact.bundle.bundleHash ||
    meta?.evidenceRef !== expectedEvidenceRef
  ) {
    throw new VisualProtocolError(
      'VISUAL_ARTIFACT_IDENTITY_MISMATCH',
      'OverlayKit visual artifact identities do not agree'
    );
  }
}

export function prepareOverlayKitPreviewCandidate(
  artifact: OverlayKitDomProgramArtifact,
  bindingValues: Readonly<Record<string, unknown>>
): OverlayKitPreviewCandidate {
  assertArtifactIdentity(artifact);
  if (!Array.isArray(artifact.bindingPlan) || !isPlainRecord(bindingValues)) {
    throw new VisualProtocolError(
      'INVALID_VISUAL_BINDING_PLAN',
      'OverlayKit Preview admission requires a binding plan and value record'
    );
  }

  const bindings = new Map<string, SemanticBinding>();
  for (const binding of artifact.bindingPlan) {
    if (!binding.id || bindings.has(binding.id)) {
      throw new VisualProtocolError(
        'INVALID_VISUAL_BINDING_PLAN',
        'Visual binding identifiers must be non-empty and unique'
      );
    }
    bindingSegments(binding);
    bindings.set(binding.id, binding);
  }

  for (const bindingId of Object.keys(bindingValues)) {
    if (!bindings.has(bindingId)) {
      throw new VisualProtocolError(
        'UNKNOWN_VISUAL_BINDING_VALUE',
        `Visual binding value ${bindingId} is not declared by the artifact`
      );
    }
  }

  const variables: Record<string, unknown> = {};
  for (const binding of artifact.bindingPlan) {
    if (!Object.prototype.hasOwnProperty.call(bindingValues, binding.id)) {
      throw new VisualProtocolError(
        'MISSING_VISUAL_BINDING_VALUE',
        `Visual binding ${binding.id} requires a value`
      );
    }
    assignBindingValue(variables, binding, bindingValue(bindingValues[binding.id], binding.id));
  }

  const scene = cloneJson(artifact.scene) as Scene;
  delete scene.variables;
  return {
    scene: scene as OverlayKitPreviewScene,
    variables: variables as Variables,
  };
}

function animation(name: string, duration: number): Animation {
  return {
    name,
    duration,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    keyframes: [
      { offset: 0, styles: { opacity: '0', transform: 'translateY(16px)' } },
      { offset: 1, styles: { opacity: '1', transform: 'translateY(0)' } },
    ],
  };
}

function bindingTemplate(program: ResolvedVisualProgram, path: string): string {
  const binding = program.bindings.find((candidate) => candidate.path === path);
  if (!binding) {
    throw new VisualProtocolError(
      'MISSING_VISUAL_BINDING',
      `Resolved program is missing required binding ${path}`
    );
  }
  return `{{${binding.source}}}`;
}

function recipeIds(program: ResolvedVisualProgram): ReadonlyArray<RecipeId> {
  return [
    program.composition.recipeId,
    ...(program.composition.children?.map((child) => child.recipeId) ?? []),
  ];
}

function textElement(id: string, content: string, styles: Record<string, string>): ElementNode {
  return {
    id,
    tag: 'div',
    content,
    styles,
  };
}

function lowerThird(program: ResolvedVisualProgram): ReadonlyArray<ElementNode> {
  return [
    {
      id: `${program.id}-lower-third`,
      tag: 'section',
      styles: {
        position: 'absolute',
        left: '80px',
        bottom: '72px',
        minWidth: '420px',
        maxWidth: '760px',
        padding: '20px 24px',
        background: 'rgba(8, 13, 22, 0.82)',
        color: 'var(--ok-visual-fg, #ffffff)',
        borderLeft: '6px solid var(--ok-visual-accent, #35d0ff)',
        fontFamily: 'var(--ok-visual-font, Inter, system-ui, sans-serif)',
      },
      animations: [animation('ok-visual-establish', 420)],
      children: [
        textElement(`${program.id}-name`, bindingTemplate(program, 'subject.name'), {
          fontSize: '42px',
          fontWeight: '800',
          lineHeight: '1.05',
        }),
        textElement(`${program.id}-role`, bindingTemplate(program, 'subject.role'), {
          fontSize: '22px',
          fontWeight: '500',
          marginTop: '8px',
          opacity: '0.84',
        }),
      ],
    },
  ];
}

function presentationCard(program: ResolvedVisualProgram): ReadonlyArray<ElementNode> {
  return [
    {
      id: `${program.id}-title-card`,
      tag: 'section',
      styles: {
        position: 'absolute',
        inset: '0',
        display: 'grid',
        alignItems: 'center',
        justifyItems: 'center',
        padding: '96px',
        background: 'var(--ok-visual-slide-bg, #0b1020)',
        color: 'var(--ok-visual-fg, #ffffff)',
        fontFamily: 'var(--ok-visual-font, Inter, system-ui, sans-serif)',
      },
      animations: [animation('ok-visual-establish', 520)],
      children: [
        {
          id: `${program.id}-profile-card`,
          tag: 'article',
          styles: {
            width: 'min(1080px, 100%)',
            display: 'grid',
            gap: '24px',
            padding: '56px 64px',
            border: '1px solid rgba(255, 255, 255, 0.18)',
            background: 'rgba(255, 255, 255, 0.08)',
          },
          children: [
            textElement(`${program.id}-name`, bindingTemplate(program, 'subject.name'), {
              fontSize: '72px',
              fontWeight: '850',
              lineHeight: '0.98',
            }),
            textElement(`${program.id}-role`, bindingTemplate(program, 'subject.role'), {
              fontSize: '32px',
              fontWeight: '520',
              color: 'var(--ok-visual-accent, #35d0ff)',
            }),
          ],
        },
      ],
    },
  ];
}

function elementsFor(program: ResolvedVisualProgram): ReadonlyArray<ElementNode> {
  const recipes = recipeIds(program);
  if (recipes.includes('broadcast.lower-third')) return lowerThird(program);
  if (
    recipes.includes('presentation.title-card') &&
    recipes.includes('presentation.profile-card')
  ) {
    return presentationCard(program);
  }
  throw new VisualProtocolError(
    'UNSUPPORTED_OVERLAYKIT_RECIPE',
    'Only announce-person lower-third and presentation card recipes are implemented'
  );
}

function cueGraphFor(program: ResolvedVisualProgram): OverlayKitCueGraph {
  return {
    cues: program.timeline.cues.map((cue) => ({
      id: cue.id,
      steps: cue.steps.map((step) => ({
        id: step.id,
        verb: step.verb,
        elementId: step.target,
        ...(step.durationMs === undefined ? {} : { durationMs: step.durationMs }),
      })),
    })),
  };
}

function bundleFor(program: ResolvedVisualProgram): CompiledVisualBundle {
  const capabilitiesHash = visualSha256(program.requiredCapabilities);
  const body = {
    assets: { images: [], fonts: [], audio: [] },
    capabilitiesHash,
    compilerVersion: OVERLAYKIT_VISUAL_TARGET_VERSION,
    constitutionRef: program.constitutionRef,
    motionParameters: {
      establishDuration: '420ms',
      revealDuration: '240ms',
      dismissDuration: '160ms',
    },
    profileRef: program.profileRef,
    tokens: {
      '--ok-visual-accent': '#35d0ff',
      '--ok-visual-fg': '#ffffff',
      '--ok-visual-font': 'Inter, system-ui, sans-serif',
    },
  };

  return {
    ...body,
    bundleId: `vb_${visualSha256(body).slice(0, 16)}`,
    bundleHash: visualSha256(body),
  };
}

function receiptFor(
  program: ResolvedVisualProgram,
  bundle: CompiledVisualBundle
): CompilationReceipt {
  return {
    schemaVersion: VISUAL_PROTOCOL_VERSION,
    compilerVersion: OVERLAYKIT_VISUAL_TARGET_VERSION,
    intentRef: program.intentRef,
    profileRef: program.profileRef,
    constitutionRef: program.constitutionRef,
    programHash: program.programHash,
    bundleHash: bundle.bundleHash,
    decisionsHash: visualSha256(program.decisions),
    rejectedCandidatesHash: visualSha256(program.rejectedCandidates),
  };
}

export function compileOverlayKitDomProgram(
  program: ResolvedVisualProgram
): OverlayKitDomProgramArtifact {
  if (program.composition.primitive !== 'identity.announce-person') {
    throw new VisualProtocolError(
      'UNSUPPORTED_VISUAL_PRIMITIVE',
      'Only identity.announce-person is supported in the MVP target'
    );
  }

  const elements = elementsFor(program);
  const bundle = bundleFor(program);
  const manifest = receiptFor(program, bundle);
  const receiptHash = compilationReceiptHash(manifest);
  const scene: OverlayKitPreviewScene = {
    id: `scene_${program.id}`,
    name: `Visual Program ${program.id}`,
    elements: [...elements],
    orientation: 'landscape',
    meta: {
      visualProgramId: program.id,
      programHash: program.programHash,
      intentRef: program.intentRef,
      profileRef: program.profileRef,
      constitutionRef: program.constitutionRef,
      compilerVersion: OVERLAYKIT_VISUAL_TARGET_VERSION,
      evidenceRef: `compilation:${receiptHash}`,
      bundleHash: bundle.bundleHash,
    },
  };

  return {
    programId: program.id,
    target: DOM_PROGRAM_TARGET,
    scene,
    bundle,
    bindingPlan: Object.freeze(program.bindings.map((binding) => Object.freeze({ ...binding }))),
    timeline: cueGraphFor(program),
    manifest,
    programHash: program.programHash,
  };
}
