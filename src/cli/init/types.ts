import type { Sha256Digest } from "../../protocol/index.js";
import type { CliIoError } from "../result.js";
import type { ValidationError } from "../validate.js";

export interface InitSuccess {
  status: "ok";
  phase: "init";
  mutated: true;
  contract: { relativePath: string; byteDigest: Sha256Digest };
  document: {
    format: "review-document/1";
    deliveryId: string;
    documentId: string;
    contentVersion: 1;
    round: 1;
    status: "draft";
  };
}

export interface InitFailure {
  status: "failed";
  phase: "init";
  mutated: boolean;
  recoveryRequired: boolean;
  errors: readonly (ValidationError | CliIoError)[];
}

export type InitCommandResult = InitSuccess | InitFailure;

export interface InitCommandOutcome {
  exitCode: number;
  result: InitCommandResult;
}

export interface InitRuntimeOptions {
  randomBytes?: (size: number) => Uint8Array;
}
