import type { Sha256Digest } from "../../protocol/index.js";
import type { CliIoError } from "../io/index.js";
import type { DeliveryHandoff, ValidationError } from "../validate.js";

export interface ConsumeContractHandoff {
  relativePath: string;
  byteDigest: Sha256Digest;
}

export interface ConsumeDeliveryHandoff {
  contract: ConsumeContractHandoff;
  delivery: DeliveryHandoff;
}

export interface ConsumeApplyHandoff {
  kind: "consume";
  packetId: string;
  semanticDigest: Sha256Digest;
  candidate: ConsumeDeliveryHandoff;
  derived: Array<{
    topicId: string;
    contract: ConsumeContractHandoff;
    delivery: DeliveryHandoff;
  }>;
}

export interface ConsumeNoopSuccess {
  status: "ok";
  phase: "consume";
  mode: "noop";
  mutated: false;
  summary: {
    packetId: string;
    semanticDigest: Sha256Digest;
  };
}

export interface ConsumeApplySuccess {
  status: "ok";
  phase: "consume";
  mode: "apply";
  mutated: true;
  handoff: ConsumeApplyHandoff;
}

export interface ConsumeFailure {
  status: "failed";
  phase: "consume";
  mutated: boolean;
  recoveryRequired: boolean;
  errors: readonly (ValidationError | CliIoError)[];
}

export type ConsumeCommandResult = ConsumeNoopSuccess | ConsumeApplySuccess | ConsumeFailure;

export interface ConsumeCommandOutcome {
  exitCode: number;
  result: ConsumeCommandResult;
}

export interface ConsumeRuntimeOptions {
  loadApprovalTemplateBytes?: () => Uint8Array | Promise<Uint8Array>;
}
