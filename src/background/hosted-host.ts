import { HOSTED_PORT, type HostedAgentMessage, type HostedRequest } from "../shared/hosted";
import { isRecord } from "../shared/messages";
import type { ContentEventMessage, HostContainer } from "../shared/types";
import { closeOffscreenPlayer, createOffscreenPlayer, hasOffscreenPlayer, offscreenRequest } from "./offscreen-host";

/** Endpoint tab id for a video inside the hosted page; frames are addressed by documentId. */
export const HOSTED_TAB_ID = -2;
export const HOST_PAGE = "host.html";

const CONTAINER_KEY = "hostedContainer";
const REFERER_RULE_ID = 9101;
const FRAME_HEADERS_RULE_ID = 9102;
const EMBED_HEADERS_RULE_ID = 9103;
const WORKER_FETCH_RULE_ID = 9104;
const SETTINGS_GUARD_RULE_ID = 9105;
const RULE_IDS = [REFERER_RULE_ID, FRAME_HEADERS_RULE_ID, EMBED_HEADERS_RULE_ID, WORKER_FETCH_RULE_ID, SETTINGS_GUARD_RULE_ID];
const SCRIPT_IDS = ["subview-hosted-shim", "subview-hosted-agent"];
const TRAIL_SCRIPT_ID = "subview-hosted-trail";
/** chrome.storage.local flag: record a debug trail inside hosted pages (see hosted/hosted-trail.ts). */
export const HOSTED_DEBUG_KEY = "hostedDebug";
const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_GRACE_MS = 3_000;

interface ContainerRecord {
  kind: HostContainer;
  pageUrl: string;
  tabId?: number;
  windowId?: number;
}

export interface HostedFrame {
  key: string;
  href: string;
  /** 1 for the hosted page itself; deeper for its embedded frames. */
  depth: number;
  connectedAt: number;
}

interface FrameEntry extends HostedFrame {
  port: chrome.runtime.Port;
}

let container: ContainerRecord | null = null;
const frames = new Map<string, FrameEntry>();
const pending = new Map<number, { key: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
const changeListeners = new Set<() => void>();
const eventListeners = new Set<(message: ContentEventMessage, sender: chrome.runtime.MessageSender) => void>();
const lostListeners = new Set<(reason: string) => void>();
let requestSequence = 0;
// Opens and closes run one at a time. A lookup that was cancelled mid-open
// finishes its open before the next one starts, and the next open replaces it,
// so a stale open can never overwrite a newer container.
let hostOperations: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = hostOperations.then(operation, operation);
  hostOperations = result.catch(() => undefined);
  return result;
}
/** Recent refused connections, for diagnostics. */
export const refusedConnections: Array<{ url?: string; tab?: number; container: string | null }> = [];

const restored = chrome.storage.session.get(CONTAINER_KEY).then(async stored => {
  const value = (stored as Record<string, unknown>)[CONTAINER_KEY];
  if (!isRecord(value) || (value.kind !== "offscreen" && value.kind !== "window") || typeof value.pageUrl !== "string") return;
  const record: ContainerRecord = {
    kind: value.kind,
    pageUrl: value.pageUrl,
    ...(Number.isInteger(value.tabId) ? { tabId: value.tabId as number } : {}),
    ...(Number.isInteger(value.windowId) ? { windowId: value.windowId as number } : {}),
  };
  const alive = record.kind === "offscreen"
    ? await hasOffscreenPlayer()
    : record.tabId !== undefined && await chrome.tabs.get(record.tabId).then(() => true, () => false);
  if (alive) container = record;
  else await clearSessionArtifacts();
}).catch(() => undefined);

function persist(): Promise<void> {
  return chrome.storage.session.set({ [CONTAINER_KEY]: container }).catch(() => undefined);
}

function notifyChange(): void {
  for (const listener of changeListeners) listener();
}

/** True when a runtime sender is a frame inside the current hosted container. */
export function isHostedSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !container) return false;
  // about:blank / srcdoc / blob frames inherit their creator's web origin.
  const webFrame = /^https?:/.test(sender.url ?? "") ||
    (/^(?:about|blob):/.test(sender.url ?? "") && /^https?:/.test(sender.origin ?? ""));
  if (!webFrame) return false;
  return container.kind === "offscreen" ? sender.tab === undefined : sender.tab?.id === container.tabId;
}

function refuse(port: chrome.runtime.Port): void {
  refusedConnections.push({ url: port.sender?.url?.slice(0, 80), tab: port.sender?.tab?.id, container: container?.kind ?? null });
  if (refusedConnections.length > 20) refusedConnections.shift();
  port.disconnect();
}

// Frames inside an offscreen document have no documentId, so each agent names
// its frame with a random key in its hello. Listeners attach synchronously: a
// message that arrives before a listener exists is dropped by Chrome.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== HOSTED_PORT) return;
  let accepted = false;
  let key: string | null = null;
  const early: HostedAgentMessage[] = [];

  const handle = (message: HostedAgentMessage) => {
    if (!isRecord(message) || !port.sender) return;
    if (message.type === "hello") {
      if (key || typeof message.frame !== "string" || !/^[\w-]{8,64}$/.test(message.frame) ||
          typeof message.href !== "string" || typeof message.depth !== "number") return;
      key = message.frame;
      frames.get(key)?.port.disconnect();
      frames.set(key, { key, href: message.href, depth: message.depth, connectedAt: Date.now(), port });
      const depth = message.depth;
      void serialized(async () => {
        if (!container) return;
        await allowFramesFrom(message.href);
        // The episode page has loaded: the service-worker exception isn't needed any more.
        if (depth === 1) await retireWorkerRule();
      }).catch(() => undefined);
      notifyChange();
      return;
    }
    if (!key) return;
    if (message.type === "response" && typeof message.id === "number") {
      const request = pending.get(message.id);
      if (!request || request.key !== key) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      request.resolve(message.response);
    } else if (message.type === "video-event" && isRecord(message.message)) {
      // The frame key stands in for a documentId when events are validated.
      const sender = { ...port.sender, documentId: key };
      for (const listener of eventListeners) listener(message.message, sender);
    } else if (message.type === "media-changed") {
      notifyChange();
    }
  };

  port.onMessage.addListener((message: HostedAgentMessage) => {
    if (accepted) handle(message);
    else early.push(message);
  });
  port.onDisconnect.addListener(() => {
    if (!key || frames.get(key)?.port !== port) return;
    frames.delete(key);
    for (const [id, request] of pending) {
      if (request.key !== key) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      request.reject(new Error("The hosted Dub page frame disconnected."));
    }
    notifyChange();
  });
  void restored.then(() => {
    if (!port.sender || !isHostedSender(port.sender)) { refuse(port); return; }
    accepted = true;
    for (const message of early.splice(0)) handle(message);
  });
});

chrome.tabs.onRemoved.addListener(tabId => {
  // Through the host queue, rechecked when it runs: a newer container opened
  // meanwhile must keep its rules and scripts.
  void serialized(async () => {
    await restored;
    if (container?.kind !== "window" || container.tabId !== tabId) return;
    container = null;
    frames.clear();
    await persist();
    await clearSessionArtifacts();
    for (const listener of lostListeners) listener("The Dub window was closed.");
  }).catch(() => undefined);
});

export function onHostedChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function onHostedVideoEvent(listener: (message: ContentEventMessage, sender: chrome.runtime.MessageSender) => void): void {
  eventListeners.add(listener);
}

export function onHostLost(listener: (reason: string) => void): void {
  lostListeners.add(listener);
}

export function hostedFrames(): HostedFrame[] {
  return [...frames.values()].map(({ port: _port, ...frame }) => frame);
}

export function currentHost(): Readonly<ContainerRecord> | null {
  return container;
}

function waitForFrame(key: string, timeoutMs: number): Promise<FrameEntry | null> {
  const existing = frames.get(key);
  if (existing) return Promise.resolve(existing);
  return new Promise(resolve => {
    const done = (value: FrameEntry | null) => { unsubscribe(); clearTimeout(timer); resolve(value); };
    const unsubscribe = onHostedChange(() => { const frame = frames.get(key); if (frame) done(frame); });
    const timer = setTimeout(() => done(null), timeoutMs);
  });
}

/** Send one request to a hosted frame's agent. Waits briefly for a reconnecting frame. */
export async function hostedRequest(key: string, request: HostedRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  await restored;
  const frame = await waitForFrame(key, container ? RECONNECT_GRACE_MS : 0);
  if (!frame) throw new Error("The hidden Dub page is no longer available.");
  const id = ++requestSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("The hidden Dub page did not respond."));
    }, timeoutMs);
    pending.set(id, { key, resolve, reject, timer });
    try {
      frame.port.postMessage({ type: "request", id, request });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function registerScripts(): Promise<void> {
  const debug = (await chrome.storage.local.get(HOSTED_DEBUG_KEY).catch(() => ({})) as Record<string, unknown>)[HOSTED_DEBUG_KEY] === true;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [...SCRIPT_IDS, TRAIL_SCRIPT_ID] });
  // matchOriginAsFallback: about:blank/srcdoc/blob frames too, so a player (or a
  // clean storage handle) in such a frame can't escape the shim.
  const common = { matches: ["<all_urls>"], allFrames: true, matchOriginAsFallback: true, runAt: "document_start" as const, persistAcrossSessions: false };
  const scripts: chrome.scripting.RegisteredContentScript[] = [
    // First, so it sees the page's real storage and functions before the shim replaces them.
    ...(debug ? [{ ...common, id: TRAIL_SCRIPT_ID, js: ["hosted/hosted-trail.js"], world: "MAIN" as chrome.scripting.ExecutionWorld }] : []),
    { ...common, id: SCRIPT_IDS[0], js: ["hosted/hosted-shim.js"], world: "MAIN" as chrome.scripting.ExecutionWorld },
    { ...common, id: SCRIPT_IDS[1], js: ["hosted/hosted-agent.js"], world: "ISOLATED" as chrome.scripting.ExecutionWorld },
  ].filter(script => !existing.some(item => item.id === script.id));
  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
}

const SUB_FRAME = ["sub_frame" as chrome.declarativeNetRequest.ResourceType];
const STRIP_FRAME_HEADERS: chrome.declarativeNetRequest.RuleAction = {
  type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
  responseHeaders: [
    { header: "x-frame-options", operation: "remove" as chrome.declarativeNetRequest.HeaderOperation },
    { header: "content-security-policy", operation: "remove" as chrome.declarativeNetRequest.HeaderOperation },
  ],
};

/**
 * Who may ask for a frame whose anti-framing headers are dropped: the episode
 * site and the players it loads. Grows as hosted frames announce themselves, so
 * a player's own sub-frames are covered too. Another extension's frames are
 * requested by that extension, never by these sites, so they never match.
 */
let ruleScope: { tabIds: number[]; initiators: Set<string> } | null = null;

function embedRule(tabIds: number[], initiators: Set<string>): chrome.declarativeNetRequest.Rule {
  return {
    id: EMBED_HEADERS_RULE_ID,
    priority: 1,
    action: STRIP_FRAME_HEADERS,
    condition: { tabIds, resourceTypes: SUB_FRAME, initiatorDomains: [...initiators] },
  };
}

async function setRules(pageUrl: string, tabIds: number[]): Promise<void> {
  const page = new URL(pageUrl);
  ruleScope = { tabIds, initiators: new Set([page.hostname]) };
  const addRules: chrome.declarativeNetRequest.Rule[] = [
    {
      // The hosted page's top document is requested by an extension page. Give
      // it the Referer it would have when opened from its own site.
      id: REFERER_RULE_ID,
      priority: 1,
      action: {
        type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [{ header: "referer", operation: "set" as chrome.declarativeNetRequest.HeaderOperation, value: `${page.origin}/` }],
      },
      condition: { tabIds, resourceTypes: SUB_FRAME, requestDomains: [page.hostname] },
    },
    {
      // The episode page itself, framed by SubView's own container page.
      id: FRAME_HEADERS_RULE_ID,
      priority: 1,
      action: STRIP_FRAME_HEADERS,
      condition: { tabIds, resourceTypes: SUB_FRAME, requestDomains: [page.hostname] },
    },
    // Players and other frames the episode page (or an already-hosted player) loads.
    embedRule(tabIds, ruleScope.initiators),
    {
      // Sites with a service worker answer the hosted
      // frame's navigation with the worker's own fetch, which isn't a sub_frame
      // request and belongs to no tab (Chrome doesn't report a usable type or
      // initiator for it). Only that exact episode address, and only until the
      // hidden copy's page says hello (retireWorkerRule): a tab reloading the
      // same address in that window could lose its headers too.
      id: WORKER_FETCH_RULE_ID,
      priority: 1,
      action: STRIP_FRAME_HEADERS,
      condition: {
        // "*" and "^" are wildcards in urlFilter; percent-encode them to match literally.
        urlFilter: `|${page.href.replace(/\*/g, "%2A").replace(/\^/g, "%5E")}|`,
        isUrlFilterCaseSensitive: true,
        tabIds: [chrome.tabs.TAB_ID_NONE],
      },
    },
  ];
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: RULE_IDS, addRules });
}

async function retireWorkerRule(): Promise<void> {
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [WORKER_FETCH_RULE_ID] }); } catch { /* Already gone. */ }
}

/** A hosted frame announced itself: frames it loads may render in the container too. */
async function allowFramesFrom(href: string): Promise<void> {
  let host: string;
  try {
    const url = new URL(href);
    if (!/^https?:$/.test(url.protocol)) return;
    host = url.hostname;
  } catch { return; }
  if (!ruleScope) {
    // Worker restart: rebuild the scope from the rule that is still installed.
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const existing = rules.find(rule => rule.id === EMBED_HEADERS_RULE_ID);
    if (!existing?.condition.tabIds || !container) return;
    ruleScope = { tabIds: existing.condition.tabIds, initiators: new Set(existing.condition.initiatorDomains ?? []) };
  }
  if (ruleScope.initiators.has(host)) return;
  ruleScope.initiators.add(host);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [EMBED_HEADERS_RULE_ID],
    addRules: [embedRule(ruleScope.tabIds, ruleScope.initiators)],
  });
}

/**
 * Some services save the audio language to the viewer's account the moment it
 * is chosen. While the hidden copy presses that control, its settings-changing
 * requests (PATCH and PUT) are dropped, so the copy can switch language without
 * changing what the viewer's own tabs open with next time. Scoped to the
 * hosted container and the sites loaded in it; requests that play the video
 * use other methods.
 */
export function guardSettingsWrites(on: boolean): Promise<void> {
  return serialized(async () => {
    const scope = on ? ruleScope : null;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SETTINGS_GUARD_RULE_ID],
      addRules: scope ? [{
        id: SETTINGS_GUARD_RULE_ID,
        priority: 2,
        action: { type: "block" as chrome.declarativeNetRequest.RuleActionType },
        condition: {
          tabIds: scope.tabIds,
          initiatorDomains: [...scope.initiators],
          requestMethods: ["patch", "put"] as chrome.declarativeNetRequest.RequestMethod[],
          resourceTypes: ["xmlhttprequest" as chrome.declarativeNetRequest.ResourceType],
        },
      }] : [],
    });
  }).catch(() => undefined);
}

/** Best effort: cleanup must never block stopping. */
async function clearSessionArtifacts(): Promise<void> {
  ruleScope = null;
  try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: RULE_IDS }); } catch { /* None installed. */ }
  try { await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS }); } catch { /* None registered. */ }
  try { await chrome.scripting.unregisterContentScripts({ ids: [TRAIL_SCRIPT_ID] }); } catch { /* Debug was off. */ }
}

/** Load the episode page into a fresh container. Replaces any existing container. */
export function openHost(pageUrl: string, kind: HostContainer): Promise<void> {
  return serialized(() => openHostNow(pageUrl, kind));
}

function dropFrames(reason: string): void {
  for (const frame of frames.values()) {
    try { frame.port.disconnect(); } catch { /* Already gone. */ }
  }
  frames.clear();
  for (const [id, request] of pending) {
    pending.delete(id);
    clearTimeout(request.timer);
    request.reject(new Error(reason));
  }
}

async function openHostNow(pageUrl: string, kind: HostContainer): Promise<void> {
  await restored;
  // Next episode in the hidden document: keep the document and the registered
  // scripts, swap only the page. Tearing both down and rebuilding them a moment
  // later is slower and invites registration races.
  if (container?.kind === "offscreen" && kind === "offscreen" && await hasOffscreenPlayer()) {
    dropFrames("The hidden Dub page moved to another episode.");
    container = { kind, pageUrl };
    await persist();
    await registerScripts();
    await setRules(pageUrl, [chrome.tabs.TAB_ID_NONE]);
    const result = await offscreenRequest({ type: "OFFSCREEN_HOST", url: pageUrl });
    if (!isRecord(result) || result.ok !== true) throw new Error("The hidden Dub page could not be created.");
    return;
  }
  await closeHostNow();
  container = { kind, pageUrl };
  await persist();
  await registerScripts();
  if (kind === "offscreen") {
    await setRules(pageUrl, [chrome.tabs.TAB_ID_NONE]);
    await createOffscreenPlayer();
    const result = await offscreenRequest({ type: "OFFSCREEN_HOST", url: pageUrl });
    if (!isRecord(result) || result.ok !== true) throw new Error("The hidden Dub page could not be created.");
    return;
  }
  // Create the window first so its tab id can scope the rules before the page loads.
  const created = await chrome.windows.create({ url: chrome.runtime.getURL(HOST_PAGE), focused: false, state: "minimized" });
  const tabId = created?.tabs?.[0]?.id;
  if (!created?.id || tabId === undefined) throw new Error("The Dub window could not be created.");
  container = { kind, pageUrl, tabId, windowId: created.id };
  await persist();
  await setRules(pageUrl, [tabId]);
  await chrome.tabs.update(tabId, { url: `${chrome.runtime.getURL(HOST_PAGE)}?url=${encodeURIComponent(pageUrl)}` });
}

export function closeHost(): Promise<void> {
  return serialized(closeHostNow);
}

async function closeHostNow(): Promise<void> {
  await restored;
  const previous = container;
  container = null;
  dropFrames("The hidden Dub page closed.");
  await persist();
  if (previous?.kind === "offscreen") {
    await offscreenRequest({ type: "OFFSCREEN_UNHOST" }).catch(() => undefined);
    await closeOffscreenPlayer().catch(() => undefined);
  } else if (previous?.windowId !== undefined) {
    await chrome.windows.remove(previous.windowId).catch(() => undefined);
  }
  await clearSessionArtifacts();
}
