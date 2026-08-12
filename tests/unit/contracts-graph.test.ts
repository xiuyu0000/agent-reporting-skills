import { describe, expect, it } from "vitest";
import {
  buildDependencyGraph,
  downstreamClosure,
  upstreamClosure,
} from "../../src/protocol/index.js";

describe("decision dependency DAG", () => {
  const nodes = [
    { id: "B001", dependencies: [] },
    { id: "B002", dependencies: ["B001"] },
    { id: "B003", dependencies: ["B002"] },
    { id: "B004", dependencies: ["B001"] },
  ];

  it("computes stable transitive upstream and downstream closures", () => {
    const graph = buildDependencyGraph(nodes);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(upstreamClosure(graph.value, ["B003"])).toEqual({ ok: true, value: ["B001", "B002"] });
    expect(downstreamClosure(graph.value, ["B001"])).toEqual({
      ok: true,
      value: ["B002", "B003", "B004"],
    });
  });

  it("locates duplicate IDs, missing dependencies, and cycles", () => {
    const duplicate = buildDependencyGraph([...nodes, { id: "B004", dependencies: [] }]);
    expect(duplicate.ok ? [] : duplicate.errors).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_ID", path: "/blocks/4/id" }),
    );
    const missing = buildDependencyGraph([{ id: "B001", dependencies: ["B999"] }]);
    expect(missing.ok ? [] : missing.errors).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_REFERENCE", path: "/blocks/0/dependencies/0" }),
    );
    const cycle = buildDependencyGraph([
      { id: "B001", dependencies: ["B002"] },
      { id: "B002", dependencies: ["B001"] },
    ]);
    expect(cycle.ok ? [] : cycle.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "DEPENDENCY_CYCLE" })]),
    );
    const repeated = buildDependencyGraph([
      { id: "B001", dependencies: [] },
      { id: "B002", dependencies: ["B001", "B001"] },
    ]);
    expect(repeated.ok ? [] : repeated.errors).toContainEqual(
      expect.objectContaining({
        code: "SCHEMA_UNIQUE_ITEMS",
        path: "/blocks/1/dependencies/1",
      }),
    );
  });

  it("fails closure requests for unknown starts", () => {
    const graph = buildDependencyGraph(nodes);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    const result = downstreamClosure(graph.value, ["B999"]);
    expect(result.ok ? [] : result.errors).toContainEqual(
      expect.objectContaining({ code: "UNKNOWN_REFERENCE", path: "/blockIds" }),
    );
  });

  it("consumes a single-pass iterable exactly once", () => {
    const graph = buildDependencyGraph(nodes);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    function* starts() {
      yield "B001";
    }
    expect(downstreamClosure(graph.value, starts())).toEqual({
      ok: true,
      value: ["B002", "B003", "B004"],
    });
  });

  it("fails closed for malformed graph inputs and hostile iterables", () => {
    const malformedNodes: unknown[] = [
      null,
      [{ id: "B001", dependencies: null }],
      [{ id: 1, dependencies: [] }],
      [{ id: "B001", dependencies: [1] }],
      Object.assign([], { extra: "not JSON array data" }),
    ];
    for (const input of malformedNodes) {
      expect(() => buildDependencyGraph(input as never)).not.toThrow();
      const result = buildDependencyGraph(input as never);
      expect(result).toEqual(expect.objectContaining({ ok: false, mutated: false }));
    }

    const graph = buildDependencyGraph(nodes);
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    const throwingStarts = {
      [Symbol.iterator](): Iterator<string> {
        throw new Error("iterator failure");
      },
    };
    const hostileMap = new Proxy(graph.value.dependenciesByBlock as Map<string, readonly string[]>, {
      get() {
        throw new Error("map failure");
      },
    });
    const cyclicGraph = {
      ids: ["B001", "B002"],
      dependenciesByBlock: new Map([
        ["B001", ["B002"]],
        ["B002", ["B001"]],
      ]),
      dependentsByBlock: new Map([
        ["B001", ["B002"]],
        ["B002", ["B001"]],
      ]),
    };
    class LiarMap<K, V> extends Map<K, V> {
      override entries(): MapIterator<[K, V]> {
        return new Map<K, V>().entries();
      }
    }
    const liarDependencies = new LiarMap(graph.value.dependenciesByBlock);
    const liarGraph = { ...graph.value, dependenciesByBlock: liarDependencies };
    let idGets = 0;
    const proxiedIds = new Proxy([...graph.value.ids], {
      get(target, property, receiver) {
        idGets += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const proxiedIdGraph = { ...graph.value, ids: proxiedIds };
    const inheritedGraph = Object.create(graph.value) as typeof graph.value;
    const extraGraph = { ...graph.value, extra: true };
    for (const result of [
      upstreamClosure(null as never, []),
      downstreamClosure(graph.value, null as never),
      downstreamClosure(graph.value, {} as never),
      downstreamClosure(graph.value, { 0: "B001", length: 1 } as never),
      upstreamClosure(graph.value, throwingStarts),
      upstreamClosure({ ...graph.value, dependenciesByBlock: hostileMap }, []),
      upstreamClosure(cyclicGraph, ["B001"]),
      upstreamClosure(inheritedGraph, ["B001"]),
      upstreamClosure(extraGraph, ["B001"]),
    ]) {
      expect(result).toEqual(expect.objectContaining({ ok: false, mutated: false }));
    }
    expect(upstreamClosure(graph.value, ["B003"]).ok).toBe(true);
    expect(downstreamClosure(graph.value, ["B001"]).ok).toBe(true);
    expect(upstreamClosure(liarGraph, ["B003"])).toEqual({
      ok: true,
      value: ["B001", "B002"],
    });
    expect(upstreamClosure(proxiedIdGraph, ["B003"])).toEqual({
      ok: true,
      value: ["B001", "B002"],
    });
    expect(idGets).toBe(0);
  });
});
