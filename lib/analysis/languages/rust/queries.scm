; Import extraction for Rust.
;
; Capture conventions used by collectImports():
;   @name         module / crate name
;   @path         value of a `#[path = "..."]` attribute
;   @use          the whole use-tree of a `use` declaration (expanded in TS:
;                 brace lists, globs and aliases are flattened by expandUseTree)
;   @inline_use   the same, but the declaration sits directly inside an inline
;                 `mod x { ... }` block, where `super` means the enclosing file's
;                 module rather than its parent
;   @mod/@pathmod/@extern/@use... marker captures naming the pattern's meaning
;
; Comments, strings and macro bodies never match: they are not `use_declaration`
; / `mod_item` nodes.

; Out-of-line module:  mod foo;   |   pub mod foo;   (inline `mod foo { .. }` has a body)
(source_file
  (mod_item name: (identifier) @name !body) @mod)

; Out-of-line module with an explicit file:  #[path = "x.rs"] mod foo;
; (other attributes may sit between the two, e.g. #[cfg(test)])
(source_file
  (attribute_item
    (attribute
      (identifier) @_attr
      value: (string_literal (string_content) @path)))
  .
  (attribute_item)*
  .
  (mod_item name: (identifier) @name !body) @pathmod
  (#eq? @_attr "path"))

; use crate::a::b;  |  use a::{b, c::d};  |  pub use a::*;  |  use a as b;
(use_declaration argument: (_) @use)

; Same declarations, when directly inside an inline module (deduplicated
; against the pattern above in collectImports).
(mod_item
  body: (declaration_list
    (use_declaration argument: (_) @inline_use)))

; extern crate serde;  |  extern crate foo as bar;
(extern_crate_declaration name: (identifier) @name) @extern
