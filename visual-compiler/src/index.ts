import {
  type CompiledVisualConstitution,
  type DecisionRecord,
  type DerivedVisualProfile,
  type RecipeId,
  type ResolvedVisualProgram,
  type SemanticBinding,
  type SemanticCompositionNode,
  type SemanticControl,
  type TemporalPlan,
  type VisualContextFacts,
  type VisualIntent,
  VisualProtocolError,
  visualSha256,
} from '@overlaykit/visual-protocol';

export const VISUAL_COMPILER_VERSION = '0.1.0' as const;

export const TEAMX_IDENTITY_CONSTITUTION: CompiledVisualConstitution = {
  identity: 'teamx.identity@1.0.0',
  surface: 'surface-pack-derived',
  semantics: 'announce-person@1.0.0',
  motion: 'teamx.motion@1.0.0',
  interaction: 'interaction-pack-derived',
  policy: 'broadcast-accessibility@1.0.0',
  hardConstraints: [
    'renderer-does-not-decide',
    'unknown-capability-does-not-expand-freedom',
    'program-publication-requires-production-host',
  ],
  softPreferences: [
    'prefer-existing-dom-protocol',
    'prefer-readable-name-before-role',
  ],
  allowedRecipes: [
    'broadcast.lower-third',
    'presentation.title-card',
    'presentation.profile-card',
  ],
};

export interface AnnouncePersonCompileInput {
  readonly intent: VisualIntent;
  readonly context: VisualContextFacts;
  readonly constitution?: CompiledVisualConstitution;
}

function assertAnnouncePersonIntent(intent: VisualIntent): void {
  if (intent.task !== 'announce' || intent.subject.type !== 'person') {
    throw new VisualProtocolError(
      'UNSUPPORTED_VISUAL_INTENT',
      'The MVP compiler accepts only announce-person intents',
    );
  }
}

function deriveProfile(
  context: VisualContextFacts,
  constitution: CompiledVisualConstitution,
): DerivedVisualProfile {
  const surfaceRef = context.surface === 'broadcast.overlay'
    ? 'broadcast.overlay@1.0.0'
    : 'presentation.slide@1.0.0';
  const interactionRef = context.interaction === 'presenter'
    ? 'presenter-paced@1.0.0'
    : 'operator-triggered@1.0.0';

  return {
    profileRef: `${surfaceRef}+${interactionRef}`,
    constitutionRef: [
      constitution.identity,
      surfaceRef,
      constitution.semantics,
      constitution.motion,
      interactionRef,
      constitution.policy,
    ].join('+'),
    factsHash: visualSha256(context),
  };
}

function recipeForSurface(context: VisualContextFacts): RecipeId {
  return context.surface === 'broadcast.overlay'
    ? 'broadcast.lower-third'
    : 'presentation.title-card';
}

function compositionFor(recipeId: RecipeId): SemanticCompositionNode {
  if (recipeId === 'broadcast.lower-third') {
    return {
      id: 'composition',
      primitive: 'identity.announce-person',
      recipeId,
      role: 'container',
      children: [
        {
          id: 'subject',
          primitive: 'identity.announce-person',
          recipeId,
          role: 'subject',
        },
      ],
    };
  }

  return {
    id: 'composition',
    primitive: 'identity.announce-person',
    recipeId,
    role: 'container',
    children: [
      {
        id: 'title',
        primitive: 'identity.announce-person',
        recipeId: 'presentation.title-card',
        role: 'subject',
      },
      {
        id: 'profile',
        primitive: 'identity.announce-person',
        recipeId: 'presentation.profile-card',
        role: 'supporting-role',
      },
    ],
  };
}

function timelineFor(context: VisualContextFacts): TemporalPlan {
  const holdDuration = context.surface === 'broadcast.overlay'
    ? context.expectedDuration ?? 6_000
    : context.expectedDuration ?? 0;

  return {
    cues: [
      {
        id: 'intro',
        trigger: { type: 'on-load' },
        execution: 'sequence',
        steps: [
          { id: 'establish-subject', verb: 'establish', target: 'subject', durationMs: 420 },
          { id: 'reveal-role', verb: 'reveal', target: 'supporting-role', durationMs: 240 },
          { id: 'hold-readable', verb: 'hold', target: 'composition', durationMs: holdDuration },
          { id: 'dismiss-composition', verb: 'dismiss', target: 'composition', durationMs: 160 },
        ],
      },
    ],
  };
}

function bindingsFor(intent: VisualIntent): ReadonlyArray<SemanticBinding> {
  const bindings: SemanticBinding[] = [
    { id: 'person-name', path: 'subject.name', source: `${intent.id}.subject.name` },
  ];
  if (intent.subject.role) {
    bindings.push({ id: 'person-role', path: 'subject.role', source: `${intent.id}.subject.role` });
  }
  if (intent.subject.affiliation) {
    bindings.push({
      id: 'person-affiliation',
      path: 'subject.affiliation',
      source: `${intent.id}.subject.affiliation`,
    });
  }
  return bindings;
}

function controlsFor(context: VisualContextFacts): ReadonlyArray<SemanticControl> {
  if (context.surface === 'presentation.slide') {
    return [{ id: 'next', label: 'Next', kind: 'presenter-next' }];
  }
  return [{ id: 'dismiss', label: 'Dismiss', kind: 'dismiss' }];
}

function decisionsFor(context: VisualContextFacts, recipeId: RecipeId): ReadonlyArray<DecisionRecord> {
  return [
    {
      id: 'surface-recipe',
      kind: 'recipe',
      selected: recipeId,
      reason: `${context.surface} selects a surface recipe before DOM lowering`,
    },
    {
      id: 'production-boundary',
      kind: 'constraint',
      selected: 'preview-only-candidate',
      reason: 'The compiler emits an artifact candidate; OverlayKit production authority owns Take',
    },
  ];
}

export function resolveAnnouncePersonProgram({
  intent,
  context,
  constitution = TEAMX_IDENTITY_CONSTITUTION,
}: AnnouncePersonCompileInput): ResolvedVisualProgram {
  assertAnnouncePersonIntent(intent);
  if (!context.capabilities.dom || !context.capabilities.cssAnimations) {
    throw new VisualProtocolError(
      'REQUIRED_CAPABILITY_MISSING',
      'announce-person MVP requires DOM and CSS animation capability',
    );
  }

  const profile = deriveProfile(context, constitution);
  const recipeId = recipeForSurface(context);
  const composition = compositionFor(recipeId);
  const timeline = timelineFor(context);
  const bindings = bindingsFor(intent);
  const controls = controlsFor(context);
  const decisions = decisionsFor(context, recipeId);
  const rejectedCandidates = constitution.allowedRecipes
    .filter((candidate) => candidate !== recipeId)
    .map((candidate) => ({
      candidateId: candidate,
      reason: `${candidate} is not the selected recipe for ${context.surface}`,
    }));
  const body = {
    bindings,
    composition,
    constitutionRef: profile.constitutionRef,
    controls,
    decisions,
    intentRef: intent.id,
    profileRef: profile.profileRef,
    rejectedCandidates,
    requiredCapabilities: [
      { capability: 'dom' as const, required: true },
      { capability: 'cssAnimations' as const, required: true },
    ],
    timeline,
  };
  const programHash = visualSha256(body);

  return {
    ...body,
    id: `vp_${programHash.slice(0, 16)}`,
    programHash,
  };
}
