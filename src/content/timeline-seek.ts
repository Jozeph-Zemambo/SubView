// Some players only load a new position when the seek comes through their own
// timeline: set <video>.currentTime to a spot they haven't loaded and the
// element waits forever for data the player never fetches. When the page has a
// standard timeline (a range input as long as the video), seek through that,
// the way a keyboard or pointer user would.

/** True when the position is already loaded, or the video doesn't say what is. */
export function isBuffered(video: HTMLVideoElement, seconds: number): boolean {
  const ranges = video.buffered;
  if (!ranges || !ranges.length) return true; // Nothing loaded yet: the player picks its own start.
  for (let index = 0; index < ranges.length; index += 1) {
    if (seconds >= ranges.start(index) && seconds <= ranges.end(index)) return true;
  }
  return false;
}

/** How far a timeline's length may differ from the video's (rounded labels, trimmed tails). */
const LENGTH_TOLERANCE_S = 1.5;

/** The page's one range input that spans this video's length, if it has one. */
export function pageTimeline(video: HTMLVideoElement): HTMLInputElement | null {
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0 || typeof video.getRootNode !== "function") return null;
  const roots = new Set<ParentNode>([video.getRootNode() as ParentNode, video.ownerDocument]);
  const found = new Set<HTMLInputElement>();
  for (const root of roots) {
    if (typeof root?.querySelectorAll !== "function") continue;
    for (const input of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="range"]'))) {
      const max = Number(input.max);
      if (!input.disabled && Number(input.min || 0) === 0 && Number.isFinite(max) && Math.abs(max - duration) <= LENGTH_TOLERANCE_S) found.add(input);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/** Move the timeline to a position with the events a pointer drag produces. */
export function seekThroughTimeline(timeline: HTMLInputElement, seconds: number): void {
  const view = timeline.ownerDocument.defaultView;
  if (!view) return;
  const init = { bubbles: true, cancelable: true, composed: true, button: 0 };
  const pointer = { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true };
  timeline.dispatchEvent(new view.FocusEvent("focus", init));
  timeline.dispatchEvent(new view.PointerEvent("pointerdown", pointer));
  timeline.dispatchEvent(new view.MouseEvent("mousedown", init));
  // Frameworks track the value themselves; only the native setter reaches them.
  const set = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")?.set;
  if (set) set.call(timeline, String(seconds)); else timeline.value = String(seconds);
  timeline.dispatchEvent(new view.Event("input", init));
  timeline.dispatchEvent(new view.Event("change", init));
  timeline.dispatchEvent(new view.PointerEvent("pointerup", pointer));
  timeline.dispatchEvent(new view.MouseEvent("mouseup", init));
  timeline.dispatchEvent(new view.MouseEvent("click", init));
}
