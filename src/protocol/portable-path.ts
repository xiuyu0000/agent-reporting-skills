import { caseFold } from "unicode-case-folding";
import { failure, protocolError, success, type ProtocolResult } from "./errors.js";

declare const portablePathKeyBrand: unique symbol;

export type PortablePathKey = string & {
  readonly [portablePathKeyBrand]: "PortablePathKey";
};

const INVALID_PATH = /\0|\\/;
const DRIVE_PREFIX = /^[A-Za-z]:/;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function portablePathKey(relativePath: string): ProtocolResult<PortablePathKey> {
  if (typeof relativePath !== "string") {
    return failure([protocolError("PORTABLE_PATH_INVALID", "/relativePath")]);
  }
  const segments = relativePath.split("/");
  const invalid =
    relativePath.length === 0
    || hasUnpairedSurrogate(relativePath)
    || relativePath.startsWith("/")
    || INVALID_PATH.test(relativePath)
    || DRIVE_PREFIX.test(relativePath)
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..");

  if (invalid) {
    return failure([protocolError("PORTABLE_PATH_INVALID", "/relativePath")]);
  }

  const key = segments
    .map((segment) => caseFold(segment.normalize("NFC")).normalize("NFC"))
    .join("/");
  return success(key as PortablePathKey);
}
