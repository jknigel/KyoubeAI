// Pure builders for connection calls: no network, no secret cache. This module decides exactly which
// URL, headers and body leave the worker and which response headers come back, so it refuses anything
// ambiguous. No message thrown here ever contains the secret (it is only read by buildHeaders, and
// every error there is fixed text).
import { DataError } from "../data/errors.js";
import type { Connection } from "./config.js";

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export interface CallInput { method?: unknown; path?: unknown; query?: unknown; headers?: unknown; body?: unknown }
export interface ParsedCall {
  method: HttpMethod;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
}

const MAX_PATH_CHARS = 2000;
const MAX_QUERY_KEYS = 100;
const MAX_HEADER_VALUE_CHARS = 1000;
const APP_HEADERS: ReadonlySet<string> = new Set(["accept", "content-type", "if-match", "if-none-match", "idempotency-key", "x-request-id"]);
const RESPONSE_HEADERS: ReadonlySet<string> = new Set(["content-type", "content-length", "etag", "last-modified", "location", "retry-after", "x-request-id"]);

const bad = (message: string): DataError => new DataError("invalid", message);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function parseCallInput(raw: unknown): ParsedCall {
  if (raw === undefined) raw = {};
  if (!isPlainObject(raw)) throw bad("the call must be an object");
  const input = raw as CallInput;

  const methodRaw = input.method === undefined ? "GET" : input.method;
  if (typeof methodRaw !== "string") throw bad("method must be a string");
  const method = methodRaw.toUpperCase();
  if (!METHODS.includes(method)) throw bad("method must be GET, POST, PUT, PATCH or DELETE");

  const path = input.path === undefined ? "" : input.path;
  if (typeof path !== "string") throw bad("path must be a string");
  if (path.length > MAX_PATH_CHARS) throw bad(`path is longer than ${MAX_PATH_CHARS} characters`);

  const query: Array<[string, string]> = [];
  if (input.query !== undefined) {
    if (!isPlainObject(input.query)) throw bad("query must be an object");
    const entries = Object.entries(input.query);
    if (entries.length > MAX_QUERY_KEYS) throw bad(`query has more than ${MAX_QUERY_KEYS} keys`);
    for (const [key, value] of entries) {
      if (typeof value === "string") query.push([key, value]);
      else if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") query.push([key, String(value)]);
      else throw bad(`query "${key}" must be a string, number or boolean`);
    }
  }

  const headers: Array<[string, string]> = [];
  if (input.headers !== undefined) {
    if (!isPlainObject(input.headers)) throw bad("headers must be an object");
    for (const [name, value] of Object.entries(input.headers)) {
      const lower = name.toLowerCase();
      if (!APP_HEADERS.has(lower)) throw bad(`the header "${name}" cannot be set; allowed: ${[...APP_HEADERS].join(", ")}`);
      if (headers.some(([n]) => n === lower)) throw bad(`the header "${lower}" is given twice`);
      if (typeof value !== "string") throw bad(`the header "${lower}" must be a string`);
      if (value.length > MAX_HEADER_VALUE_CHARS) throw bad(`the header "${lower}" is longer than ${MAX_HEADER_VALUE_CHARS} characters`);
      if (/[\r\n\0]/.test(value)) throw bad(`the header "${lower}" contains a line break or NUL`);
      headers.push([lower, value]);
    }
  }

  let body: string | null = null;
  const rawBody = input.body;
  if (rawBody !== undefined && rawBody !== null) {
    if (typeof rawBody === "string") body = rawBody;
    else {
      let json: string | undefined;
      try { json = JSON.stringify(rawBody); } catch { throw bad("body cannot be serialised as JSON"); }
      if (typeof json !== "string") throw bad("body cannot be serialised as JSON");
      body = json;
      if (!headers.some(([n]) => n === "content-type")) headers.push(["content-type", "application/json"]);
    }
    if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BODY_BYTES) throw bad(`body is larger than ${MAX_REQUEST_BODY_BYTES} bytes`);
    if (method === "GET") throw bad("a GET request cannot have a body");
  }

  // fromEntries creates own properties, so a "__proto__" key stays data.
  return { method: method as HttpMethod, path, query: Object.fromEntries(query), headers: Object.fromEntries(headers), body };
}

export function pathWithoutQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

// Refused before URL resolution, which would silently normalise "..", "%2e", tabs and backslashes.
const ABSOLUTE_RE = /^[a-z][a-z0-9+.-]*:/i;
// Any control character (URL parsing strips tab/CR/LF), anything outside printable ASCII (full-width dots
// and slashes, ideographic full stops), `?` and `#` (the query goes in `query`), backslash.
const FORBIDDEN_CHARS_RE = /[^\x20-\x7e]|[?#\\]/;
// Encoded dot, slash, backslash, NUL, and the double-encoded forms of the first three.
const FORBIDDEN_ESCAPE_RE = /%(?:2e|2f|5c|00|25(?:2e|2f|5c|00))/i;

export function buildUrl(connection: Connection, path: string, query: Record<string, string>): string {
  if (typeof path !== "string") throw bad("path must be a string");
  if (path.length > MAX_PATH_CHARS) throw bad(`path is longer than ${MAX_PATH_CHARS} characters`);
  if (FORBIDDEN_CHARS_RE.test(path)) throw bad("path may not contain control or non-ASCII characters, ?, # or backslashes (put the query in query)");
  if (path.startsWith("/")) throw bad("path must be relative to the connection's base URL (no leading slash)");
  if (path !== path.trim()) throw bad("path may not start or end with a space");
  if (ABSOLUTE_RE.test(path)) throw bad("path must be relative to the connection's base URL (no scheme)");
  if (FORBIDDEN_ESCAPE_RE.test(path)) throw bad("path may not contain encoded dots, slashes or NULs");
  const segments = path.split("/");
  segments.forEach((segment, i) => {
    if (segment === "." || segment === "..") throw bad("path may not contain . or .. segments");
    if (segment === "" && i < segments.length - 1) throw bad("path may not contain empty segments");
  });

  let base: URL;
  let url: URL;
  try {
    base = new URL(connection.baseUrl);
    url = new URL(path, base);
  } catch {
    throw bad("the path does not make a valid URL");
  }
  if (base.protocol !== "https:" || !base.pathname.endsWith("/")) throw bad("the connection's base URL is not usable");
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw bad("path leaves the connection's base URL");

  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

export function buildHeaders(connection: Connection, call: ParsedCall, secret: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(call.headers)) {
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === connection.headerName) throw bad(`the header "${lower}" is set by the connection and cannot be passed`);
    headers[lower] = value;
  }
  if (typeof secret !== "string" || secret === "") throw bad("the connection's secret is empty");
  if (connection.auth === "bearer") {
    if (/[\r\n\0]/.test(secret)) throw bad("the connection's secret cannot be sent as a header value");
    headers.authorization = `Bearer ${secret}`;
  } else if (connection.auth === "header") {
    if (!connection.headerName) throw bad("the connection has no header name");
    if (/[\r\n\0]/.test(secret)) throw bad("the connection's secret cannot be sent as a header value");
    headers[connection.headerName] = secret;
  } else if (connection.auth === "basic") {
    headers.authorization = `Basic ${Buffer.from(secret, "utf8").toString("base64")}`;
  } else {
    throw bad("the connection's auth style is not supported");
  }
  return headers;
}

export function shapeResponse(res: { status: number; headers: Headers | Record<string, string>; bodyText: string }): {
  status: number; headers: Record<string, string>; body: string;
} {
  if (Buffer.byteLength(res.bodyText, "utf8") > MAX_RESPONSE_BODY_BYTES) {
    throw new DataError("too_large", `the response body is larger than ${MAX_RESPONSE_BODY_BYTES} bytes`);
  }
  const pairs: Array<[string, string]> = res.headers instanceof Headers ? headerPairs(res.headers) : Object.entries(res.headers);
  const headers: Record<string, string> = {};
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (RESPONSE_HEADERS.has(lower) || lower.startsWith("x-ratelimit-")) headers[lower] = String(value);
  }
  return { status: res.status, headers, body: res.bodyText };
}

function headerPairs(headers: Headers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  headers.forEach((value, name) => { out.push([name, value]); });
  return out;
}
