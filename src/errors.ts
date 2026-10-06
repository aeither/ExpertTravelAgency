export class ApiError extends Error {
  constructor(public statusCode: number, public code: string, message: string,
    public details?: unknown, public uncertain = false) { super(message); }
}
export function unavailable(provider: string, variable: string): never {
  throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', `Set ${variable} to use ${provider}.`);
}
