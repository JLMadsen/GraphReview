; Import extraction for Python.
;
; Capture conventions used by collectImports():
;   @module           the module specifier (dotted name, possibly dot-prefixed
;                     for relative imports)
;   @name             an imported name, which *may* itself be a submodule
;   @import/@submodule/@call   marker capture naming the pattern's meaning
;   @_*               internal captures, only used by predicates

; import os  |  import os.path as p  |  import a.b, c  (one match per name)
(import_statement
  name: [(dotted_name) @module
         (aliased_import name: (dotted_name) @module)]) @import

; from a.b import x  |  from . import x  |  from .a import *
; — the module itself is always a dependency
(import_from_statement
  module_name: [(dotted_name) @module
                (relative_import) @module]) @import

; from a.b import x  — `x` may be the submodule a.b.x rather than a symbol.
; Marked speculative: kept only when it resolves to a real file.
(import_from_statement
  module_name: [(dotted_name) @module
                (relative_import) @module]
  name: [(dotted_name) @name
         (aliased_import name: (dotted_name) @name)]) @submodule

; importlib.import_module("a.b")
(call
  function: (attribute
    object: (identifier) @_obj
    attribute: (identifier) @_attr)
  arguments: (argument_list (string (string_content) @module))
  (#eq? @_obj "importlib")
  (#eq? @_attr "import_module")) @call
