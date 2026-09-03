import { describe, expect, it } from "vitest";
import {
  createExactGeneratedArtifactByteVerifiers,
  createValidationFailureResult,
  exitCodeForValidationResult,
  rejectLegacyStaticContract,
} from "../../src/cli/validate.js";
import { generateArtifactBytes, GENERATOR_VERSION } from "../../src/generators/index.js";
import { protocolError } from "../../src/protocol/index.js";
import {
  approvalTemplateBytes,
  reviewDocumentFixture,
} from "../fixtures/validate/helpers.js";

function hostileProxy(sentinel: string): object {
  return new Proxy({}, {
    ownKeys() {
      throw new Error(sentinel);
    },
  });
}

describe("closed consume validation facade", () => {
  it("rejects both legacy markers and accepts only safe near misses", () => {
    for (const legacy of [
      { schema_version: "dual-audience-report-contract-v1" },
      { format: "dual-audience-report-contract-v1" },
      {
        schema_version: "dual-audience-report-contract-v1",
        format: "review-document/1",
      },
    ]) {
      expect(rejectLegacyStaticContract(legacy)).toEqual({
        ok: false,
        errors: [expect.objectContaining({
          code: "LEGACY_CONTRACT_INCOMPATIBLE",
          path: "/format",
        })],
      });
    }
    for (const value of [
      null,
      [],
      {},
      { schema_version: "dual-audience-report-contract-v2" },
      { format: "review-document/1" },
    ]) {
      expect(rejectLegacyStaticContract(value)).toEqual({ ok: true, value: true });
    }
    expect(rejectLegacyStaticContract(Object.create({ format: "review-document/1" })).ok)
      .toBe(false);
  });

  it("fails closed without getters, proxy traps, cycles, or secret leakage", () => {
    const sentinel = "consume-facade-hostile-secret-abcdefgh";
    let getterReads = 0;
    const getter = Object.defineProperty({}, "format", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(sentinel);
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [getter, hostileProxy(sentinel), cycle, revoked.proxy]) {
      expect(() => rejectLegacyStaticContract(value)).not.toThrow();
      const result = rejectLegacyStaticContract(value);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(sentinel);
    }
    expect(getterReads).toBe(0);
  });

  it("reconstitutes VAL and protocol errors from fixed tables and ignores caller text", () => {
    const val = createValidationFailureResult({
      kind: "validation-code",
      code: "ARTIFACT_DRIFT",
      path: "/generated/agent",
    });
    expect(val).toEqual({
      ok: false,
      errors: [expect.objectContaining({
        code: "ARTIFACT_DRIFT",
        path: "/generated/agent",
        blockId: null,
        message: "A generated artifact differs from the fixed template or embedded document.",
      })],
    });

    const unknownField = "authorization-bearer-hidden-field";
    const callerError = {
      ...protocolError("SCHEMA_ADDITIONAL_PROPERTIES", `/document/${unknownField}`),
      message: "caller supplied message that must be ignored",
      hint: "caller supplied hint that must be ignored",
    };
    const protocol = createValidationFailureResult({
      kind: "protocol-errors",
      errors: [callerError],
    });
    expect(protocol).toEqual({
      ok: false,
      errors: [expect.objectContaining({
        code: "SCHEMA_ADDITIONAL_PROPERTIES",
        path: "/document",
        message: "The protocol contains an unknown field.",
        hint: "Remove the field or use a supported protocol version.",
      })],
    });
    expect(JSON.stringify(protocol)).not.toContain(unknownField);
    expect(JSON.stringify(protocol)).not.toContain("caller supplied");
  });

  it("turns every malformed or hostile failure request into one safe INTERNAL_ERROR", () => {
    const sentinel = "validation-request-hostile-secret-abcdefgh";
    let getterReads = 0;
    const getter = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(sentinel);
      },
    });
    const cycle: Record<string, unknown> = { kind: "protocol-errors" };
    cycle.errors = [cycle];
    const malformed = [
      null,
      {},
      { kind: "validation-code", code: "NOPE", path: "/x" },
      { kind: "validation-code", code: "CSP_INVALID", path: "not-a-pointer" },
      { kind: "validation-code", code: "CSP_INVALID", path: "/x\0hidden" },
      { kind: "validation-code", code: "CSP_INVALID", path: "/x", extra: true },
      { kind: "protocol-errors", errors: [] },
      { kind: "protocol-errors", errors: [{
        ...protocolError("SCHEMA_TYPE", "/document"),
        message: 123,
      }] },
      { kind: "protocol-errors", errors: [{
        ...protocolError("SCHEMA_TYPE", "/document"),
        hint: null,
      }] },
      { kind: "protocol-errors", errors: [{
        ...protocolError("SCHEMA_TYPE", "/document"),
        code: "NOT_A_PROTOCOL_CODE",
      }] },
      { kind: "protocol-errors", errors: [{
        ...protocolError("SCHEMA_TYPE", "not-a-pointer"),
      }] },
      { kind: "protocol-errors", errors: [{
        ...protocolError("SCHEMA_TYPE", "/document", "not-a-block"),
      }] },
      getter,
      cycle,
      hostileProxy(sentinel),
    ];
    for (const value of malformed) {
      expect(() => createValidationFailureResult(value as never)).not.toThrow();
      const result = createValidationFailureResult(value as never);
      expect(result).toEqual({
        ok: false,
        errors: [expect.objectContaining({ code: "INTERNAL_ERROR", path: "" })],
      });
      expect(JSON.stringify(result)).not.toContain(sentinel);
    }
    expect(getterReads).toBe(0);
  });

  it("maps only exact safe results and uses the highest failure severity", () => {
    expect(exitCodeForValidationResult({ ok: true })).toBe(0);
    expect(exitCodeForValidationResult({ ok: false, errors: [
      {
        code: "ARGUMENT_INVALID",
        path: "/x",
        blockId: null,
        message: "ignored safe text",
        hint: "ignored safe text",
      },
      {
        code: "ARTIFACT_DRIFT",
        path: "/x",
        blockId: null,
        message: "ignored safe text",
        hint: "ignored safe text",
      },
      {
        code: "INTERNAL_ERROR",
        path: "",
        blockId: null,
        message: "ignored safe text",
        hint: "ignored safe text",
      },
    ] })).toBe(70);
    expect(exitCodeForValidationResult(createValidationFailureResult({
      kind: "validation-code",
      code: "ARGUMENT_INVALID",
      path: "/x",
    }))).toBe(2);
    expect(exitCodeForValidationResult(createValidationFailureResult({
      kind: "validation-code",
      code: "CSP_INVALID",
      path: "/x",
    }))).toBe(3);
    expect(exitCodeForValidationResult(createValidationFailureResult({
      kind: "protocol-errors",
      errors: [protocolError("IDENTITY_CONFIRMATION_REQUIRED", "/doc")],
    }))).toBe(4);
    expect(exitCodeForValidationResult(createValidationFailureResult({
      kind: "validation-code",
      code: "ARTIFACT_DRIFT",
      path: "/x",
    }))).toBe(5);

    const sentinel = "validation-exit-hostile-secret-abcdefgh";
    let getterReads = 0;
    const getter = Object.defineProperty({}, "ok", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(sentinel);
      },
    });
    const cycle: Record<string, unknown> = { ok: false };
    cycle.errors = [cycle];
    for (const value of [
      null,
      {},
      { ok: true, value: 1 },
      { ok: false, errors: [] },
      { ok: false, errors: [{}] },
      { ok: false, errors: [{
        code: "NOT_A_VALIDATION_CODE",
        path: "/x",
        blockId: null,
        message: "x",
        hint: "y",
      }] },
      { ok: false, errors: [{
        code: "CSP_INVALID",
        path: "not-a-pointer",
        blockId: null,
        message: "x",
        hint: "y",
      }] },
      { ok: false, errors: [{
        code: "CSP_INVALID",
        path: "/x",
        blockId: "B001",
        message: "x",
        hint: "y",
      }] },
      getter,
      cycle,
      hostileProxy(sentinel),
    ]) {
      expect(() => exitCodeForValidationResult(value as never)).not.toThrow();
      expect(exitCodeForValidationResult(value as never)).toBe(70);
    }
    expect(getterReads).toBe(0);
  });

  it("validates one real generated pair then binds callbacks to copied exact bytes", () => {
    const document = reviewDocumentFixture();
    const templateBytes = approvalTemplateBytes();
    const generated = generateArtifactBytes({
      document,
      approvalTemplateBytes: templateBytes,
    });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const originalAgent = new Uint8Array(generated.value.agent);
    const originalApproval = new Uint8Array(generated.value.approval);
    const result = createExactGeneratedArtifactByteVerifiers({
      document,
      generatorVersion: GENERATOR_VERSION,
      templateBytes,
      agentBytes: generated.value.agent,
      approvalBytes: generated.value.approval,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    document.document.title = "Mutated after preflight";
    templateBytes[0] = (templateBytes[0] ?? 0) ^ 1;
    generated.value.agent[0] = (generated.value.agent[0] ?? 0) ^ 1;
    generated.value.approval[0] = (generated.value.approval[0] ?? 0) ^ 1;
    expect(result.value.agent(originalAgent)).toEqual({ ok: true });
    expect(result.value.approval(originalApproval)).toEqual({ ok: true });
    expect(result.value.agent(generated.value.agent)).toEqual({ ok: false });
    expect(result.value.approval(generated.value.approval)).toEqual({ ok: false });
    expect(result.value.agent(originalApproval)).toEqual({ ok: false });
    expect(result.value.approval(originalAgent)).toEqual({ ok: false });
  });

  it("rejects other valid snapshots, version/template/artifact drift, and hostile callbacks", () => {
    const document = reviewDocumentFixture();
    const templateBytes = approvalTemplateBytes();
    const generated = generateArtifactBytes({ document, approvalTemplateBytes: templateBytes });
    if (!generated.ok) throw new Error("generation fixture failed");
    const other = reviewDocumentFixture();
    other.document.title = "Another valid generated snapshot";
    const otherGenerated = generateArtifactBytes({ document: other, approvalTemplateBytes: templateBytes });
    if (!otherGenerated.ok) throw new Error("other generation fixture failed");
    const base = {
      document,
      generatorVersion: GENERATOR_VERSION,
      templateBytes,
      agentBytes: generated.value.agent,
      approvalBytes: generated.value.approval,
    };
    const damagedTemplate = new TextEncoder().encode(
      new TextDecoder().decode(templateBytes).replace("default-src 'none'", "default-src 'self'"),
    );
    const cases = [
      { ...base, generatorVersion: "0.2.2" },
      { ...base, templateBytes: damagedTemplate },
      { ...base, agentBytes: otherGenerated.value.agent },
      { ...base, approvalBytes: otherGenerated.value.approval },
      { ...base, agentBytes: base.approvalBytes, approvalBytes: base.agentBytes },
    ];
    for (const value of cases) {
      expect(createExactGeneratedArtifactByteVerifiers(value).ok).toBe(false);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const artifactSentinel = "exact-artifact-private-secret-abcdefgh";
    const privateAgent = encoder.encode([
      decoder.decode(base.agentBytes),
      ["Author", "ization: Bearer ", artifactSentinel].join(""),
    ].join("\n"));
    const privateApproval = encoder.encode(decoder.decode(base.approvalBytes).replace(
      "<body>",
      `<body>${["Author", "ization: Bearer ", artifactSentinel].join("")}`,
    ));
    for (const value of [
      { ...base, agentBytes: privateAgent },
      { ...base, approvalBytes: privateApproval },
    ]) {
      const result = createExactGeneratedArtifactByteVerifiers(value);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(artifactSentinel);
    }

    const privateDocument = reviewDocumentFixture();
    const privateSentinel = "exact-private-document-secret-abcdefgh";
    privateDocument.evidence.risks.push(
      ["Author", "ization: Bearer ", privateSentinel].join(""),
    );
    const privateResult = createExactGeneratedArtifactByteVerifiers({
      ...base,
      document: privateDocument,
    });
    expect(privateResult.ok).toBe(false);
    expect(JSON.stringify(privateResult)).not.toContain(privateSentinel);

    const sentinel = "exact-verifier-hostile-secret-abcdefgh";
    let getterReads = 0;
    const getter = Object.defineProperty({}, "document", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error(sentinel);
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.document = cycle;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [getter, cycle, hostileProxy(sentinel), revoked.proxy]) {
      expect(() => createExactGeneratedArtifactByteVerifiers(value as never)).not.toThrow();
      const hostileResult = createExactGeneratedArtifactByteVerifiers(value as never);
      expect(hostileResult.ok).toBe(false);
      expect(JSON.stringify(hostileResult)).not.toContain(sentinel);
    }
    expect(getterReads).toBe(0);

    const hostileInputBytes = new Proxy(new Uint8Array(), {
      get() {
        throw new Error(sentinel);
      },
    });
    expect(createExactGeneratedArtifactByteVerifiers({
      ...base,
      agentBytes: hostileInputBytes as never,
    }).ok).toBe(false);
    const valid = createExactGeneratedArtifactByteVerifiers(base);
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    const fakeAgentBytes = Object.assign({ length: base.agentBytes.length }, base.agentBytes);
    const fakeApprovalBytes = Object.assign({ length: base.approvalBytes.length }, base.approvalBytes);
    for (const bytes of [Array.from(base.agentBytes), fakeAgentBytes]) {
      expect(valid.value.agent(bytes as never)).toEqual({ ok: false });
    }
    for (const bytes of [Array.from(base.approvalBytes), fakeApprovalBytes]) {
      expect(valid.value.approval(bytes as never)).toEqual({ ok: false });
    }
    const hostileBytes = new Proxy(new Uint8Array(), {
      get() {
        throw new Error(sentinel);
      },
    });
    expect(() => valid.value.agent(hostileBytes as never)).not.toThrow();
    expect(valid.value.agent(hostileBytes as never)).toEqual({ ok: false });
    expect(() => valid.value.approval(hostileBytes as never)).not.toThrow();
    expect(valid.value.approval(hostileBytes as never)).toEqual({ ok: false });
  });
});
