import { afterEach, describe, expect, it } from "vitest";
import { mountTermTip } from "../../src/workbench/term-tip.js";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectOf(box: Box): DOMRect {
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    top: box.y,
    left: box.x,
    right: box.x + box.width,
    bottom: box.y + box.height,
    toJSON: () => box,
  } as DOMRect;
}

class StubElement {
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly children: StubElement[] = [];
  readonly style: Record<string, string> = {};
  className = "";
  id = "";
  lang = "";
  hidden = false;
  textContent = "";
  box: Box = { x: 0, y: 0, width: 260, height: 80 };
  /** Set on term anchors so `closest` can resolve them. */
  self: StubElement | null = null;
  popoverOpen = false;

  constructor(readonly withPopover = false) {
    if (withPopover) {
      (this as unknown as { showPopover: () => void }).showPopover = () => {
        this.popoverOpen = true;
      };
      (this as unknown as { hidePopover: () => void }).hidePopover = () => {
        this.popoverOpen = false;
      };
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  append(...nodes: StubElement[]): void {
    this.children.push(...nodes);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const bucket = this.listeners.get(type);
    if (bucket) bucket.push(handler);
    else this.listeners.set(type, [handler]);
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  /** Set on the shared preview: a closed popover has no box, exactly like a real one. */
  zeroWhenClosed = false;

  getBoundingClientRect(): DOMRect {
    if (this.zeroWhenClosed && !this.popoverOpen && !this.shownByHidden) {
      return rectOf({ x: 0, y: 0, width: 0, height: 0 });
    }
    return rectOf(this.box);
  }

  get shownByHidden(): boolean {
    return this.withPopover ? false : !this.hidden;
  }

  closest(selector: string): StubElement | null {
    return selector === "a.term-ref[data-tip]" ? this.self : null;
  }

  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
}

interface Harness {
  document: Document;
  body: StubElement;
  created: StubElement[];
  timers: Map<number, () => void>;
  windowListeners: Map<string, ((event: unknown) => void)[]>;
  runTimers: () => void;
  restore: () => void;
}

function harness(options: {
  withPopover?: boolean;
  viewport?: { width: number; height: number };
  bodyListeners?: boolean;
  createElement?: boolean;
} = {}): Harness {
  const created: StubElement[] = [];
  const timers = new Map<number, () => void>();
  const windowListeners = new Map<string, ((event: unknown) => void)[]>();
  let nextTimer = 1;
  const body = new StubElement();
  if (options.bodyListeners === false) {
    (body as unknown as { addEventListener: undefined }).addEventListener = undefined;
  }
  const viewport = options.viewport ?? { width: 1000, height: 800 };
  const documentStub = {
    body,
    activeElement: null as StubElement | null,
    documentElement: { clientWidth: viewport.width, clientHeight: viewport.height },
    createElement: options.createElement === false
      ? undefined
      : (): StubElement => {
        const element = new StubElement(options.withPopover ?? true);
        created.push(element);
        return element;
      },
  } as unknown as Document;

  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    setTimeout: (handler: () => void): number => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, handler);
      return id;
    },
    clearTimeout: (id: number): void => {
      timers.delete(id);
    },
    addEventListener: (type: string, handler: (event: unknown) => void): void => {
      const bucket = windowListeners.get(type);
      if (bucket) bucket.push(handler);
      else windowListeners.set(type, [handler]);
    },
  };

  return {
    document: documentStub,
    body,
    created,
    timers,
    windowListeners,
    runTimers: () => {
      for (const [id, handler] of [...timers]) {
        timers.delete(id);
        handler();
      }
    },
    restore: () => {
      (globalThis as { window?: unknown }).window = previousWindow;
    },
  };
}

function anchor(definition: string, box: Box): StubElement {
  const element = new StubElement();
  element.self = element;
  element.setAttribute("data-tip", definition);
  element.box = box;
  return element;
}

/** A term plus its label span: the two nodes a resting pointer flips between. */
function anchorWithLabel(definition: string, box: Box): { term: StubElement; label: StubElement } {
  const term = anchor(definition, box);
  const label = new StubElement();
  label.self = term;
  term.append(label);
  return { term, label };
}

let active: Harness | undefined;

afterEach(() => {
  active?.restore();
  active = undefined;
});

function mount(options: Parameters<typeof harness>[0] = {}): Harness & { tip: StubElement } {
  const environment = harness(options);
  active = environment;
  mountTermTip(environment.document);
  const tip = environment.created[0];
  if (tip === undefined) throw new Error("tip was not created");
  return { ...environment, tip };
}

describe("term definition preview", () => {
  it("mounts one body-level preview and keeps it out of the flow", () => {
    const { tip, body } = mount();
    expect(tip.id).toBe("term-tip");
    expect(tip.className).toBe("term-tip");
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.getAttribute("popover")).toBe("manual");
    expect(body.children).toContain(tip);
  });

  it("shows the definition below the term and binds it for assistive technology", () => {
    const { tip, body } = mount();
    const term = anchor("Every downstream dependency.", { x: 120, y: 200, width: 90, height: 20 });
    tip.box = { x: 0, y: 0, width: 260, height: 80 };

    body.emit("mouseover", { target: term });

    expect(tip.textContent).toBe("Every downstream dependency.");
    expect(tip.popoverOpen).toBe(true);
    expect(term.getAttribute("aria-describedby")).toBe("term-tip");
    // Below the term: block-end overflow inside a scroller is reachable.
    expect(tip.style.top).toBe("226px");
    expect(tip.style.left).toBe("120px");
  });

  it("flips above the term when there is no room underneath", () => {
    const { tip, body } = mount({ viewport: { width: 1000, height: 300 } });
    const term = anchor("Definition.", { x: 40, y: 240, width: 90, height: 20 });
    tip.box = { x: 0, y: 0, width: 200, height: 90 };

    body.emit("mouseover", { target: term });

    expect(tip.style.top).toBe("144px");
  });

  it("clamps a wide preview inside the viewport instead of overflowing it", () => {
    const { tip, body } = mount({ viewport: { width: 360, height: 800 } });
    const term = anchor("Definition.", { x: 300, y: 100, width: 50, height: 20 });
    tip.box = { x: 0, y: 0, width: 300, height: 60 };

    body.emit("mouseover", { target: term });

    // 360 - 300 - 8 = 52 is the furthest right edge that still fits.
    expect(tip.style.left).toBe("52px");
  });

  it("hides only after the pointer has left both the term and the preview", () => {
    const { tip, body, runTimers } = mount();
    const term = anchor("Definition.", { x: 10, y: 10, width: 40, height: 20 });
    body.emit("mouseover", { target: term });

    body.emit("mouseout", { target: term });
    tip.emit("mouseover", {});
    runTimers();
    expect(tip.popoverOpen).toBe(true);

    tip.emit("mouseout", {});
    runTimers();
    expect(tip.popoverOpen).toBe(false);
    expect(term.getAttribute("aria-describedby")).toBeNull();
  });

  it("closes on Escape and ignores other keys", () => {
    const { tip, body } = mount();
    const term = anchor("Definition.", { x: 10, y: 10, width: 40, height: 20 });
    body.emit("mouseover", { target: term });

    body.emit("keydown", { key: "j" });
    expect(tip.popoverOpen).toBe(true);

    body.emit("keydown", { key: "Escape" });
    expect(tip.popoverOpen).toBe(false);
    // A second Escape with nothing open must stay a no-op.
    body.emit("keydown", { key: "Escape" });
    expect(tip.popoverOpen).toBe(false);
  });

  it("follows the term while it scrolls and hides once it leaves the viewport", () => {
    const { tip, body, windowListeners } = mount({ viewport: { width: 1000, height: 500 } });
    const term = anchor("Definition.", { x: 10, y: 300, width: 40, height: 20 });
    tip.box = { x: 0, y: 0, width: 200, height: 60 };
    body.emit("mouseover", { target: term });
    expect(tip.style.top).toBe("326px");

    const scroll = windowListeners.get("scroll") ?? [];
    term.box = { x: 10, y: 100, width: 40, height: 20 };
    for (const handler of scroll) handler({});
    // Repositioned rather than dismissed: hiding here would race the page's
    // smooth anchor scrolling.
    expect(tip.popoverOpen).toBe(true);
    expect(tip.style.top).toBe("126px");

    term.box = { x: 10, y: 900, width: 40, height: 20 };
    for (const handler of scroll) handler({});
    expect(tip.popoverOpen).toBe(false);
  });

  it("moves the binding when the reader focuses a second term", () => {
    const { tip, body } = mount();
    const first = anchor("First.", { x: 10, y: 10, width: 40, height: 20 });
    const second = anchor("Second.", { x: 10, y: 60, width: 40, height: 20 });

    body.emit("focusin", { target: first });
    body.emit("focusin", { target: second });

    expect(first.getAttribute("aria-describedby")).toBeNull();
    expect(second.getAttribute("aria-describedby")).toBe("term-tip");
    expect(tip.textContent).toBe("Second.");
  });

  it("dismisses when focus moves to something that is not a term", () => {
    const { tip, body } = mount();
    const term = anchor("Definition.", { x: 10, y: 10, width: 40, height: 20 });
    body.emit("focusin", { target: term });
    expect(tip.popoverOpen).toBe(true);

    body.emit("focusin", { target: new StubElement() });
    expect(tip.popoverOpen).toBe(false);
  });

  it("ignores a term with no definition and a target that cannot be resolved", () => {
    const { tip, body } = mount();
    const empty = anchor("", { x: 0, y: 0, width: 10, height: 10 });
    empty.setAttribute("data-tip", "");

    body.emit("mouseover", { target: empty });
    body.emit("mouseover", { target: null });
    body.emit("mouseover", { target: {} });
    body.emit("mouseout", { target: {} });

    expect(tip.popoverOpen).toBe(false);
    expect(tip.textContent).toBe("");
  });

  it("falls back to the hidden attribute where the popover API is absent", () => {
    const { tip, body } = mount({ withPopover: false });
    expect(tip.getAttribute("popover")).toBeNull();
    expect(tip.hidden).toBe(true);

    const term = anchor("Definition.", { x: 10, y: 10, width: 40, height: 20 });
    body.emit("mouseover", { target: term });
    expect(tip.hidden).toBe(false);

    body.emit("keydown", { key: "Escape" });
    expect(tip.hidden).toBe(true);
  });

  it("leaves the position untouched when the host cannot measure", () => {
    const { tip, body } = mount();
    const term = anchor("Definition.", { x: 10, y: 10, width: 40, height: 20 });
    (term as unknown as { getBoundingClientRect: undefined }).getBoundingClientRect = undefined;

    body.emit("mouseover", { target: term });

    expect(tip.popoverOpen).toBe(true);
    expect(tip.style.top).toBeUndefined();
  });

  it("measures the preview only after it is shown, so the flip and clamp are real", () => {
    // A `[popover=manual]` element is display:none until `showPopover()`, so a
    // place-then-show ordering computes the flip and the clamp against a 0x0
    // box in every real engine.
    const { tip, body } = mount({ viewport: { width: 1000, height: 300 } });
    tip.zeroWhenClosed = true;
    tip.box = { x: 0, y: 0, width: 200, height: 90 };
    const term = anchor("Definition.", { x: 40, y: 240, width: 90, height: 20 });

    body.emit("mouseover", { target: term });

    // 240 + 20 + 6 = 266; 266 + 90 > 300 - 8, so it must have flipped up.
    expect(tip.style.top).toBe("144px");
  });

  it("keeps a keyboard-opened preview while the term still holds focus", () => {
    const { tip, body, document: doc, runTimers } = mount();
    const term = anchor("Definition.", { x: 10, y: 10, width: 40, height: 20 });
    body.emit("focusin", { target: term });
    (doc as unknown as { activeElement: StubElement }).activeElement = term;

    // The pointer brushes the term and leaves; the keyboard user never dismissed it.
    body.emit("mouseover", { target: term });
    body.emit("mouseout", { target: term });
    runTimers();
    expect(tip.popoverOpen).toBe(true);
    expect(term.getAttribute("aria-describedby")).toBe("term-tip");

    // Escape still dismisses it.
    body.emit("keydown", { key: "Escape" });
    expect(tip.popoverOpen).toBe(false);
  });

  it("dismisses when the term scrolls out of its container sideways", () => {
    const { tip, body, windowListeners } = mount({ viewport: { width: 520, height: 800 } });
    const term = anchor("Definition.", { x: 100, y: 100, width: 60, height: 20 });
    body.emit("mouseover", { target: term });
    expect(tip.popoverOpen).toBe(true);

    const scroll = windowListeners.get("scroll") ?? [];
    // Scrolled out of a horizontally scrolling table: the term is no longer painted.
    term.box = { x: -86, y: 100, width: 60, height: 20 };
    for (const handler of scroll) handler({});
    expect(tip.popoverOpen).toBe(false);
  });

  it("dismisses when the term collapses to a zero box", () => {
    const { tip, body, windowListeners } = mount();
    const term = anchor("Definition.", { x: 10, y: 10, width: 40, height: 20 });
    body.emit("mouseover", { target: term });
    term.box = { x: 0, y: 0, width: 0, height: 0 };
    for (const handler of windowListeners.get("scroll") ?? []) handler({});
    expect(tip.popoverOpen).toBe(false);
  });

  it("states the content language so the definition is not announced in the UI locale", () => {
    const { tip, body } = mount();
    const term = anchor("Every downstream dependency.", { x: 10, y: 10, width: 40, height: 20 });
    term.setAttribute("data-tip-lang", "en");
    body.emit("mouseover", { target: term });
    expect((tip as unknown as { lang?: string }).lang).toBe("en");
  });

  it("dismisses on focusout once focus has genuinely left the term", () => {
    const { tip, body, runTimers } = mount();
    const term = anchor("Definition.", { x: 10, y: 10, width: 40, height: 20 });
    body.emit("focusin", { target: term });
    expect(tip.popoverOpen).toBe(true);

    body.emit("focusout", { target: term });
    runTimers();
    expect(tip.popoverOpen).toBe(false);
    expect(term.getAttribute("aria-describedby")).toBeNull();
  });

  it("keeps an Escape-dismissed preview closed while the pointer only shifts between the term's own nodes", () => {
    const { tip, body, runTimers } = mount();
    const { term, label } = anchorWithLabel("Definition.", { x: 10, y: 10, width: 40, height: 20 });
    body.emit("mouseover", { target: term });
    body.emit("keydown", { key: "Escape" });
    expect(tip.popoverOpen).toBe(false);

    // A scroll or reflow under the resting pointer: the browser synthesizes a
    // mouseout to the label span and a mouseover on it, with no pointer motion.
    body.emit("mouseout", { target: term, relatedTarget: label });
    body.emit("mouseover", { target: label });
    runTimers();
    expect(tip.popoverOpen).toBe(false);
    expect(term.getAttribute("aria-describedby")).toBeNull();

    // And back again onto the anchor's own box.
    body.emit("mouseout", { target: label, relatedTarget: term });
    body.emit("mouseover", { target: term });
    runTimers();
    expect(tip.popoverOpen).toBe(false);

    // Leaving the term ends the dismissal; re-entering previews it again.
    body.emit("mouseout", { target: term, relatedTarget: new StubElement() });
    runTimers();
    body.emit("mouseover", { target: term });
    expect(tip.popoverOpen).toBe(true);
    expect(term.getAttribute("aria-describedby")).toBe("term-tip");
  });

  it("treats a pointer leaving the window as leaving the dismissed term", () => {
    const { tip, body, runTimers } = mount();
    const term = anchor("Definition.", { x: 10, y: 10, width: 40, height: 20 });
    body.emit("mouseover", { target: term });
    body.emit("keydown", { key: "Escape" });
    body.emit("mouseout", { target: term, relatedTarget: null });
    runTimers();
    body.emit("mouseover", { target: term });
    expect(tip.popoverOpen).toBe(true);
  });

  it("lets another term preview while the first stays dismissed", () => {
    const { tip, body } = mount();
    const first = anchor("First.", { x: 10, y: 10, width: 40, height: 20 });
    const second = anchor("Second.", { x: 10, y: 60, width: 40, height: 20 });
    body.emit("mouseover", { target: first });
    body.emit("keydown", { key: "Escape" });

    body.emit("mouseover", { target: second });
    expect(tip.popoverOpen).toBe(true);
    expect(tip.textContent).toBe("Second.");
    expect(second.getAttribute("aria-describedby")).toBe("term-tip");
    // Previewing the second term also ends the first term's dismissal.
    body.emit("mouseover", { target: first });
    expect(tip.textContent).toBe("First.");
  });

  it("reopens a dismissed term for keyboard focus, which is explicit intent", () => {
    const { tip, body } = mount();
    const term = anchor("Definition.", { x: 10, y: 10, width: 40, height: 20 });
    body.emit("mouseover", { target: term });
    body.emit("keydown", { key: "Escape" });
    expect(tip.popoverOpen).toBe(false);

    body.emit("focusin", { target: term });
    expect(tip.popoverOpen).toBe(true);
    expect(term.getAttribute("aria-describedby")).toBe("term-tip");
  });

  it("does nothing at all when the host provides no body or no element factory", () => {
    const withoutBody = harness({ bodyListeners: false });
    active = withoutBody;
    expect(() => mountTermTip(withoutBody.document)).not.toThrow();
    expect(withoutBody.created).toHaveLength(0);
    withoutBody.restore();

    const withoutFactory = harness({ createElement: false });
    active = withoutFactory;
    expect(() => mountTermTip(withoutFactory.document)).not.toThrow();
    expect(withoutFactory.created).toHaveLength(0);
  });
});
