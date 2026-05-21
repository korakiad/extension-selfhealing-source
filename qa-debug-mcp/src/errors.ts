export type QaErrorCode = 'NO_ACTIVE_PAUSE' | 'SESSION_NOT_FOUND';

export class QaToolError extends Error {
  constructor(public readonly code: QaErrorCode, message: string) {
    super(message);
    this.name = 'QaToolError';
  }
}

export function errorResult(err: unknown) {
  if (err instanceof QaToolError) {
    return {
      content: [{ type: 'text' as const, text: `${err.code}: ${err.message}` }],
      isError: true,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `INTERNAL_ERROR: ${msg}` }],
    isError: true,
  };
}
