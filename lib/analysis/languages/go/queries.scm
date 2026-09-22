; Import extraction for Go.
;
; Capture conventions used by collectImports():
;   @specifier        the import path, quotes stripped
;   @import           marker capture naming the FileImport["kind"]
;
; Covers `import "x"`, grouped `import ( ... )`, and aliased / dot / blank
; imports (`import a "x"`, `import . "x"`, `import _ "x"`) - the alias lives in
; the spec's `name:` field, which is irrelevant for a file-level edge. Both
; interpreted ("x") and raw (`x`) string literals are legal import paths.
; Comments and strings that merely *contain* an import are different node
; types, so they never match.
(import_spec
  path: [(interpreted_string_literal (interpreted_string_literal_content) @specifier)
         (raw_string_literal (raw_string_literal_content) @specifier)]) @import
