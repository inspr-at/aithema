/** @import { VerifiedAuthority } from './types.js' */
import { validateAuthority } from './validate.js';

/** @param {VerifiedAuthority} authority */
export function hasRole(authority, role) {
  return Array.isArray(authority?.roles) && authority.roles.includes(role);
}

/**
 * Any verified party may contribute proposals; approval is a separate gate.
 * @param {VerifiedAuthority} authority
 */
export function assertCanContribute(authority) {
  validateAuthority(authority);
}

/**
 * @param {VerifiedAuthority} authority
 */
export function assertCanApproveBaseline(authority) {
  assertCanContribute(authority);
  if (!hasRole(authority, 'requirements_approver')) {
    throw new Error('requirements_approver role is required to approve a baseline');
  }
}

/**
 * Import creates proposals only; it never replaces an approved baseline.
 * @param {VerifiedAuthority} authority
 */
export function assertCanProposeImport(authority) {
  assertCanContribute(authority);
}
