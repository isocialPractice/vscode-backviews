/**
 * Parser for VSCode's chat session store files (workspaceStorage/<hash>/
 * chatSessions/*.json[l]). The format is undocumented and versioned:
 * plain .json files hold the session object directly (possibly under `v`),
 * while .jsonl files hold a snapshot line followed by `{kind, k: [path...],
 * v}` set-operations applied over it. Everything here is best-effort and
 * returns null rather than throwing.
 */
import { ChatExchange, ChatSessionSnapshot } from './settings';

/** Older exchanges kept as static wall writings. */
export const CHAT_HISTORY_MAX = 4;
/** The live response is ghost-written from its beginning, clipped here (it
 * flows across multiple walls, so this spans several wall segments). */
export const CHAT_CURRENT_CLIP = 600;

/**
 * Parses a session store file into a wall-ready snapshot. `fresh` says
 * whether the file was modified recently enough to still be streaming.
 * 
 * The parser handles both .json (simple object) and .jsonl (snapshot +
 * set-operations) formats, extracting chat requests and responses into
 * a format suitable for display on the backrooms walls.
 */
export function snapshotFromSession(raw: string, fresh: boolean): ChatSessionSnapshot | null {
  try {
    const data = loadSessionObject(raw) as Record<string, unknown> | null;
    const requests = data?.requests;
    if (!Array.isArray(requests) || requests.length === 0) {
      return null;
    }

    // Build history from all but the last request (up to CHAT_HISTORY_MAX)
    const history: ChatExchange[] = [];
    for (const raw of requests.slice(0, -1).slice(-CHAT_HISTORY_MAX)) {
      if (typeof raw !== 'object' || raw === null) {
        continue;
      }
      const request = raw as Record<string, unknown>;
      const exchange: ChatExchange = {
        prompt: normalizeChatText(promptTextOf(request)).slice(0, 100),
        response: normalizeChatText(responseTextOf(request)).slice(0, 200),
      };
      if (exchange.prompt || exchange.response) {
        history.push(exchange);
      }
    }

    // The last request is the current response (may still be streaming)
    const last = requests[requests.length - 1] as Record<string, unknown>;
    const fullResponse = normalizeChatText(responseTextOf(last));
    return {
      working: fresh && !requestDone(last),
      history,
      current: fullResponse.slice(0, CHAT_CURRENT_CLIP),
      tokens: Math.ceil(fullResponse.length / 4),
    };
  } catch {
    return null;
  }
}

/** Extracts a display string from a chat message/response part. */
function partText(part: unknown): string {
  if (typeof part === 'string') {
    return part;
  }
  if (typeof part !== 'object' || part === null) {
    return '';
  }
  const p = part as Record<string, unknown>;
  // Tool invocation parts carry a toolCallId and no prose value; skip them.
  if (typeof p.toolCallId === 'string') {
    return '';
  }
  if (typeof p.text === 'string') {
    return p.text;
  }
  if (typeof p.value === 'string') {
    return p.value;
  }
  const value = p.value as Record<string, unknown> | undefined;
  if (value && typeof value.value === 'string') {
    return value.value;
  }
  return '';
}

/**
 * Collapses markdown-ish response text into one wall-friendly line.
 * Strips code blocks, markdown formatting characters, and normalizes
 * whitespace for clean display on the backrooms walls.
 */
function normalizeChatText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // Remove code blocks
    .replace(/[`*_#>|]/g, '')        // Strip markdown chars
    .replace(/\s+/g, ' ')            // Collapse whitespace
    .trim();
}

function promptTextOf(request: Record<string, unknown>): string {
  const message = request.message as Record<string, unknown> | undefined;
  if (!message) {
    return '';
  }
  if (typeof message.text === 'string') {
    return message.text;
  }
  const parts = message.parts;
  return Array.isArray(parts) ? parts.map(partText).join(' ') : '';
}

function responseTextOf(request: Record<string, unknown>): string {
  const response = request.response;
  return Array.isArray(response) ? response.map(partText).join('') : '';
}

function requestDone(request: Record<string, unknown>): boolean {
  return request.result !== undefined || request.isCanceled === true;
}

/**
 * Rebuilds the session object from its store file (json or jsonl).
 * 
 * .json files contain the object directly (possibly under a 'v' key).
 * .jsonl files contain a base snapshot on line 1, followed by
 * {kind, k: [path...], v} set-operations that mutate it.
 */
function loadSessionObject(raw: string): unknown {
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }
  // First line is either the full object or the base snapshot
  const first = JSON.parse(lines[0]!) as Record<string, unknown>;
  let base: unknown = first.v !== undefined ? first.v : first;
  // Apply subsequent set-operations for .jsonl format
  for (let i = 1; i < lines.length; i++) {
    try {
      const op = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (Array.isArray(op.k)) {
        base = applyAtPath(base, op.k as (string | number)[], op.v);
      }
    } catch {
      // Skip malformed or unknown op lines.
    }
  }
  return base;
}

/**
 * Sets `value` at `segments` inside `target`, creating containers as needed.
 * This implements the path-based updates in .jsonl session files.
 * 
 * For example: applyAtPath(obj, ['requests', 0, 'response'], text)
 * would set obj.requests[0].response = text, creating the path if needed.
 */
function applyAtPath(target: unknown, segments: (string | number)[], value: unknown): unknown {
  if (segments.length === 0) {
    return value;
  }
  let root = target;
  const headIndex = toIndex(segments[0]!);
  // Create root container (array or object) if needed
  if (root === null || typeof root !== 'object') {
    root = headIndex !== null ? [] : {};
  }
  let node = root as Record<string | number, unknown>;
  // Walk the path, creating intermediate containers
  for (let i = 0; i < segments.length - 1; i++) {
    const key = toIndex(segments[i]!) ?? segments[i]!;
    const nextIsIndex = toIndex(segments[i + 1]!) !== null;
    const child = node[key];
    if (child === null || typeof child !== 'object') {
      node[key] = nextIsIndex ? [] : {};
    }
    node = node[key] as Record<string | number, unknown>;
  }
  // Set the final value
  const lastKey = toIndex(segments[segments.length - 1]!) ?? segments[segments.length - 1]!;
  node[lastKey] = value;
  return root;
}

function toIndex(segment: string | number): number | null {
  if (typeof segment === 'number') {
    return segment;
  }
  return /^\d+$/.test(segment) ? Number(segment) : null;
}
