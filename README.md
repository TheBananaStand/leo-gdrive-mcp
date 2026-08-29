# leo-gdrive-mcp

Google Drive as Leo tools, over MCP — create, read, update, and list
Leo-created files, with Docs exported as Markdown and Sheets as CSV.

This is a port of the compiled `leo-gdrive` package. It provides two tools:

| Tool | Actions |
|---|---|
| `gdrive` | `list`, `read`, `metadata` |
| `gdrive_write` | `create_doc`, `create_sheet`, `upload`, `update`, `mkdir` |

## Drive scope

Both tools operate under the `drive.file` scope. Leo can only see files it
created — it cannot browse or search the user's existing Drive. This is a
deliberate restriction, not a limitation to work around.

## Token delivery

This package is tool-driven, not provider-driven. The hub injects a single-use
grant handle (`_oauth_grant`) into every tool call. The server exchanges it for
a Google access token once per invocation:

```
POST {LEO_API_URL}/graph/v1/oauth/exchange
Authorization: Bearer {LEO_PACKAGE_TOKEN}
body: {"grant": "<_oauth_grant value>"}
-> 200 {"access_token": "..."}
```

A missing `_oauth_grant` means the user has not connected their Google account,
or this package is not in their allowed packages. The hub withheld the grant
deliberately — the right response is a clear error, not a retry.

## Reading files

`read` detects the file's MIME type first and then either exports or downloads:

- **Google Docs** — exported as Markdown, with a text/plain fallback for
  accounts where Markdown export returns 400.
- **Google Sheets** — exported as CSV.
- **Everything else** — downloaded raw. Binary files report their byte count
  rather than returning mojibake.

## Writing files

`create_doc` and `create_sheet` use Drive's multipart upload with the
corresponding Google-native MIME type in the metadata; Drive converts the
plain-text or CSV body on ingest. `upload` stores a file as-is. `update`
replaces the media of an existing file using a PATCH request.

The multipart boundary is random per call so document content cannot collide
with it and corrupt the upload.

## Development

```bash
npm install
node test.js        # no network needed
```

The test covers what fails quietly:

- **Query escaping.** A name with `'` or `\` in a Drive `q` clause breaks the
  query or allows injection. `escapeQ` escapes both, and the test verifies both
  in isolation and combined.
- **Native MIME detection.** Getting this wrong means attempting a raw download
  of a file with no binary body, which Drive rejects. The test covers the
  full `application/vnd.google-apps.*` prefix and confirms non-Google types
  are rejected.
- **Export MIME mapping.** Docs have a fallback (Markdown can 400); Sheets do
  not. The test pins every case including unknown future types.
- **Page size clamping.** Default 25, max 100. Non-numbers, NaN, and out-of-range
  values are all tested.
- **Parents helper.** An empty array and an absent key mean different things to
  Drive; omit the key when there is no folder.

## Publishing

```bash
./store/publish.sh          # live
./store/publish.sh draft    # stage for review at admin.leoconnect.io
```

Needs a Cloudflare login with `D1:Edit` on the `leo-store` database.
