import type { ProductionBus } from '@overlaykit/protocol';

/**
 * A single input field a Bitfocus Companion action exposes on a button. This is a deliberately
 * minimal, vendor-neutral shape: it names the fields Companion needs to render an option without
 * importing any Companion or Elgato SDK type (REQ-INT-002 keeps hardware-specific behavior out of
 * the core and out of this adapter's contract surface).
 */
export interface CompanionActionOption {
  readonly id: string;
  readonly type: 'checkbox';
  readonly label: string;
  readonly default: boolean;
}

/**
 * The adapter's projection of one authorized Control API action into the definition a Companion
 * module registers. It carries both the operator-facing label and the routing coordinates a later
 * runtime slice needs to execute the command against the Control API — the Show, the Preview or
 * Program target, the component, and its declared control id.
 */
export interface CompanionActionDefinition {
  readonly actionId: string;
  readonly name: string;
  readonly showId: string;
  readonly target: ProductionBus;
  readonly componentId: string;
  readonly controlId: string;
  readonly options: ReadonlyArray<CompanionActionOption>;
}
