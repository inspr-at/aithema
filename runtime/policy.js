/**
 * Operator-configured execution/data policy and outbound request ceilings.
 * Workspace config is the policy boundary; it is not organizational identity.
 * Browser input cannot set policy, data class, epoch, or ceilings.
 * Request ceilings count outbound provider calls. They are not currency.
 */

export const EXECUTION_MODES = Object.freeze(['local', 'cloud', 'mixed']);
export const EXECUTION_LOCATIONS = Object.freeze(['local', 'cloud']);
export const SPEND_PHASES = Object.freeze(['chat', 'understand', 'interpret']);
export const BILLING_USAGE_UNAVAILABLE = 'billing usage unavailable';

export const POLICY_ID_MAX_CHARS = 80;
export const DATA_CLASS_MAX_CHARS = 64;
export const CALL_ID_MAX_CHARS = 200;
export const MAX_OUTBOUND_CALLS_CEILING = 1_000_000;
export const MAX_POLICY_EPOCH = 1_000_000_000;

const PROVIDER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const DATA_CLASS_RE = /^[a-z][a-z0-9._-]{0,63}$/;

/**
 * @param {string} message
 * @param {string} reason
 */
export function policyDeniedError(message, reason) {
  return Object.assign(new Error(message), { code: 'policy_denied', reason });
}

/**
 * @param {string} message
 * @param {string} code
 */
export function spendError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function boundProviderId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw policyDeniedError('providerId is required', 'provider');
  }
  const id = value.trim();
  if (id.length > POLICY_ID_MAX_CHARS || !PROVIDER_ID_RE.test(id)) {
    throw policyDeniedError('providerId is invalid', 'provider');
  }
  return id;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function boundDataClass(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('data class is required');
  }
  const label = value.trim();
  if (label.length > DATA_CLASS_MAX_CHARS || !DATA_CLASS_RE.test(label)) {
    throw new Error('data class is invalid');
  }
  return label;
}

/**
 * Stable spend ledger id. Does not include prompt or document text.
 * @param {string} turnId
 * @param {string} phase
 */
export function spendCallId(turnId, phase) {
  if (!SPEND_PHASES.includes(phase)) {
    throw new Error('spend phase is invalid');
  }
  if (typeof turnId !== 'string' || !turnId.trim()) {
    throw new Error('turn id is required');
  }
  const id = `c:${turnId.trim()}:${phase}`;
  if (id.length > CALL_ID_MAX_CHARS) {
    throw new Error('spend call id exceeds storage bound');
  }
  return id;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]}
 */
function uniqueBoundIds(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const id = name === 'allowedDataClasses' ? boundDataClass(item) : boundProviderId(item);
    if (seen.has(id)) throw new Error(`${name} must not contain duplicates`);
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function boundEpoch(value) {
  if (value == null || value === '') return 1;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_POLICY_EPOCH) {
    throw new Error('policy epoch must be a positive integer');
  }
  return numeric;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number | null}
 */
function boundCeiling(value, name) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_OUTBOUND_CALLS_CEILING) {
    throw new Error(`${name} must be a positive integer request count, not currency`);
  }
  return numeric;
}

/**
 * @param {unknown} value
 * @returns {'local' | 'cloud' | 'mixed'}
 */
function boundExecution(value) {
  if (!EXECUTION_MODES.includes(value)) {
    throw new Error('policy execution must be local, cloud, or mixed');
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {'local' | 'cloud'}
 */
export function boundExecutionLocation(value) {
  if (!EXECUTION_LOCATIONS.includes(value)) {
    throw new Error('executionLocation must be local or cloud');
  }
  return value;
}

/**
 * @param {unknown} entry
 * @param {string} providerId
 */
export function providerPolicyFields(entry, providerId) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`provider ${providerId} is not in the operator registry`);
  }
  return {
    executionLocation: boundExecutionLocation(entry.executionLocation),
    allowedDataClasses: Object.freeze(uniqueBoundIds(entry.allowedDataClasses, 'allowedDataClasses')),
  };
}

/**
 * @param {string} parent
 * @param {string} child
 */
function executionNarrows(parent, child) {
  if (parent === 'mixed') return EXECUTION_MODES.includes(child);
  return child === parent;
}

/**
 * @param {readonly string[]} parent
 * @param {readonly string[]} child
 */
function isSubset(parent, child) {
  const allowed = new Set(parent);
  return child.every((item) => allowed.has(item));
}

/**
 * Operator org policy. Absent/null keeps historical single-provider behaviour.
 * Presence is fail-closed: unknown location or class cannot satisfy a constraint.
 *
 * Epoch is an operator spend window. Bump it in server config to start a new
 * request-count window. Browsers cannot reset epoch. Prior ledger rows remain.
 *
 * @param {unknown} value
 * @param {{ providers?: unknown, defaultProvider?: unknown }} [context]
 * @returns {object | null}
 */
export function normalizeOrgPolicy(value, context = {}) {
  if (value == null) return null;
  if (value === false) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('policy must be an object');
  }
  const providers = context.providers;
  if (providers == null || typeof providers !== 'object' || Array.isArray(providers)) {
    throw new Error('policy requires the operator provider registry');
  }
  const execution = boundExecution(value.execution);
  const allowedProviders = uniqueBoundIds(value.allowedProviders, 'allowedProviders');
  const allowedDataClasses = uniqueBoundIds(value.allowedDataClasses, 'allowedDataClasses');
  const dataClass = boundDataClass(value.dataClass ?? 'unclassified');
  if (!allowedDataClasses.includes(dataClass)) {
    throw new Error('policy dataClass must be listed in allowedDataClasses');
  }
  const defaultProvider = typeof context.defaultProvider === 'string'
    ? boundProviderId(context.defaultProvider)
    : null;
  if (defaultProvider && !allowedProviders.includes(defaultProvider)) {
    throw new Error('defaultProvider is not allowed by organization policy');
  }
  for (const id of allowedProviders) {
    if (!Object.hasOwn(providers, id)) {
      throw new Error(`policy allowedProviders includes unknown provider ${id}`);
    }
    providerPolicyFields(providers[id], id);
  }
  const maxOutboundCallsPerProject = boundCeiling(
    value.maxOutboundCallsPerProject,
    'maxOutboundCallsPerProject',
  );
  const epoch = boundEpoch(value.epoch);
  const projectSource = value.projects;
  /** @type {Record<string, object>} */
  const projects = Object.create(null);
  if (projectSource != null) {
    if (typeof projectSource !== 'object' || Array.isArray(projectSource)) {
      throw new Error('policy projects must be an object keyed by project_ref');
    }
    for (const [projectRef, override] of Object.entries(projectSource)) {
      if (typeof projectRef !== 'string' || !projectRef.trim() || projectRef.length > 200) {
        throw new Error('policy project key is invalid');
      }
      projects[projectRef] = freezeEffective(normalizeProjectOverride(override, {
        execution,
        allowedProviders,
        allowedDataClasses,
        dataClass,
        maxOutboundCallsPerProject,
        epoch,
      }));
    }
  }
  return freezeEffective({
    epoch,
    execution,
    allowedProviders: Object.freeze(allowedProviders),
    allowedDataClasses: Object.freeze(allowedDataClasses),
    dataClass,
    maxOutboundCallsPerProject,
    projects: Object.freeze(projects),
  });
}

/**
 * @param {unknown} override
 * @param {object} org
 */
function normalizeProjectOverride(override, org) {
  if (override == null || typeof override !== 'object' || Array.isArray(override)) {
    throw new Error('project policy must be an object');
  }
  const execution = override.execution == null ? org.execution : boundExecution(override.execution);
  if (!executionNarrows(org.execution, execution)) {
    throw new Error('project policy cannot broaden organization execution');
  }
  const allowedProviders = override.allowedProviders == null
    ? [...org.allowedProviders]
    : uniqueBoundIds(override.allowedProviders, 'allowedProviders');
  if (!isSubset(org.allowedProviders, allowedProviders)) {
    throw new Error('project policy cannot add providers beyond the organization');
  }
  const allowedDataClasses = override.allowedDataClasses == null
    ? [...org.allowedDataClasses]
    : uniqueBoundIds(override.allowedDataClasses, 'allowedDataClasses');
  if (!isSubset(org.allowedDataClasses, allowedDataClasses)) {
    throw new Error('project policy cannot add data classes beyond the organization');
  }
  const dataClass = override.dataClass == null ? org.dataClass : boundDataClass(override.dataClass);
  if (!allowedDataClasses.includes(dataClass)) {
    throw new Error('project dataClass must be listed in project allowedDataClasses');
  }
  let maxOutboundCallsPerProject;
  if (override.maxOutboundCallsPerProject == null || override.maxOutboundCallsPerProject === '') {
    maxOutboundCallsPerProject = org.maxOutboundCallsPerProject;
  } else {
    maxOutboundCallsPerProject = boundCeiling(
      override.maxOutboundCallsPerProject,
      'maxOutboundCallsPerProject',
    );
    if (
      org.maxOutboundCallsPerProject != null
      && maxOutboundCallsPerProject > org.maxOutboundCallsPerProject
    ) {
      throw new Error('project request ceiling cannot exceed the organization ceiling');
    }
  }
  return {
    epoch: org.epoch,
    execution,
    allowedProviders,
    allowedDataClasses,
    dataClass,
    maxOutboundCallsPerProject,
  };
}

function freezeEffective(policy) {
  return Object.freeze({
    epoch: policy.epoch,
    execution: policy.execution,
    allowedProviders: Object.freeze([...policy.allowedProviders]),
    allowedDataClasses: Object.freeze([...policy.allowedDataClasses]),
    dataClass: policy.dataClass,
    maxOutboundCallsPerProject: policy.maxOutboundCallsPerProject,
    ...(policy.projects ? { projects: policy.projects } : {}),
  });
}

/**
 * Project policy is operator config keyed by project_ref, intersected with org.
 * Unknown project keys simply inherit the organization defaults.
 * @param {object | null} orgPolicy
 * @param {string} projectRef
 */
export function effectiveProjectPolicy(orgPolicy, projectRef) {
  if (!orgPolicy) return null;
  const override = orgPolicy.projects?.[projectRef];
  if (override) {
    return override;
  }
  return freezeEffective({
    epoch: orgPolicy.epoch,
    execution: orgPolicy.execution,
    allowedProviders: orgPolicy.allowedProviders,
    allowedDataClasses: orgPolicy.allowedDataClasses,
    dataClass: orgPolicy.dataClass,
    maxOutboundCallsPerProject: orgPolicy.maxOutboundCallsPerProject,
  });
}

/**
 * Fail closed before any outbound call. No default substitution.
 * @param {object} effective
 * @param {{
 *   providerId: string,
 *   model?: unknown,
 *   executionLocation?: unknown,
 *   allowedModels?: readonly string[],
 *   providerDataClasses?: readonly string[],
 * }} selection
 */
export function assertCallAllowed(effective, selection) {
  const providerId = boundProviderId(selection.providerId);
  if (!effective.allowedProviders.includes(providerId)) {
    throw policyDeniedError('provider is not allowed by project policy', 'provider');
  }
  let location;
  try {
    location = boundExecutionLocation(selection.executionLocation);
  } catch {
    throw policyDeniedError('provider execution location is unknown', 'location');
  }
  if (effective.execution !== 'mixed' && location !== effective.execution) {
    throw policyDeniedError('provider execution location is not allowed by project policy', 'location');
  }
  const allowedModels = Array.isArray(selection.allowedModels) ? selection.allowedModels : [];
  if (selection.model != null && selection.model !== '') {
    if (typeof selection.model !== 'string' || !allowedModels.includes(selection.model)) {
      throw policyDeniedError('requested model is not in the operator-approved registry', 'model');
    }
  }
  const dataClass = effective.dataClass;
  if (typeof dataClass !== 'string' || !effective.allowedDataClasses.includes(dataClass)) {
    throw policyDeniedError('data class is unknown or not allowed by project policy', 'data_class');
  }
  const providerClasses = Array.isArray(selection.providerDataClasses)
    ? selection.providerDataClasses
    : [];
  if (providerClasses.length === 0) {
    throw policyDeniedError('provider data classes are unknown', 'data_class');
  }
  if (!providerClasses.includes(dataClass)) {
    throw policyDeniedError('project data class is not allowed for this provider', 'data_class');
  }
}

/**
 * @param {object | null} orgPolicy
 * @param {string} projectRef
 * @param {Record<string, { id: string, modelId: string, allowedModels?: readonly string[] }>} providers
 * @param {string} defaultProviderId
 */
export function allowedSelections(orgPolicy, projectRef, providers, defaultProviderId) {
  const effective = effectiveProjectPolicy(orgPolicy, projectRef);
  if (!effective) {
    const adapter = providers[defaultProviderId];
    const models = adapter?.allowedModels ?? (adapter ? [adapter.modelId] : []);
    return Object.freeze({
      defaultProviderId,
      defaultAllowed: Boolean(adapter),
      providers: adapter
        ? Object.freeze([{ id: defaultProviderId, models: Object.freeze([...models]) }])
        : Object.freeze([]),
    });
  }
  const listed = [];
  for (const id of effective.allowedProviders) {
    const adapter = providers[id];
    if (!adapter) continue;
    try {
      assertCallAllowed(effective, {
        providerId: id,
        executionLocation: adapter.executionLocation,
        allowedModels: adapter.allowedModels ?? [adapter.modelId],
        providerDataClasses: adapter.allowedDataClasses,
      });
    } catch {
      continue;
    }
    listed.push(Object.freeze({
      id,
      models: Object.freeze([...(adapter.allowedModels ?? [adapter.modelId])]),
    }));
  }
  return Object.freeze({
    defaultProviderId,
    defaultAllowed: listed.some((item) => item.id === defaultProviderId),
    providers: Object.freeze(listed),
  });
}
