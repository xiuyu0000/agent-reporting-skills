import type { BatchHandoff, DeliveryHandoff, ValidationError } from "../validate.js";
import type { CliIoError } from "../result.js";

export interface RenderSuccess {
  status: "ok";
  phase: "render";
  mode: "delivery" | "batch";
  mutated: true;
  handoff: DeliveryHandoff | BatchHandoff;
}

export interface RenderFailure {
  status: "failed";
  phase: "render";
  mutated: boolean;
  recoveryRequired: boolean;
  errors: readonly (ValidationError | CliIoError)[];
}

export type RenderCommandResult = RenderSuccess | RenderFailure;

export interface RenderCommandOutcome {
  exitCode: number;
  result: RenderCommandResult;
}

export interface RenderRuntimeOptions {
  approvalTemplateBytes?: Uint8Array;
}
