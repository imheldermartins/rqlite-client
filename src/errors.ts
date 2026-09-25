export class RqliteError extends Error {
  constructor(public readonly code: string, message: string, public readonly statementIndex?: number, options?: ErrorOptions) {
    super(message, options); this.name = 'RqliteError';
  }
}
