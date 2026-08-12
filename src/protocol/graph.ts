import { canonicalJson, compareUnicodeCodePoints } from "./canonical.js";
import {
  failure,
  protocolError,
  success,
  type ProtocolError,
  type ProtocolResult,
} from "./errors.js";
import { cloneSafeJson } from "./schema.js";

export interface DependencyNode {
  id: string;
  dependencies: readonly string[];
}

export interface DependencyGraph {
  ids: readonly string[];
  dependenciesByBlock: ReadonlyMap<string, readonly string[]>;
  dependentsByBlock: ReadonlyMap<string, readonly string[]>;
}

function isSafePointer(value: string): boolean {
  if (!value.startsWith("/")
    || [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
    || /~(?![01])/.test(value)) {
    return false;
  }
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

export function buildDependencyGraph(
  nodes: readonly DependencyNode[],
  pathPrefix = "/blocks",
): ProtocolResult<DependencyGraph> {
  if (typeof pathPrefix !== "string" || !isSafePointer(pathPrefix)) {
    return failure([protocolError("SCHEMA_TYPE", "/pathPrefix")]);
  }
  const safe = cloneSafeJson(nodes, pathPrefix);
  if (!safe.ok) return safe;
  if (!Array.isArray(safe.value)) {
    return failure([protocolError("SCHEMA_TYPE", pathPrefix)]);
  }
  const errors: ProtocolError[] = [];
  const validatedNodes: DependencyNode[] = [];
  for (const [index, value] of safe.value.entries()) {
    const nodePath = `${pathPrefix}/${index}`;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(protocolError("SCHEMA_TYPE", nodePath));
      continue;
    }
    const node = value as Record<string, unknown>;
    if (typeof node.id !== "string") {
      errors.push(protocolError("SCHEMA_TYPE", `${nodePath}/id`));
    }
    if (!Array.isArray(node.dependencies)) {
      errors.push(protocolError("SCHEMA_TYPE", `${nodePath}/dependencies`));
    } else {
      const dependencyIds = new Set<string>();
      for (const [dependencyIndex, dependency] of node.dependencies.entries()) {
        if (typeof dependency !== "string") {
          errors.push(protocolError(
            "SCHEMA_TYPE",
            `${nodePath}/dependencies/${dependencyIndex}`,
          ));
        } else if (dependencyIds.has(dependency)) {
          errors.push(protocolError(
            "SCHEMA_UNIQUE_ITEMS",
            `${nodePath}/dependencies/${dependencyIndex}`,
          ));
        }
        if (typeof dependency === "string") dependencyIds.add(dependency);
      }
    }
    if (typeof node.id === "string" && Array.isArray(node.dependencies)
      && node.dependencies.every((dependency) => typeof dependency === "string")) {
      validatedNodes.push({ id: node.id, dependencies: node.dependencies as string[] });
    }
  }
  if (errors.length > 0) return failure(errors);

  const indexById = new Map<string, number>();
  for (const [index, node] of validatedNodes.entries()) {
    if (indexById.has(node.id)) {
      errors.push(protocolError("DUPLICATE_ID", `${pathPrefix}/${index}/id`, node.id));
    } else {
      indexById.set(node.id, index);
    }
  }

  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const node of validatedNodes) {
    dependencies.set(node.id, [...node.dependencies].sort(compareUnicodeCodePoints));
    dependents.set(node.id, []);
  }
  for (const [nodeIndex, node] of validatedNodes.entries()) {
    for (const [dependencyIndex, dependency] of node.dependencies.entries()) {
      if (!indexById.has(dependency)) {
        errors.push(
          protocolError(
            "UNKNOWN_REFERENCE",
            `${pathPrefix}/${nodeIndex}/dependencies/${dependencyIndex}`,
            node.id,
          ),
        );
        continue;
      }
      dependents.get(dependency)?.push(node.id);
    }
  }
  if (errors.length > 0) return failure(errors);

  for (const values of dependents.values()) values.sort(compareUnicodeCodePoints);
  const cycleErrors: ProtocolError[] = [];
  const canReach = (start: string, target: string): boolean => {
    const pending = [start];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(dependencies.get(current) ?? []));
    }
    return false;
  };
  for (const [nodeIndex, node] of validatedNodes.entries()) {
    for (const [dependencyIndex, dependency] of node.dependencies.entries()) {
      if (canReach(dependency, node.id)) {
        cycleErrors.push(
          protocolError(
            "DEPENDENCY_CYCLE",
            `${pathPrefix}/${nodeIndex}/dependencies/${dependencyIndex}`,
            node.id,
          ),
        );
      }
    }
  }
  if (cycleErrors.length > 0) return failure(cycleErrors);

  return success({
    ids: [...indexById.keys()].sort(compareUnicodeCodePoints),
    dependenciesByBlock: dependencies,
    dependentsByBlock: dependents,
  });
}

function copyValidGraph(value: unknown): DependencyGraph | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowedKeys = new Set(["ids", "dependenciesByBlock", "dependentsByBlock"]);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== allowedKeys.size
      || keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) return undefined;
    const readData = (key: string): unknown => {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Invalid graph");
      }
      return descriptor.value;
    };
    const safeIds = cloneSafeJson(readData("ids"), "/graph/ids");
    const dependenciesValue = readData("dependenciesByBlock");
    const dependentsValue = readData("dependentsByBlock");
    if (!safeIds.ok || !Array.isArray(safeIds.value)
      || safeIds.value.some((id) => typeof id !== "string")
      || !(dependenciesValue instanceof Map)
      || !(dependentsValue instanceof Map)) return undefined;
    const graphIds = safeIds.value as string[];
    const ids = new Set(graphIds);
    const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get;
    if (!mapSize) return undefined;
    if (ids.size !== graphIds.length
      || mapSize.call(dependenciesValue) !== ids.size
      || mapSize.call(dependentsValue) !== ids.size) return undefined;
    const copies: Array<Map<string, readonly string[]>> = [];
    for (const map of [dependenciesValue, dependentsValue]) {
      const copy = new Map<string, readonly string[]>();
      for (const entry of Map.prototype.entries.call(map) as IterableIterator<[unknown, unknown]>) {
        const [id, related] = entry;
        const safeRelated = cloneSafeJson(related, "/graph");
        if (typeof id !== "string" || !ids.has(id) || !safeRelated.ok
          || !Array.isArray(safeRelated.value)
          || safeRelated.value.some((item) => typeof item !== "string" || !ids.has(item))) {
          return undefined;
        }
        const typedRelated = safeRelated.value as string[];
        if (new Set(typedRelated).size !== typedRelated.length) return undefined;
        copy.set(id, typedRelated);
      }
      if (copy.size !== ids.size) return undefined;
      copies.push(copy);
    }
    const dependencies = copies[0]!;
    const dependents = copies[1]!;
    for (const id of ids) {
      for (const dependency of dependencies.get(id) ?? []) {
        if (!(dependents.get(dependency) ?? []).includes(id)) return undefined;
      }
      for (const dependent of dependents.get(id) ?? []) {
        if (!(dependencies.get(dependent) ?? []).includes(id)) return undefined;
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const dependency of dependencies.get(id) ?? []) {
        if (hasCycle(dependency)) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if ([...ids].some(hasCycle)) return undefined;
    return {
      ids: graphIds,
      dependenciesByBlock: dependencies,
      dependentsByBlock: dependents,
    };
  } catch {
    return undefined;
  }
}

function transitiveClosure(
  graph: DependencyGraph,
  starts: Iterable<string>,
  direction: "upstream" | "downstream",
): ProtocolResult<readonly string[]> {
  const safeGraph = copyValidGraph(graph);
  if (!safeGraph) {
    return failure([protocolError("SCHEMA_TYPE", "/graph")]);
  }
  const edges = direction === "upstream"
    ? safeGraph.dependenciesByBlock
    : safeGraph.dependentsByBlock;
  let startIds: unknown[];
  try {
    if ((typeof starts !== "object" && typeof starts !== "function") || starts === null) {
      return failure([protocolError("SCHEMA_TYPE", "/blockIds")]);
    }
    if (typeof (starts as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== "function") {
      return failure([protocolError("SCHEMA_TYPE", "/blockIds")]);
    }
    startIds = Array.from(starts as Iterable<unknown>);
  } catch {
    return failure([protocolError("SCHEMA_TYPE", "/blockIds")]);
  }
  const startErrors = startIds.flatMap((id, index) =>
    typeof id === "string" ? [] : [protocolError("SCHEMA_TYPE", `/blockIds/${index}`)]);
  if (startErrors.length > 0) return failure(startErrors);
  const typedStartIds = startIds as string[];
  const pending = [...typedStartIds];
  const visited = new Set<string>();
  for (const id of typedStartIds) {
    if (!safeGraph.dependenciesByBlock.has(id)) {
      return failure([protocolError("UNKNOWN_REFERENCE", "/blockIds", id)]);
    }
  }
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const related of edges.get(current) ?? []) {
      if (!visited.has(related)) {
        visited.add(related);
        pending.push(related);
      }
    }
  }
  for (const start of typedStartIds) visited.delete(start);
  return success([...visited].sort(compareUnicodeCodePoints));
}

export function upstreamClosure(
  graph: DependencyGraph,
  blockIds: Iterable<string>,
): ProtocolResult<readonly string[]> {
  return transitiveClosure(graph, blockIds, "upstream");
}

export function downstreamClosure(
  graph: DependencyGraph,
  blockIds: Iterable<string>,
): ProtocolResult<readonly string[]> {
  return transitiveClosure(graph, blockIds, "downstream");
}
