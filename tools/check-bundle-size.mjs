import { expectedWorkbenchArtifacts, WORKBENCH_SIZE_LIMIT_BYTES } from "./build-workbench.mjs";

const artifacts = await expectedWorkbenchArtifacts();
console.log(`workbench shell ${artifacts.size}/${WORKBENCH_SIZE_LIMIT_BYTES} UTF-8 bytes`);
