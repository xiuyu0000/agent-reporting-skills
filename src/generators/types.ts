import type { ValidationError } from "../cli/validate.js";

export const GENERATOR_VERSION = "0.2.0" as const;

export type GeneratorResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: readonly ValidationError[] };

export interface GeneratedArtifactBytes {
  readonly agent: Uint8Array;
  readonly approval: Uint8Array;
}

export interface GeneratedArtifactText {
  readonly agent: string;
  readonly approval: string;
}
