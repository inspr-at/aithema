import { boundary } from './boundary.js';
/** @import { VerifiedAuthority } from './types.js' */
import { validateAuthority } from './validate.js';

/** @param {VerifiedAuthority} authority */
function hasRoleImpl(authority, role) {
  return Array.isArray(authority?.roles) && authority.roles.includes(role);
}

/**
 * Any verified party may contribute proposals; approval is a separate gate.
 * @param {VerifiedAuthority} authority
 */
function assertCanContributeImpl(authority) {
  validateAuthority(authority);
}

/**
 * @param {VerifiedAuthority} authority
 */
function assertCanApproveBaselineImpl(authority) {
  assertCanContributeImpl(authority);
  if (!hasRoleImpl(authority, 'requirements_approver')) {
    throw new Error('requirements_approver role is required to approve a baseline');
  }
}

/**
 * Import creates proposals only; it never replaces an approved baseline.
 * @param {VerifiedAuthority} authority
 */
function assertCanProposeImportImpl(authority) {
  assertCanContributeImpl(authority);
}

export const hasRole = boundary(hasRoleImpl);
export const assertCanContribute = boundary(assertCanContributeImpl);
export const assertCanApproveBaseline = boundary(assertCanApproveBaselineImpl);
export const assertCanProposeImport = boundary(assertCanProposeImportImpl);
