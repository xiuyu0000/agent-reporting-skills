export const REQUIRED_NODE_MAJOR = 24;

export function assertSupportedNode(version = process.versions.node): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (major !== REQUIRED_NODE_MAJOR) {
    throw new Error(`Node ${REQUIRED_NODE_MAJOR}.x is required; received ${version}`);
  }
}
