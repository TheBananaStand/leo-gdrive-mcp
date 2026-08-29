// Smoke test for the pure helpers — which is the whole of what this server can
// get wrong without anyone noticing.
//
// Drive API errors are loud. What is silent is a query clause that accepts
// injection, an export that falls back to the wrong MIME type, a boundary that
// could collide with document content, or a page size that silently ignores a
// cap.
//
//   node test.js

process.env.LEO_GDRIVE_MCP_NO_SERVE = "1";

const {
  escapeQ,
  isGoogleNative,
  exportMime,
  clampPageSize,
  parents,
  missingRequired,
} = await import("./index.js");
const assert = await import("node:assert/strict");

// ── query escaping ──────────────────────────────────────────────────────────
// Drive uses single-quoted string literals in its `q` search clauses. A name
// containing a backslash or single-quote would break the clause or allow
// injection into it.
{
  assert.equal(escapeQ("O'Brien"), "O\\'Brien");
  assert.equal(escapeQ("a\\b"), "a\\\\b");
  // Both in the same string.
  assert.equal(escapeQ("O'B\\x"), "O\\'B\\\\x");
  assert.equal(escapeQ("plain"), "plain");
  // Empty string is valid (callers guard before interpolating, but escaping must
  // not throw).
  assert.equal(escapeQ(""), "");
}

// ── native MIME detection ───────────────────────────────────────────────────
// The prefix "application/vnd.google-apps." is the canonical test. Getting this
// wrong means attempting a raw download of a file that has no binary body,
// which Drive rejects with 403 or returns empty bytes — neither of which is the
// content.
{
  assert.equal(isGoogleNative("application/vnd.google-apps.document"), true);
  assert.equal(isGoogleNative("application/vnd.google-apps.spreadsheet"), true);
  assert.equal(isGoogleNative("application/vnd.google-apps.presentation"), true);
  assert.equal(isGoogleNative("application/vnd.google-apps.folder"), true);
  assert.equal(isGoogleNative("application/pdf"), false);
  assert.equal(isGoogleNative("text/plain"), false);
  assert.equal(isGoogleNative(""), false);
  // Must not throw on non-strings.
  assert.equal(isGoogleNative(null), false);
  assert.equal(isGoogleNative(undefined), false);
}

// ── export MIME mapping ─────────────────────────────────────────────────────
// THREE DECISIONS, each load-bearing:
//
// Docs → text/markdown (primary) with text/plain as fallback. Markdown export
// returns 400 on some accounts; plain text is always safe. The fallback exists
// ONLY for Docs — Sheets have no meaningful plain-text form, and the Rust
// source does not offer one.
//
// Sheets → text/csv only. No fallback.
//
// Everything else → text/plain only. There is no meaningful export for Slides,
// Forms, or future types, but text/plain recovers some structure and never
// produces an error.
{
  assert.deepEqual(exportMime("application/vnd.google-apps.document"), ["text/markdown", "text/plain"]);
  assert.deepEqual(exportMime("application/vnd.google-apps.spreadsheet"), ["text/csv", null]);
  // Slides and anything else: text/plain, no fallback.
  assert.deepEqual(exportMime("application/vnd.google-apps.presentation"), ["text/plain", null]);
  assert.deepEqual(exportMime("application/vnd.google-apps.form"), ["text/plain", null]);
  assert.deepEqual(exportMime("application/vnd.google-apps.unknown_future_type"), ["text/plain", null]);
}

// ── page size clamping ──────────────────────────────────────────────────────
// Default 25, max 100. Drive's own cap is 1000 but the compiled package capped
// at 100 to avoid dumping hundreds of file records into a model context.
{
  assert.equal(clampPageSize(undefined), 25);
  assert.equal(clampPageSize(null), 25);
  assert.equal(clampPageSize("50"), 25);     // non-number → default
  assert.equal(clampPageSize(NaN), 25);
  assert.equal(clampPageSize(0), 1);         // clamp to floor
  assert.equal(clampPageSize(-10), 1);
  assert.equal(clampPageSize(25), 25);
  assert.equal(clampPageSize(100), 100);
  assert.equal(clampPageSize(101), 100);     // clamp to ceiling
  assert.equal(clampPageSize(999), 100);
  assert.equal(clampPageSize(50.9), 50);     // truncates, not rounds
}

// ── parents helper ──────────────────────────────────────────────────────────
// An empty parents array is different from omitting the key: an empty array
// triggers a Drive validation error on some endpoints. So omit it, don't send [].
{
  assert.equal(parents(undefined), undefined);
  assert.equal(parents(null), undefined);
  assert.equal(parents(""), undefined);
  assert.deepEqual(parents("abc123"), ["abc123"]);
  assert.deepEqual(parents("folder_xyz"), ["folder_xyz"]);
}

// ── required params ─────────────────────────────────────────────────────────
{
  // Both tools list only "action" as required.
  assert.deepEqual(missingRequired("gdrive", {}), ["action"]);
  assert.deepEqual(missingRequired("gdrive", { action: "list" }), []);
  assert.deepEqual(missingRequired("gdrive_write", {}), ["action"]);
  assert.deepEqual(missingRequired("gdrive_write", { action: "create_doc" }), []);

  // null and "" are treated as missing — a model sending action:"" should not
  // dispatch to the switch's default-error path, which would produce a less
  // helpful message than the required-check.
  assert.deepEqual(missingRequired("gdrive", { action: null }), ["action"]);
  assert.deepEqual(missingRequired("gdrive", { action: "" }), ["action"]);

  // Unknown tool name is not a crash.
  assert.deepEqual(missingRequired("no_such_tool", {}), []);
}

console.log("ok — query escaping, native-mime detection, export-mime mapping, page clamping, parents and required-params hold");
