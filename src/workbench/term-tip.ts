const TIP_ID = "term-tip";
const EDGE_GAP = 8;
const LEAVE_DELAY_MS = 140;

interface Popoverable {
  popover?: string;
  showPopover?: () => void;
  hidePopover?: () => void;
}

function termAnchor(target: unknown): HTMLElement | null {
  const candidate = target as { closest?: (selector: string) => Element | null } | null;
  if (candidate === null || typeof candidate.closest !== "function") return null;
  const found = candidate.closest("a.term-ref[data-tip]");
  return found === null ? null : (found as HTMLElement);
}

/**
 * A single body-level definition preview shared by every glossary term.
 *
 * The previous implementation was a `::after` pseudo-element on the term, which
 * is laid out inside whatever ancestor establishes a clipping context. Tables,
 * code blocks and the rail all carry `overflow-x:auto`, and CSS computes the
 * other axis to `auto` alongside it, so a term near the top of any of them had
 * its preview cut off. Hanging one fixed-position element off `<body>` removes
 * it from every one of those clipping boxes; `popover` additionally lifts it
 * into the top layer so it also clears the modal dialog.
 *
 * The preview stays supplementary (spec §7.2): the definition's in-file carrier
 * is the glossary appendix that the term already links to.
 */
export function mountTermTip(document: Document): void {
  const body = document.body as (HTMLElement & { addEventListener?: unknown }) | null;
  if (body === null || typeof body.addEventListener !== "function") return;
  if (typeof document.createElement !== "function") return;

  const tip = document.createElement("div");
  if (typeof (tip as { setAttribute?: unknown }).setAttribute !== "function") return;
  tip.className = "term-tip";
  tip.id = TIP_ID;
  tip.setAttribute("role", "tooltip");

  const popoverable = tip as unknown as Popoverable;
  const usePopover = typeof popoverable.showPopover === "function"
    && typeof popoverable.hidePopover === "function";
  if (usePopover) tip.setAttribute("popover", "manual");
  else tip.hidden = true;
  body.append(tip);

  let active: HTMLElement | null = null;
  let overTip = false;
  let leaveTimer: number | undefined;

  function measure(element: Element): DOMRect | null {
    const read = (element as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
    if (typeof read !== "function") return null;
    const rect = read.call(element);
    return rect === null || typeof rect !== "object" ? null : rect;
  }

  function place(anchor: HTMLElement): void {
    const anchorRect = measure(anchor);
    const tipRect = measure(tip);
    const root = document.documentElement as { clientWidth?: number; clientHeight?: number } | null;
    const viewportWidth = root?.clientWidth ?? 0;
    const viewportHeight = root?.clientHeight ?? 0;
    if (anchorRect === null || tipRect === null || viewportWidth === 0 || viewportHeight === 0) {
      return;
    }
    // Prefer below: block-end overflow inside a scroller is reachable, block-start
    // overflow is not. Flip up only when there is genuinely no room underneath.
    let top = anchorRect.bottom + 6;
    if (top + tipRect.height > viewportHeight - EDGE_GAP) {
      const above = anchorRect.top - tipRect.height - 6;
      top = above >= EDGE_GAP ? above : Math.max(EDGE_GAP, viewportHeight - tipRect.height - EDGE_GAP);
    }
    const maxLeft = Math.max(EDGE_GAP, viewportWidth - tipRect.width - EDGE_GAP);
    const left = Math.min(Math.max(EDGE_GAP, anchorRect.left), maxLeft);
    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
  }

  function hide(): void {
    if (leaveTimer !== undefined) {
      window.clearTimeout(leaveTimer);
      leaveTimer = undefined;
    }
    if (active === null) return;
    active.removeAttribute("aria-describedby");
    active = null;
    overTip = false;
    if (usePopover) popoverable.hidePopover?.();
    else tip.hidden = true;
  }

  function show(anchor: HTMLElement): void {
    const text = anchor.getAttribute("data-tip");
    if (text === null || text === "") return;
    if (leaveTimer !== undefined) {
      window.clearTimeout(leaveTimer);
      leaveTimer = undefined;
    }
    if (active !== null && active !== anchor) active.removeAttribute("aria-describedby");
    active = anchor;
    tip.textContent = text;
    // The preview no longer lives inside the block whose wrapper carries the
    // content language, so it states the language itself (WCAG 3.1.2).
    const language = anchor.getAttribute("data-tip-lang");
    if (language !== null && language !== "") tip.lang = language;
    anchor.setAttribute("aria-describedby", TIP_ID);
    if (usePopover) popoverable.showPopover?.();
    else tip.hidden = false;
    place(anchor);
  }

  /** True while the preview's own term still holds keyboard focus. */
  function anchorHasFocus(): boolean {
    return active !== null && document.activeElement === active;
  }

  function scheduleHide(): void {
    if (leaveTimer !== undefined) window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => {
      leaveTimer = undefined;
      // A pointer leaving does not dismiss a preview the keyboard opened:
      // SC 1.4.13 requires it to persist until the user dismisses it.
      if (!overTip && !anchorHasFocus()) hide();
    }, LEAVE_DELAY_MS);
  }

  body.addEventListener("mouseover", (event: Event) => {
    const anchor = termAnchor(event.target);
    if (anchor !== null) show(anchor);
  });
  body.addEventListener("mouseout", (event: Event) => {
    if (termAnchor(event.target) !== null) scheduleHide();
  });
  body.addEventListener("focusin", (event: Event) => {
    const anchor = termAnchor(event.target);
    if (anchor !== null) show(anchor);
    else if (active !== null) hide();
  });
  body.addEventListener("focusout", (event: Event) => {
    if (termAnchor(event.target) !== null) scheduleHide();
  });
  // Keeping the preview hoverable and Escape-dismissible is what WCAG 2.1
  // SC 1.4.13 asks for; the old pointer-events:none pseudo-element met neither.
  body.addEventListener("keydown", (event: Event) => {
    if ((event as KeyboardEvent).key === "Escape" && active !== null) hide();
  });

  if (typeof (tip as { addEventListener?: unknown }).addEventListener === "function") {
    tip.addEventListener("mouseover", () => {
      overTip = true;
      if (leaveTimer !== undefined) {
        window.clearTimeout(leaveTimer);
        leaveTimer = undefined;
      }
    });
    tip.addEventListener("mouseout", () => {
      overTip = false;
      scheduleHide();
    });
  }

  // A moved anchor makes a stale position worse than no preview at all, so the
  // preview follows it and only disappears once the term leaves the viewport.
  // Hiding on every scroll instead would race the smooth anchor scrolling the
  // page uses, closing a preview the reader just opened.
  function follow(): void {
    if (active === null) return;
    const rect = measure(active);
    const root = document.documentElement as { clientWidth?: number; clientHeight?: number } | null;
    const viewportWidth = root?.clientWidth ?? 0;
    const viewportHeight = root?.clientHeight ?? 0;
    const offscreen = rect === null
      || viewportWidth === 0
      || viewportHeight === 0
      // A term scrolled out of a table sideways is not painted at all; a
      // degenerate rect means the same thing.
      || (rect.width === 0 && rect.height === 0)
      || rect.bottom < 0
      || rect.top > viewportHeight
      || rect.right < 0
      || rect.left > viewportWidth;
    if (offscreen) {
      hide();
      return;
    }
    place(active);
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
  }
}
