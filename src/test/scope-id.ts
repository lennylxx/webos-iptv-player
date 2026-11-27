import type { ScopeId } from '../navigation/scope-ids';

// A scope id that only a test registers, outside the app's `SCOPES`.
export const scopeId = (name: string): ScopeId => name as ScopeId;
