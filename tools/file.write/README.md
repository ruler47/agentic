# file.write (in-process built-in)

> **Status:** in-process — runs inside the runtime app process, not as a docker
> service. Implementation lives in `src/tools/fileTools.ts`.

## What it does
Writes a UTF-8 text file inside the agent workspace volume. Creates parent
directories if needed. Path traversal is rejected.

## Registered as
```
name:        file.write
version:     1.0.0
capabilities: file-write, coding, documents
startup:     on-demand
input:       { path: string, content: string }
output:      { ok, content (status), data: { path, sizeBytes } }
```

## Implementation
- File: `src/tools/fileTools.ts`
- Registered in: `src/server/persistence/persistence.module.ts`
- Workspace mount: `FILE_TOOL_ROOT` (compose `./workspace:/app/workspace`).

## Future
Will eventually be promoted to `tools/file-write-service/` (mirroring
`browser-operate-service`).
