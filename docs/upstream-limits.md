# Upstream limits: @google/design.md v0.4.0

design-rails emits the DESIGN.md format and recommends the official CLI as a
verifier — pinned, because the spec is `alpha`. These behaviors were
live-verified against v0.4.0 on 2026-08-07 and shape how this tool uses it.
Re-verify on any upstream release.

1. **Empty frontmatter lints clean.** A file with NO token sections gets
   0 findings — identical to a fully compliant file. Lint-clean is necessary,
   never sufficient; `propose` refuses to emit a token-free file for exactly
   this reason, and `posture`'s `valid` check requires real colour tokens.
2. **The duplicate-heading rule is documented but not implemented.** The spec
   promises "Duplicate section heading → Error"; the shipped linter registers no
   such rule and passes duplicated sections silently.
3. **`export` silently drops typography `lineHeight`** in both the Tailwind and
   DTCG paths. `design/tokens/` written by `propose` is the lossless artifact;
   treat the CLI's export as colour-faithful only.
4. **`lint --format=text` is a no-op** — output is JSON regardless.

What the CLI does well (and why it stays in the loop): the WCAG AA
contrast-ratio rule is correctly implemented (verified in both directions),
broken token references are caught, and `diff` gives token-level regression
detection between versions of a file.

```bash
npx -y -p @google/design.md@0.4.0 designmd lint <app>/design/DESIGN.md
```
