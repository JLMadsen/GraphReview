// Ambient module declarations for the Cytoscape plugins that ship with no
// types of their own (`cytoscape-fcose`, `cytoscape-expand-collapse`,
// `cytoscape-elk`). Kept local to this directory since it's the only
// consumer.
//
// Deliberately no top-level `import`/`export` anywhere in this file: as
// soon as a `.d.ts` file has one, TS treats it as a module rather than a
// global script, and a *shorthand* (bodiless) `declare module "x";`
// statement — the form TS's own TS7016 error message recommends for a
// package that resolves to a real, type-less .js file — then only shims
// that specifier locally instead of project-wide, so the "Could not find a
// declaration file" error comes right back. Keeping this a script file (no
// imports) is what makes the shorthand declarations actually global.
//
// The `Core` augmentation for these plugins' instance methods
// (`cy.expandCollapse(...)`) lives in the sibling
// cytoscape-augment.d.ts instead: augmenting an *existing* typed module
// needs the opposite — a file that TS treats as a module (has an
// import/export) — so the two can't share one file.
declare module "cytoscape-fcose";
declare module "cytoscape-expand-collapse";
declare module "cytoscape-elk";
