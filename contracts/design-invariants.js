/** Structural bounds must run before walking the recursive screen schema. */
export function screenBounds(doc) {
  const stack = [{ node: doc, depth: 0 }];
  const ancestors = new Set();
  let count = 0;
  while (stack.length) {
    const { node, depth, exit } = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (exit) { ancestors.delete(node); continue; }
    if (ancestors.has(node)) return ['design_ir_invalid: cyclic objects'];
    ancestors.add(node);
    stack.push({ node, exit: true });
    // An object/array needs at least two canonical bytes. This traversal bound
    // cannot reject a document within the 512 KiB IR limit merely because it
    // has many small table rows. Component bounds are checked separately.
    if (depth > 40 || ++count > 262_144) return ['design_limit: screen depth or object bound exceeded'];
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push({ node: value, depth: depth + 1 });
    }
  }
  const components = (Array.isArray(doc?.nodes) ? doc.nodes : []).map((node) => ({ node, depth: 1 }));
  let nodes = 0;
  while (components.length) {
    const { node, depth } = components.pop();
    if (++nodes > 2000 || depth > 16) return ['design_limit: maximum 2000 nodes and 16 component levels'];
    if (Array.isArray(node?.children)) {
      for (const child of node.children) components.push({ node: child, depth: depth + 1 });
    }
  }
  return [];
}

/** Called only after shape validation, so child arrays and ids are typed. */
export function screenInvariants(doc) {
  const out = [];
  if (doc.minor < 1 || doc.min_reader < 1) out.push('design_ir_invalid: rendering metadata requires screen minor/min_reader 1');
  const ids = new Set();
  const targets = [];
  const stack = doc.nodes.map((node) => ({ node, depth: 1 }));
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++count > 2000 || depth > 16) {
      out.push('design_limit: maximum 2000 nodes and 16 component levels');
      break;
    }
    if (ids.has(node.id)) out.push('design_duplicate_id: node ids must be unique');
    ids.add(node.id);
    if (node.kind === 'link') targets.push(node.target);
    if (node.kind === 'table' && node.rows.some((row) => row.length !== node.columns.length)) {
      out.push('design_ir_invalid: table rows must match columns');
    }
    for (const child of node.children ?? []) stack.push({ node: child, depth: depth + 1 });
  }
  if (targets.some((target) => !ids.has(target))) out.push('design_reference_invalid: link target must resolve within the screen');
  return [...new Set(out)];
}
