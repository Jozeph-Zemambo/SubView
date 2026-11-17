// Many sites put the language in the page address (?lang=sub, &type=dub,
// /watch/x/1/sub). There the Dub page is the same address with the word swapped.

import type { AvailableLanguage } from "./language-detection";

const WORD = /^(sub|subbed|dub|dubbed)$/i;
/** Parameter names that mean "language"; anything else (campaign=dub…) is ignored. */
const NAME = /^(?:lang|language|type|mode|audio|version|track|kind|variant|translation|category|dub|sub)$/i;

interface Slot { kind: "param" | "path"; key: string | number; value: string }

function slots(url: URL): Slot[] {
  const found: Slot[] = [];
  for (const [key, value] of url.searchParams) {
    // A repeated name is ambiguous, and swapping it would drop the other values.
    if (WORD.test(value) && NAME.test(key) && url.searchParams.getAll(key).length === 1) found.push({ kind: "param", key, value });
  }
  url.pathname.split("/").forEach((segment, index) => {
    if (WORD.test(segment)) found.push({ kind: "path", key: index, value: segment });
  });
  return found;
}

function parse(href: string): URL | null {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The language a page address names, when exactly one part of it does. */
export function languageFromUrl(href: string): AvailableLanguage | null {
  const url = parse(href);
  const found = url ? slots(url) : [];
  return found.length === 1 ? (/dub/i.test(found[0].value) ? "dub" : "sub") : null;
}

function swap(word: string): string {
  const next = word.replace(/sub/i, "dub");
  return word === word.toUpperCase() ? next.toUpperCase() : next;
}

/** The Dub page's address for a Sub page whose address names the language. */
export function dubUrlFor(href: string): string | null {
  const url = parse(href);
  if (!url || languageFromUrl(href) !== "sub") return null;
  const [slot] = slots(url);
  if (slot.kind === "param") {
    url.searchParams.set(slot.key as string, swap(slot.value));
  } else {
    const segments = url.pathname.split("/");
    segments[slot.key as number] = swap(slot.value);
    url.pathname = segments.join("/");
  }
  return url.toString();
}
