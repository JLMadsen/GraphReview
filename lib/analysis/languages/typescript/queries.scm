; Import/require extraction for JavaScript, TypeScript, JSX and TSX.
;
; Capture conventions used by collectImports():
;   @specifier        the module specifier text (string fragment, quotes stripped)
;   @import/@require/@call   marker capture naming the FileImport["kind"]
;   @_*               internal captures, only used by predicates

; Static ESM import:  import x from "./a"   |   import "./side-effect"
(import_statement
  source: (string (string_fragment) @specifier)) @import

; Re-export from another module:  export { a } from "./a"   |   export * from "./a"
(export_statement
  source: (string (string_fragment) @specifier)) @import

; TypeScript import-equals:  import fs = require("node:fs")
(import_require_clause
  source: (string (string_fragment) @specifier)) @require

; Dynamic import:  await import("./a")
(call_expression
  function: (import)
  arguments: (arguments (string (string_fragment) @specifier))) @call

; CommonJS:  require("./a")
(call_expression
  function: (identifier) @_fn
  arguments: (arguments (string (string_fragment) @specifier))
  (#eq? @_fn "require")) @require
