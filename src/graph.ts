import type { Service } from './types.js';

export interface GraphError {
  kind: 'cycle' | 'missing-dependency' | 'locked';
  message: string;
  nodes: string[];
}

export interface StartPlan {
  /** Services in the order they should be started (dependencies first). */
  order: string[];
  /** Maps service id -> ids that must be healthy before it starts. */
  dependencies: Record<string, string[]>;
  errors: GraphError[];
}

/**
 * Build a deterministic start plan using Kahn's algorithm.
 * Ties are broken by the order services were declared, so results are stable.
 * Stop order is simply the reverse of start order.
 */
export function buildStartPlan(services: Service[]): StartPlan {
  const ids = services.map((s) => s.id);
  const byId = new Map(services.map((s) => [s.id, s]));
  const deps: Record<string, string[]> = {};
  const errors: GraphError[] = [];

  for (const s of services) {
    const list = (s.dependsOn || []).filter((d) => d !== s.id);
    deps[s.id] = list;
    for (const d of list) {
      if (!byId.has(d)) {
        errors.push({
          kind: 'missing-dependency',
          message: `Service "${s.id}" depends on unknown service "${d}"`,
          nodes: [s.id, d],
        });
      }
    }
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const s of services) {
    for (const d of deps[s.id] || []) {
      if (!byId.has(d)) continue;
      indegree.set(s.id, (indegree.get(s.id) || 0) + 1);
      dependents.get(d)!.push(s.id);
    }
  }

  const order: string[] = [];
  const ready = ids.filter((id) => (indegree.get(id) || 0) === 0);
  ready.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));

  const queue = [...ready];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) || []) {
      const next = (indegree.get(dependent) || 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        queue.push(dependent);
        queue.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
      }
    }
  }

  if (order.length !== ids.length) {
    const remaining = ids.filter((id) => !order.includes(id));
    const cycle = findCycle(remaining, deps);
    errors.push({
      kind: 'cycle',
      message: `Dependency cycle detected: ${cycle.join(' -> ')}`,
      nodes: cycle,
    });
  }

  return { order, dependencies: deps, errors };
}

function findCycle(nodeIds: string[], deps: Record<string, string[]>): string[] {
  const set = new Set(nodeIds);
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let found: string[] = [];

  function dfs(n: string): boolean {
    if (onStack.has(n)) {
      found = [...stack.slice(stack.indexOf(n)), n];
      return true;
    }
    if (visited.has(n)) return false;
    visited.add(n);
    onStack.add(n);
    stack.push(n);
    for (const d of deps[n] || []) {
      if (!set.has(d)) continue;
      if (dfs(d)) return true;
    }
    stack.pop();
    onStack.delete(n);
    return false;
  }

  for (const n of nodeIds) {
    if (dfs(n)) break;
  }
  return found.length ? found : nodeIds;
}

/** Given a set of services to stop, also include anything that depends on them. */
export function withDependents(services: Service[], requested: string[]): string[] {
  const result = new Set<string>(requested);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of services) {
      if (result.has(s.id)) continue;
      if ((s.dependsOn || []).some((d) => result.has(d))) {
        result.add(s.id);
        changed = true;
      }
    }
  }
  return services.filter((s) => result.has(s.id)).map((s) => s.id);
}

/** Validate a profile references only existing services. */
export function validateProfile(projectServices: Service[], profileServices: string[]): GraphError[] {
  const ids = new Set(projectServices.map((s) => s.id));
  const errors: GraphError[] = [];
  for (const id of profileServices) {
    if (!ids.has(id)) {
      errors.push({
        kind: 'missing-dependency',
        message: `Profile references unknown service "${id}"`,
        nodes: [id],
      });
    }
  }
  return errors;
}

/** Given a requested set of services, expand to include transitive dependencies. */
export function withDependencies(services: Service[], requested: string[]): string[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const result = new Set<string>();
  const visit = (id: string): void => {
    if (result.has(id)) return;
    const svc = byId.get(id);
    if (!svc) return;
    result.add(id);
    for (const d of svc.dependsOn || []) visit(d);
  };
  for (const id of requested) visit(id);
  return services.filter((s) => result.has(s.id)).map((s) => s.id);
}
