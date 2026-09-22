; Import / declaration extraction for Java.
;
; Capture conventions used by analyzeMatches():
;   @name             the dotted name of an import (a scoped_identifier)
;   @wildcard         present for `import a.b.*;` (the trailing asterisk)
;   @import           marker capture naming the FileImport["kind"]; its text is the
;                     whole declaration, so `import static ...` is recognisable
;   @package          the dotted name of the `package a.b;` declaration
;   @top_type         a type declared directly in the file (not nested)
;   @type             a type declared anywhere in the file (top level or nested)
;
; One import pattern covers all three forms - `import a.b.C;`, `import static
; a.b.C.m;` and `import a.b.*;` - because the `static` keyword is an anonymous
; node the resolver does not need: a static import is resolved to the class by
; peeling trailing segments until a declared type matches. Comments and string
; literals are different node types, so imports "inside" them never match.
(import_declaration
  (scoped_identifier) @name
  (asterisk)? @wildcard) @import

(package_declaration [(scoped_identifier) (identifier)] @package)

(program
  [
    (class_declaration name: (identifier) @top_type)
    (interface_declaration name: (identifier) @top_type)
    (enum_declaration name: (identifier) @top_type)
    (record_declaration name: (identifier) @top_type)
    (annotation_type_declaration name: (identifier) @top_type)
  ])

[
  (class_declaration name: (identifier) @type)
  (interface_declaration name: (identifier) @type)
  (enum_declaration name: (identifier) @type)
  (record_declaration name: (identifier) @type)
  (annotation_type_declaration name: (identifier) @type)
]
