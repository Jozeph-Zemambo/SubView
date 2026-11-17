import type { ContentEventMessage, ContentRequest } from "./types";

/** Port name used by agents inside hosted Dub pages. */
export const HOSTED_PORT = "subview-hosted";

/** Requests the worker sends to one hosted frame's agent. */
export type HostedRequest =
  | ContentRequest
  | { type: "DETECT" }
  /** force: click Dub even though the page never says which language is selected. */
  | { type: "SELECT_DUB"; force?: boolean }
  | { type: "LIST_PROVIDERS" }
  | { type: "SELECT_PROVIDER"; provider: string };

export type HostedAgentMessage =
  /** frame: a random key naming this frame; offscreen frames have no documentId. */
  | { type: "hello"; frame: string; href: string; depth: number }
  | { type: "response"; id: number; response: unknown }
  | { type: "video-event"; message: ContentEventMessage }
  | { type: "media-changed" };

export type HostedWorkerMessage = { type: "request"; id: number; request: HostedRequest };
