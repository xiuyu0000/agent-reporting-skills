import type { InlineNode } from "../protocol/index.js";
import type { WorkbenchStrings } from "./i18n.js";

type LinkNode = Extract<InlineNode, { type: "link" }>;

export class UnsafeLinkError extends Error {
  readonly code = "UNSAFE_LINK";

  constructor() {
    super("UNSAFE_LINK");
    this.name = "UnsafeLinkError";
  }
}

function validatedHref(href: string): { href: string; external: boolean } {
  if (href.startsWith("#")) {
    if (!/^#[A-Za-z][A-Za-z0-9_.:-]*$/u.test(href)) throw new UnsafeLinkError();
    return { href, external: false };
  }

  if (href.startsWith("//")) throw new UnsafeLinkError();
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    throw new UnsafeLinkError();
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    || parsed.username !== ""
    || parsed.password !== ""
  ) {
    throw new UnsafeLinkError();
  }
  return { href: parsed.href, external: true };
}

export function renderLink(
  ownerDocument: Document,
  node: LinkNode,
  strings: WorkbenchStrings,
  uiLocale: string,
): HTMLAnchorElement {
  const safe = validatedHref(node.href);
  const anchor = ownerDocument.createElement("a");
  anchor.href = safe.href;
  anchor.textContent = node.text;
  if (safe.external) {
    anchor.rel = "noopener noreferrer";
    const marker = ownerDocument.createElement("span");
    marker.className = "link-kind";
    marker.lang = uiLocale;
    marker.textContent = ` (${strings.extensionReading})`;
    anchor.append(marker);
  } else {
    anchor.setAttribute("data-internal-ref", "true");
  }
  return anchor;
}
