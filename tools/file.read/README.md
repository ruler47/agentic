# file.read (in-process built-in)

> **Status:** in-process — runs inside the runtime app process, not as a docker
> service. Implementation lives in `src/tools/fileTools.ts`.

## What it does
Reads a UTF-8 text file from the agent workspace volume mounted at
`FILE_TOOL_ROOT` (defaults to `/app/workspace`). Path traversal is rejected.

## Registered as
```
name:        file.read
version:     1.0.0
capabilities: file-read, coding, documents
startup:     on-demand
input:       { path: string (relative to workspace root) }
output:      { ok, content }
```

## Implementation
- File: `src/tools/fileTools.ts`
- Registered in: `src/server/persistence/persistence.module.ts`
- Workspace mount: `FILE_TOOL_ROOT` (compose `./workspace:/app/workspace`).

## Future
Will eventually be promoted to `tools/file-read-service/` (mirroring
`browser-operate-service`) once volume-mount semantics are settled for
container-to-container shared workspaces.
