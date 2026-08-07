import { createHash } from 'node:crypto';

export const VISUAL_PROTOCOL_VERSION = 'overlaykit-visual-protocol/v1' as const;
export const DOM_PROGRAM_TARGET = 'overlaykit.dom-protocol/v1' as const;

export type VisualTask =
  | 'announce'
  | 'compare'
  | 'explain-change'
  | 'show-trend'
  | 'locate'
  | 'sequence'
  | 'warn'
  | 'celebrate';

export type DesiredVisualEffect = 'notice' | 'understand' | 'remember' | 'act';
export type VisualImportance = 'supporting' | 'primary' | 'critical';
export type VisualSurface = 'broadcast.overlay' | 'presentation.slide';
export type TemporalMode = 'live' | 'presenter-paced' | 'self-paced' | 'ambient';
export type VisualInteractionMode = 'none' | 'operator' | 'presenter' | 'audience';
export type AudienceDistance = 'near' | 'medium' | 'far';
export type AttentionBudget = 'low' | 'medium' | 'high';
export type TemporalVerb = 'establish' | 'reveal' | 'hold' | 'dismiss';
export type RecipeId =
  | 'broadcast.lower-third'
  | 'presentation.title-card'
  | 'presentation.profile-card';

export interface SemanticPersonEntity {
  readonly type: 'person';
  readonly name: string;
  readonly role?: string;
  readonly affiliation?: string;
}

export type SemanticEntity = SemanticPersonEntity;

export interface SemanticClaim {
  readonly kind: string;
  readonly value: Record<string, unknown>;
}

export interface EvidenceRef {
  readonly id: string;
  readonly kind: string;
  readonly digest?: string;
}

export interface VisualIntent {
  readonly id: string;
  readonly task: VisualTask;
  readonly subject: SemanticEntity;
  readonly claim?: SemanticClaim;
  readonly evidence?: ReadonlyArray<EvidenceRef>;
  readonly desiredEffect: DesiredVisualEffect;
  readonly importance: VisualImportance;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RenderCapabilities {
  readonly dom: boolean;
  readonly svg: boolean;
  readonly canvas: boolean;
  readonly cssAnimations: boolean;
  readonly webAnimations: boolean;
  readonly audio: boolean;
}

export interface VisualContextFacts {
  readonly surface: VisualSurface;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly pixelRatio: number;
    readonly transparent: boolean;
  };
  readonly temporalMode: TemporalMode;
  readonly interaction: VisualInteractionMode;
  readonly safeAreas: ReadonlyArray<Rect>;
  readonly expectedDuration?: number;
  readonly audienceDistance?: AudienceDistance;
  readonly attentionBudget?: AttentionBudget;
  readonly reducedMotion: boolean;
  readonly capabilities: RenderCapabilities;
}

export interface CompiledVisualConstitution {
  readonly identity: string;
  readonly surface: string;
  readonly semantics: string;
  readonly motion: string;
  readonly interaction: string;
  readonly policy: string;
  readonly hardConstraints: ReadonlyArray<string>;
  readonly softPreferences: ReadonlyArray<string>;
  readonly allowedRecipes: ReadonlyArray<RecipeId>;
}

export interface DerivedVisualProfile {
  readonly profileRef: string;
  readonly constitutionRef: string;
  readonly factsHash: string;
}

export interface SemanticCompositionNode {
  readonly id: string;
  readonly primitive: 'identity.announce-person';
  readonly recipeId: RecipeId;
  readonly role: string;
  readonly children?: ReadonlyArray<SemanticCompositionNode>;
}

export interface TemporalStep {
  readonly id: string;
  readonly verb: TemporalVerb;
  readonly target: string;
  readonly durationMs?: number;
}

export interface TemporalCue {
  readonly id: string;
  readonly trigger:
    | { readonly type: 'on-load' }
    | { readonly type: 'operator' }
    | { readonly type: 'presenter-next' }
    | { readonly type: 'after'; readonly cueId: string };
  readonly execution: 'parallel' | 'sequence';
  readonly steps: ReadonlyArray<TemporalStep>;
}

export interface TemporalPlan {
  readonly cues: ReadonlyArray<TemporalCue>;
}

export interface SemanticBinding {
  readonly id: string;
  readonly path: string;
  readonly source: string;
}

export interface SemanticControl {
  readonly id: string;
  readonly label: string;
  readonly kind: 'dismiss' | 'presenter-next';
}

export interface CapabilityRequirement {
  readonly capability: keyof RenderCapabilities;
  readonly required: boolean;
}

export interface VisualPlan {
  readonly composition: SemanticCompositionNode;
  readonly timeline: TemporalPlan;
  readonly bindings: ReadonlyArray<SemanticBinding>;
  readonly controls: ReadonlyArray<SemanticControl>;
  readonly requiredCapabilities: ReadonlyArray<CapabilityRequirement>;
}

export interface DecisionRecord {
  readonly id: string;
  readonly kind: 'constraint' | 'preference' | 'recipe' | 'degradation';
  readonly selected: string;
  readonly reason: string;
}

export interface CandidateRejection {
  readonly candidateId: string;
  readonly reason: string;
}

export interface ResolvedVisualProgram extends VisualPlan {
  readonly id: string;
  readonly intentRef: string;
  readonly profileRef: string;
  readonly constitutionRef: string;
  readonly programHash: string;
  readonly decisions: ReadonlyArray<DecisionRecord>;
  readonly rejectedCandidates: ReadonlyArray<CandidateRejection>;
}

export interface AssetManifest {
  readonly images: ReadonlyArray<string>;
  readonly fonts: ReadonlyArray<string>;
  readonly audio: ReadonlyArray<string>;
}

export interface CompiledVisualBundle {
  readonly bundleId: string;
  readonly constitutionRef: string;
  readonly profileRef: string;
  readonly tokens: Record<string, string>;
  readonly motionParameters: Record<string, string>;
  readonly assets: AssetManifest;
  readonly generatedCss?: string;
  readonly compilerVersion: string;
  readonly capabilitiesHash: string;
  readonly bundleHash: string;
}

export interface CompilationReceipt {
  readonly schemaVersion: typeof VISUAL_PROTOCOL_VERSION;
  readonly compilerVersion: string;
  readonly intentRef: string;
  readonly profileRef: string;
  readonly constitutionRef: string;
  readonly programHash: string;
  readonly bundleHash: string;
  readonly decisionsHash: string;
  readonly rejectedCandidatesHash: string;
}

export interface DomProgramArtifact<TScene = unknown, TCueGraph = unknown> {
  readonly programId: string;
  readonly target: typeof DOM_PROGRAM_TARGET;
  readonly scene: TScene;
  readonly bundle: CompiledVisualBundle;
  readonly timeline?: TCueGraph;
  readonly manifest: CompilationReceipt;
  readonly programHash: string;
}

export class VisualProtocolError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VisualProtocolError';
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalVisualValue(value: unknown, seen = new Set<unknown>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new VisualProtocolError('CANONICAL_VALUE_CYCLIC', 'Visual values must be acyclic');
    }
    seen.add(value);
    const result = value.map((entry) => canonicalVisualValue(entry, seen));
    seen.delete(value);
    return result;
  }

  if (isPlainObject(value)) {
    if (seen.has(value)) {
      throw new VisualProtocolError('CANONICAL_VALUE_CYCLIC', 'Visual values must be acyclic');
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareUtf8)) {
      result[key] = canonicalVisualValue(value[key], seen);
    }
    seen.delete(value);
    return result;
  }

  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }

  throw new VisualProtocolError('CANONICAL_VALUE_INVALID', 'Visual values must be JSON data');
}

export function canonicalVisualJson(value: unknown): string {
  return JSON.stringify(canonicalVisualValue(value));
}

export function visualSha256(value: unknown): string {
  return createHash('sha256').update(canonicalVisualJson(value)).digest('hex');
}

export function compilationReceiptHash(receipt: CompilationReceipt): string {
  return visualSha256(receipt);
}
