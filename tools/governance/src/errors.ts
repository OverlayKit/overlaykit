export class GovernanceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GovernanceError';
  }
}

export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) {
    throw new GovernanceError(code, message);
  }
}
