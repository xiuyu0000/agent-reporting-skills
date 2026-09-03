import type { BatchHandoff, DeliveryHandoff, DeliveryWarning, ValidationError } from "../validate.js";
import type { CliIoError } from "../result.js";

export interface RenderSuccess {
  status: "ok";
  phase: "render";
  mode: "delivery" | "batch";
  mutated: true;
  handoff: DeliveryHandoff | BatchHandoff;
  warnings?: readonly DeliveryWarning[];
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
