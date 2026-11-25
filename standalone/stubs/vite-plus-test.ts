// The workspace runs tests through vite-plus, whose `vite-plus/test` entry is `vitest` itself.
// The standalone harness installs vitest directly, so point that import at the package it has.
export * from "vitest";
