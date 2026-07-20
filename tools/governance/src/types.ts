export const ENGINE_VERSION = 'overlaykit-governance-host/v1' as const;
export const PLAN_SCHEMA_VERSION = 'overlaykit-governance-plan/v1' as const;
export const MANIFEST_SCHEMA_VERSION = 'overlaykit-governance-manifest/v1' as const;
export const RUN_SCHEMA_VERSION = 'overlaykit-governance-run/v1' as const;

export type DecisionStatus = 'proposed' | 'accepted' | 'rejected' | 'deprecated';
export type EnforcementTier = 'enforced' | 'advisory' | 'convention' | 'deferred';
export type IdentityKind = 'human' | 'agent' | 'ci' | 'service';
export type GateOutcome = 'passed' | 'failed' | 'waived' | 'pending';
export type ObservationState = 'current' | 'stale' | 'invalid' | 'never-observed';

export interface RulePolicy {
  kind: 'rule';
  id: string;
  statement: string;
}

export interface GatePolicy {
  kind: 'gate';
  id: string;
  description: string;
  tier: EnforcementTier;
  boundTo: string | null;
}

export interface ArtifactPolicy {
  kind: 'artifact';
  id: string;
  description: string;
  tier: EnforcementTier;
  producedBy: string | null;
}

export type DecisionPolicy = RulePolicy | GatePolicy | ArtifactPolicy;

export interface GovernanceDecision {
  schemaVersion: 'overlaykit-governance-decision/v1';
  id: string;
  title: string;
  status: DecisionStatus;
  date: string;
  supersedes: string | null;
  governs: string[];
  context: string;
  decision: string;
  consequences: string[];
  policies: DecisionPolicy[];
}

export interface DecisionRecord {
  decision: GovernanceDecision;
  contentHash: string;
  path: string;
}

export type ClaimKind = 'fact' | 'inference' | 'assumption' | 'unknown';
export type ChangeStatus = 'proposed' | 'approved' | 'implemented' | 'rejected';
export type ChangeRisk = 'low' | 'medium' | 'high' | 'critical';

export interface ChangeClaim {
  kind: ClaimKind;
  statement: string;
  evidence: string | null;
  blocking: boolean;
}

export interface SuccessCriterion {
  id: string;
  statement: string;
  verification: string;
}

export interface DefinitionOfDoneItem {
  id: string;
  statement: string;
  evidence: string;
}

export interface ChangeContract {
  schemaVersion: 'overlaykit-governance-change/v1';
  id: string;
  title: string;
  status: ChangeStatus;
  changeClass: 'governance' | 'architecture' | 'product' | 'security' | 'documentation';
  risk: ChangeRisk;
  owner: string;
  decisions: string[];
  claims: ChangeClaim[];
  successCriteria: SuccessCriterion[];
  definitionOfDone: DefinitionOfDoneItem[];
}

export interface ChangeRecord {
  change: ChangeContract;
  contentHash: string;
  path: string;
}

export interface GovernanceGateDefinition {
  id: string;
  description: string;
  tier: EnforcementTier;
  boundTo: string | null;
}

export interface RequiredArtifact {
  id: string;
  description: string;
  tier: EnforcementTier;
  producedBy: string | null;
}

export interface GovernanceActor {
  kind: IdentityKind;
  id: string;
  principal: string | null;
  roles: string[];
}

export interface GovernanceAssumption {
  id: string;
  statement: string;
  source: string;
}

export interface GovernanceProfile {
  schemaVersion: 'overlaykit-governance-profile/v1';
  name: string;
  version: string;
  decisionIds: string[];
  gates: GovernanceGateDefinition[];
  artifacts: RequiredArtifact[];
  actors: GovernanceActor[];
  assumptions: GovernanceAssumption[];
}

export type MechanismKind =
  | 'local-command'
  | 'github-actions-job'
  | 'github-ruleset'
  | 'human-review';

export interface EnforcementMechanism {
  id: string;
  kind: MechanismKind;
  locator: string;
  subject: string;
  enforcementCapable: boolean;
  expectedCommand: string | null;
}

export interface MechanismRegistry {
  schemaVersion: 'overlaykit-governance-mechanisms/v1';
  mechanisms: EnforcementMechanism[];
}

export interface CompiledDecision {
  id: string;
  title: string;
  declaredStatus: DecisionStatus;
  effectiveStatus: DecisionStatus | 'superseded';
  supersededBy: string | null;
  contentHash: string;
}

export interface GovernanceRule {
  id: string;
  statement: string;
  sourceDecision: string;
}

export interface CompiledGate extends GovernanceGateDefinition {
  sourceDecision: string | null;
  outcome: null;
}

export interface CompiledArtifact extends RequiredArtifact {
  sourceDecision: string | null;
}

export interface GovernancePlan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  engineVersion: typeof ENGINE_VERSION;
  profileName: string;
  profileVersion: string;
  profileHash: string;
  mechanismsHash: string;
  schemasHash: string;
  mechanisms: EnforcementMechanism[];
  decisions: CompiledDecision[];
  rules: GovernanceRule[];
  gates: CompiledGate[];
  artifacts: CompiledArtifact[];
  actors: GovernanceActor[];
  assumptions: GovernanceAssumption[];
  planHash: string;
}

export interface GovernanceManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  decisions: Record<string, string>;
  changes: Record<string, string>;
  schemas: Record<string, string>;
  profileHash: string;
  mechanismsHash: string;
  planHash: string;
  contentHash: string;
}

export interface InvocationIdentity {
  kind: IdentityKind;
  id: string;
  principal: string | null;
}

export interface ProducerIdentity {
  kind: string;
  id: string;
  version: string | null;
  commit: string | null;
}

export interface GateOutcomeRecord {
  gate: string;
  outcome: GateOutcome;
  producerRef: string | null;
  justification: string | null;
  boundTo: string | null;
}

export interface ArtifactEvidenceRecord {
  artifact: string;
  producerRef: string;
  contentHash: string | null;
}

export interface GovernanceRun {
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  runId: string;
  profileHash: string;
  planHash: string;
  manifestHash: string;
  invokedBy: InvocationIdentity;
  producer: ProducerIdentity;
  source: string;
  startedAt: string;
  finishedAt: string;
  assumptions: GovernanceAssumption[];
  outcomes: GateOutcomeRecord[];
  artifacts: ArtifactEvidenceRecord[];
}

export interface ObservedGate extends Omit<CompiledGate, 'outcome'> {
  outcome: GateOutcome;
}

export interface ObservedArtifact extends CompiledArtifact {
  state: 'present' | 'missing';
  producerRef: string | null;
  contentHash: string | null;
}

export interface ObservedPlan extends Omit<GovernancePlan, 'gates' | 'artifacts'> {
  gates: ObservedGate[];
  artifacts: ObservedArtifact[];
}

export interface GovernanceObservation {
  state: ObservationState;
  plan: GovernancePlan | ObservedPlan;
  run: GovernanceRun | null;
  reason: string | null;
  ready: boolean;
  blockers: string[];
}

export interface LoadedContract {
  decisions: DecisionRecord[];
  changes: ChangeRecord[];
  profile: GovernanceProfile;
  mechanisms: MechanismRegistry;
  schemas: Record<string, string>;
  schemasHash: string;
  mechanismsHash: string;
}
