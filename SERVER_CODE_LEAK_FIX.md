# TanStack Start Server Code Leak - Investigation & Fix

## Issue Summary

When running the dev server and loading the `/` route, the browser console displayed:

```
Module 'bun' has been externalized for browser compatibility. Cannot access 'bun.SQL' in client code.
```

This error occurred because server-only code (specifically `db.execute()` which imports from `bun`) was leaking into the client bundle.

## Reproduction

The issue was triggered by the `$getRandomSong` server function in `src/routes/index.tsx`:

```typescript
const authMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    return next({ context: { user: 1 } })
  },
)

const $getRandomSong = createServerFn({
  method: 'POST',
})
  .middleware([authMiddleware])
  .handler(async () => {
    await db.execute(sql`SELECT 1`)  // This imports from 'bun'
    return songs[Math.floor(Math.random() * songs.length)]
  })
```

**Key observation**: The error only occurred when middleware was attached to the server function. Without `.middleware([authMiddleware])`, the issue did not manifest.

## Investigation

### Understanding the Transform Pipeline

TanStack Start uses a multi-stage Vite plugin pipeline to handle server functions:

1. **Server Function Plugin** (`@tanstack/start-plugin-core`): Detects server functions and transforms them based on environment:
   - **Server/SSR environment**: Keeps the full handler implementation
   - **Client environment**: Replaces `.handler(fn)` with `.handler(createClientRpc('fn_id'))` - an RPC stub that calls the server

2. **Router Code Splitter** (`@tanstack/router-plugin`): Handles code splitting for routes:
   - **Reference file handler**: Transforms the main route file, creates lazy imports to virtual files
   - **Virtual file handler**: Extracts specific code (component, loader, etc.) into virtual modules

### Debug Logging Added

Added console logging to trace the transform pipeline:

```javascript
// In plugin.js
console.log(`[SERVER-FN-PLUGIN] Transform: ${id} env=${env} hasHandler=${code.includes('.handler(')}`);

// In router-code-splitter-plugin.js
console.log(`[ROUTER-SPLITTER] Code has .handler(: ${code.includes('.handler(')}`);
```

### Key Discovery

The logs revealed a critical discrepancy:

```
[SERVER-FN-PLUGIN] Transform: .../src/routes/index.tsx env=client hasHandler=false
[ROUTER-SPLITTER] Code has .handler(: true
```

The **same file** was showing `hasHandler=false` in the Server Function Plugin but `hasHandler=true` in the Router Code Splitter!

### Root Cause Identified

While the **original source code** has `.handler(` on the same line:

```typescript
const $getRandomSong = createServerFn({
  method: 'POST',
})
  .middleware([authMiddleware])
  .handler(async () => {
    // ...
  })
```

The code was being **reformatted during Vite's transform pipeline** before reaching the server function plugin. The code the plugin actually received was:

```javascript
const $getRandomSong = createServerFn({
  method: 'POST'
}).
middleware([authMiddleware]).
handler(async () => {
  await db.execute(sql`SELECT 1`);
  return songs[Math.floor(Math.random() * songs.length)];
});
```

Notice the reformatting: **the `.` was moved to the end of the previous line, and `handler(` is on a new line**!

This reformatting likely occurred during an earlier Babel transform or code generation step in Vite's pipeline.

The detection pattern in `compiler.js` was:

```javascript
const KindDetectionPatterns = {
  ServerFn: /\.handler\s*\(/,  // Only allows whitespace AFTER 'handler'
  // ...
};
```

This regex `/\.handler\s*\(/` requires `.handler(` to be contiguous (with optional whitespace only after `handler`). It does **not** match `.\nhandler(` where there's a newline between `.` and `handler`.

### Why Middleware Made It Worse

The intermediate reformatting that introduced the problematic line breaks appeared to be triggered by the method chaining complexity. Without middleware, the chain was simpler and didn't get reformatted. With middleware, the longer method chain was reformatted in a way that separated `.` from `handler(`.

## The Fix

### Location
`node_modules/@tanstack/start-plugin-core/dist/esm/start-compiler-plugin/compiler.js`

### Change
```diff
const KindDetectionPatterns = {
-  ServerFn: /\.handler\s*\(/,
+  ServerFn: /\.\s*handler\s*\(/,
  Middleware: /createMiddleware/,
  // ...
};
```

The updated regex `/\.\s*handler\s*\(/` allows whitespace (including newlines) **between** `.` and `handler`, not just after.

## Verification

After the fix, the transformed client code correctly shows:

```javascript
import { createClientRpc } from "@tanstack/react-start/dist/esm/client-rpc.js";

// ...

const $getRandomSong = createServerFn({
  method: 'POST'
})
  .middleware([authMiddleware])
  .handler(createClientRpc("eyJmaWxlIjoiL0BpZC9zcmMvcm91dGVzL2luZGV4LnRzeD90c3Mtc2VydmVyZm4tc3BsaXQiLCJleHBvcnQiOiIkZ2V0UmFuZG9tU29uZ19jcmVhdGVTZXJ2ZXJGbl9oYW5kbGVyIn0"));
```

Key points:
- `createClientRpc` is imported
- `.handler()` receives an RPC stub instead of the full server implementation
- `db.execute()` is **not** in the client bundle
- No more "Module 'bun' has been externalized" error

## Files Modified

| File | Change |
|------|--------|
| `node_modules/@tanstack/start-plugin-core/dist/esm/start-compiler-plugin/compiler.js` | Fixed regex pattern for ServerFn detection |

## Patch File

A bun patch has been created for easy application and sharing:

```
patches/@tanstack%2Fstart-plugin-core@1.143.6.patch
```

The patch is automatically applied on `bun install` via the `patchedDependencies` field in `package.json`:

```json
"patchedDependencies": {
  "@tanstack/start-plugin-core@1.143.6": "patches/@tanstack%2Fstart-plugin-core@1.143.6.patch"
}
```

## Upstream Fix Recommendation

This fix should be submitted to the `@tanstack/start` repository. The change is minimal and backwards-compatible:

```typescript
// In packages/start-plugin-core/src/start-compiler-plugin/compiler.ts

const KindDetectionPatterns = {
  ServerFn: /\.\s*handler\s*\(/,  // Allow whitespace between . and handler
  // ...
};
```

## Technical Details

### Transform Pipeline Flow

```
Original Route File
        │
        ▼
┌─────────────────────────────┐
│   Server Function Plugin    │  ← Detects .handler() patterns
│   (enforce: "pre")          │  ← Transforms for client/server env
└─────────────────────────────┘
        │
        ▼
┌─────────────────────────────┐
│   Router Code Splitter      │  ← Creates virtual files for code splitting
│   (enforce: "pre")          │  ← Extracts component/loader code
└─────────────────────────────┘
        │
        ▼
    Final Bundle
```

### Environment-Specific Transforms

| Environment | Handler Transform |
|-------------|-------------------|
| `ssr` (server) | Keeps full implementation |
| `client` | Replaces with `createClientRpc('fn_id')` |

### Pattern Detection

The `KindDetectionPatterns` object determines which files need transformation:

```javascript
const KindDetectionPatterns = {
  ServerFn: /\.\s*handler\s*\(/,      // .handler( with optional whitespace
  Middleware: /createMiddleware/,      // createMiddleware function calls
  IsomorphicFn: /createIsomorphicFn/,  // createIsomorphicFn calls
  // ...
};
```

## Conclusion

The bug was a subtle regex pattern issue that only manifested when code formatting introduced line breaks in method chains. The fix ensures that server function handlers are properly detected regardless of whitespace/newline formatting, preventing server-only code from leaking into client bundles.
