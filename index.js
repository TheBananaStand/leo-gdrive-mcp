#!/usr/bin/env node
//
// Google Drive as Leo tools, over MCP.
//
// TWO TOOLS, not a provider role.
//
//   gdrive       — list, read, metadata (drive.file scope, read-only)
//   gdrive_write — create_doc, create_sheet, upload, update, mkdir
//
// Drive is tool-driven, not provider-driven. The model calls these directly; the
// hub does not call a sync hook. Token delivery reflects this: instead of the hub
// passing an access_token in the arguments (as gmail does), it injects a
// single-use grant handle under _oauth_grant. This server exchanges that handle
// once per invocation:
//
//   POST {LEO_API_URL}/graph/v1/oauth/exchange
//   Authorization: Bearer {LEO_PACKAGE_TOKEN}
//   body: {"grant": "<value of _oauth_grant>"}
//   -> 200 {"access_token": "...", "provider": "google"}
//
// A missing _oauth_grant means the package is not entitled to act on the user's
// Google account, which is the hub's way of enforcing consent — not a bug to
// work around.
//
// Plain JavaScript on purpose: this ships as a git tarball, and npm does not
// reliably run build steps for a tarball URL.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
/** Fields returned for every file — list results, write results, metadata. */
const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink";

// ---------------------------------------------------------------------------
// OAuth grant exchange
// ---------------------------------------------------------------------------

/**
 * Exchange the single-use _oauth_grant from the tool arguments for a Google
 * access token.
 *
 * A grant is issued by the hub for exactly one invocation and expires
 * immediately after the exchange. Calling this more than once per tool call
 * would fail — so the callers cache the result across every Drive request they
 * make in that invocation.
 *
 * The hub withholds the grant in three cases, and a disconnected Google account
 * is NOT one of them — that surfaces later, out of the exchange, as a 404
 * naming the provider. Absence here means the owner never granted the
 * `oauth_tokens` entitlement, or the call has no acting user to act as (a
 * scheduled run belongs to nobody). Telling someone to reconnect their account
 * would send them to re-authorize a connection that is already fine.
 */
export async function getAccessToken(args) {
  const grant = args?._oauth_grant;
  if (!grant) {
    throw new Error(
      "No OAuth grant on this call. Google Drive has not been granted " +
        "permission to act on your account — check this package's entitlements " +
        "in Settings. (Calls with no acting user, such as scheduled runs, never " +
        "carry one.)"
    );
  }

  const apiUrl = process.env.LEO_API_URL;
  const packageToken = process.env.LEO_PACKAGE_TOKEN;
  if (!apiUrl || !packageToken) {
    throw new Error(
      "LEO_API_URL and LEO_PACKAGE_TOKEN must be set — the hub injects these when it launches the package."
    );
  }

  const resp = await fetch(`${apiUrl}/graph/v1/oauth/exchange`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${packageToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ grant }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`OAuth exchange failed ${resp.status}: ${detail.slice(0, 200)}`);
  }
  const body = await resp.json();
  return body.access_token;
}

// ---------------------------------------------------------------------------
// Pure helpers — these are what this server can get wrong without anyone
// noticing, because a Drive API error is loud and a logic error is not.
// ---------------------------------------------------------------------------

/**
 * Escape a value for interpolation into a Drive `q` search clause.
 *
 * Drive's query language uses single-quoted string literals, so a name
 * containing a backslash or single-quote would break the clause or allow
 * injection into it.
 */
export function escapeQ(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * True for Google-native document types (Docs, Sheets, Slides, Forms, …).
 *
 * Native files cannot be downloaded as-is — they have no binary body. They
 * must be exported to a concrete MIME type first. The prefix is the canonical
 * test: every google-apps type carries it.
 */
export function isGoogleNative(mime) {
  return typeof mime === "string" && mime.startsWith("application/vnd.google-apps.");
}

/**
 * The export MIME type for a Google-native document.
 *
 * Returns [primary, fallback?]. The fallback is only defined for Docs because
 * Markdown export can return 400 on some accounts — plain text is always safe.
 * Everything else gets text/plain; there is no meaningful export for Slides or
 * Forms, but text/plain recovers some structure.
 */
export function exportMime(googleMime) {
  switch (googleMime) {
    case "application/vnd.google-apps.document":
      return ["text/markdown", "text/plain"];
    case "application/vnd.google-apps.spreadsheet":
      return ["text/csv", null];
    default:
      return ["text/plain", null];
  }
}

/**
 * Clamp `max_results` to [1, 100] with a default of 25.
 *
 * Drive's pageSize cap is 1000, but the Rust source clamped to 100 — keeping
 * that ceiling avoids accidentally dumping hundreds of file records into a
 * model context.
 */
export function clampPageSize(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 25;
  return Math.max(1, Math.min(100, Math.trunc(n)));
}

/**
 * The `parents` array for a create call, or undefined when no folder is named.
 *
 * Drive interprets an empty parents array differently from no parents key at
 * all, so omitting it when there is no folder keeps the file in root rather
 * than producing an error.
 */
export function parents(folderId) {
  if (!folderId || folderId === "") return undefined;
  return [folderId];
}

// ---------------------------------------------------------------------------
// Drive API calls
// ---------------------------------------------------------------------------

async function driveRequest(token, url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.contentType ? { "content-type": init.contentType } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const err = new Error(`Drive API ${response.status}: ${detail.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
  const text = await response.text();
  return text === "" ? {} : JSON.parse(text);
}

/** Fetch file content as text (non-native files: ?alt=media). */
async function driveDownloadText(token, fileId) {
  const url = `${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const err = new Error(`Drive download ${response.status}: ${detail.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
  // Drive returns the raw bytes. If they are not valid UTF-8 (a binary file),
  // report that honestly rather than returning mojibake.
  const buf = await response.arrayBuffer();
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), binary: false };
  } catch {
    return { text: `[binary file, ${buf.byteLength} bytes, not UTF-8 text — cannot display inline]`, binary: true };
  }
}

/** Export a Google-native doc to a concrete MIME type (text/markdown, text/csv, …). */
async function driveExport(token, fileId, exportMimeType) {
  const url = `${DRIVE_FILES}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMimeType)}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const err = new Error(`Drive export ${response.status}: ${detail.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
  return response.text();
}

/**
 * Multipart (multipart/related) upload: one request carrying JSON metadata and
 * the media body. Drive uses this shape for both initial creates and uploads.
 *
 * The boundary is random per call so document content can never collide with
 * the delimiter and corrupt the upload.
 */
async function multipartCreate(token, metadata, media, mediaMime) {
  // A short random hex boundary — no uuid dependency needed.
  const boundary = `leo_gdrive_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const metaJson = JSON.stringify(metadata);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n` +
    `--${boundary}\r\nContent-Type: ${mediaMime}\r\n\r\n${media}\r\n` +
    `--${boundary}--`;

  const url = `${DRIVE_UPLOAD}?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`;
  return driveRequest(token, url, {
    method: "POST",
    contentType: `multipart/related; boundary=${boundary}`,
    body,
  });
}

// ---------------------------------------------------------------------------
// gdrive action implementations
// ---------------------------------------------------------------------------

async function actionList(token, { query, mime_type, max_results }) {
  const clauses = ["trashed = false"];
  if (query && query !== "") {
    clauses.push(`name contains '${escapeQ(query)}'`);
  }
  if (mime_type && mime_type !== "") {
    clauses.push(`mimeType = '${escapeQ(mime_type)}'`);
  }
  const q = clauses.join(" and ");
  const pageSize = clampPageSize(max_results);

  const params = new URLSearchParams({
    q,
    fields: `files(${FILE_FIELDS})`,
    pageSize: String(pageSize),
    orderBy: "modifiedTime desc",
    spaces: "drive",
  });
  const resp = await driveRequest(token, `${DRIVE_FILES}?${params}`);
  const files = Array.isArray(resp.files) ? resp.files : [];
  if (files.length === 0) {
    return "No Leo-created files found. (drive.file scope only sees files Leo created; it cannot list your existing Drive.)";
  }
  return JSON.stringify(files, null, 2);
}

async function actionRead(token, { file_id }) {
  if (!file_id) throw new Error("'file_id' is required for read action");

  // Learn the type first so we know whether to export or download.
  const meta = await driveRequest(
    token,
    `${DRIVE_FILES}/${encodeURIComponent(file_id)}?fields=name%2CmimeType`
  );
  const mime = typeof meta.mimeType === "string" ? meta.mimeType : "";

  if (isGoogleNative(mime)) {
    const [primary, fallback] = exportMime(mime);
    try {
      return await driveExport(token, file_id, primary);
    } catch (e) {
      // Markdown export returns 400 on some accounts; fall back to plain text
      // for Docs only (the only type that has a fallback defined).
      if (fallback && e.status === 400) {
        return driveExport(token, file_id, fallback);
      }
      throw e;
    }
  } else {
    const { text } = await driveDownloadText(token, file_id);
    return text;
  }
}

async function actionMetadata(token, { file_id }) {
  if (!file_id) throw new Error("'file_id' is required for metadata action");
  const resp = await driveRequest(
    token,
    `${DRIVE_FILES}/${encodeURIComponent(file_id)}?fields=${encodeURIComponent(FILE_FIELDS)}`
  );
  return JSON.stringify(resp, null, 2);
}

// ---------------------------------------------------------------------------
// gdrive_write action implementations
// ---------------------------------------------------------------------------

async function actionCreateDoc(token, { name, content, folder_id }) {
  if (!name) throw new Error("'name' is required for create_doc");
  const meta = { name, mimeType: "application/vnd.google-apps.document" };
  const p = parents(folder_id);
  if (p) meta.parents = p;
  // Drive converts the plain-text body to a native Doc on ingest.
  return multipartCreate(token, meta, content ?? "", "text/plain");
}

async function actionCreateSheet(token, { name, content, folder_id }) {
  if (!name) throw new Error("'name' is required for create_sheet");
  const meta = { name, mimeType: "application/vnd.google-apps.spreadsheet" };
  const p = parents(folder_id);
  if (p) meta.parents = p;
  return multipartCreate(token, meta, content ?? "", "text/csv");
}

async function actionUpload(token, { name, content, mime_type, folder_id }) {
  if (!name) throw new Error("'name' is required for upload");
  const meta = { name };
  const p = parents(folder_id);
  if (p) meta.parents = p;
  return multipartCreate(token, meta, content ?? "", mime_type || "text/plain");
}

async function actionUpdate(token, { file_id, content, mime_type }) {
  if (!file_id) throw new Error("'file_id' is required for update");
  const url =
    `${DRIVE_UPLOAD}/${encodeURIComponent(file_id)}` +
    `?uploadType=media&fields=${encodeURIComponent(FILE_FIELDS)}`;
  return driveRequest(token, url, {
    method: "PATCH",
    contentType: mime_type || "text/plain",
    body: content ?? "",
  });
}

async function actionMkdir(token, { name, folder_id }) {
  if (!name) throw new Error("'name' is required for mkdir");
  const meta = { name, mimeType: "application/vnd.google-apps.folder" };
  const p = parents(folder_id);
  if (p) meta.parents = p;
  const url = `${DRIVE_FILES}?fields=${encodeURIComponent(FILE_FIELDS)}`;
  return driveRequest(token, url, {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify(meta),
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = {
  gdrive: {
    description:
      "Read Google Drive files Leo created. read exports text — Docs as Markdown, Sheets as CSV. drive.file scope: Leo sees only files it created, and cannot browse or search the user's existing Drive.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "metadata"],
          description: "Action",
        },
        query: {
          type: "string",
          description: "For list: filter by name substring.",
        },
        mime_type: {
          type: "string",
          description:
            "For list: exact MIME type, e.g. application/vnd.google-apps.document, application/vnd.google-apps.spreadsheet.",
        },
        file_id: {
          type: "string",
          description: "File ID (for read, metadata).",
        },
        max_results: {
          type: "integer",
          description: "For list: max files (default 25, max 100).",
        },
      },
      required: ["action"],
    },
    run: async (args) => {
      const token = await getAccessToken(args);
      switch (args.action) {
        case "list":
          return actionList(token, args);
        case "read":
          return actionRead(token, args);
        case "metadata":
          return actionMetadata(token, args);
        default:
          throw new Error(`Unknown action: ${args.action}. Use: list, read, metadata`);
      }
    },
  },

  gdrive_write: {
    description:
      "Create and modify Google Drive files. Returns the file's id and webViewLink. Only affects Leo-created files (drive.file scope).",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create_doc", "create_sheet", "upload", "update", "mkdir"],
          description: "Action",
        },
        name: {
          type: "string",
          description: "File or folder name (for create_doc, create_sheet, upload, mkdir).",
        },
        content: {
          type: "string",
          description:
            "Body content. Plain text for create_doc, CSV for create_sheet, raw bytes-as-text for upload/update.",
        },
        mime_type: {
          type: "string",
          description: "For upload/update: MIME type (default text/plain).",
        },
        folder_id: {
          type: "string",
          description: "Parent folder ID (must be a Leo-created folder).",
        },
        file_id: {
          type: "string",
          description: "For update: file to replace.",
        },
      },
      required: ["action"],
    },
    run: async (args) => {
      const token = await getAccessToken(args);
      let result;
      switch (args.action) {
        case "create_doc":
          result = await actionCreateDoc(token, args);
          break;
        case "create_sheet":
          result = await actionCreateSheet(token, args);
          break;
        case "upload":
          result = await actionUpload(token, args);
          break;
        case "update":
          result = await actionUpdate(token, args);
          break;
        case "mkdir":
          result = await actionMkdir(token, args);
          break;
        default:
          throw new Error(
            `Unknown action: ${args.action}. Use: create_doc, create_sheet, upload, update, mkdir`
          );
      }
      return JSON.stringify(result);
    },
  },
};

export function missingRequired(name, args) {
  const required = TOOLS[name]?.inputSchema?.required ?? [];
  return required.filter((k) => {
    const v = args?.[k];
    return v === undefined || v === null || v === "";
  });
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "leo-gdrive-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = TOOLS[name];
  if (!tool) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
  const missing = missingRequired(name, args);
  if (missing.length > 0) {
    return {
      isError: true,
      content: [{ type: "text", text: `${name} requires: ${missing.join(", ")}` }],
    };
  }
  try {
    const answer = await tool.run(args ?? {});
    return { content: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }] };
  } catch (error) {
    // `isError` is what the hub reads to tell "no files found" from "the call
    // did not run" — without it an auth failure records as a successful empty
    // result, and the model reports "no files" when the real answer is
    // "not connected."
    return {
      isError: true,
      content: [{ type: "text", text: String(error?.message ?? error) }],
    };
  }
});

if (process.env.LEO_GDRIVE_MCP_NO_SERVE !== "1") {
  await server.connect(new StdioServerTransport());
}
