# Migrating colour literals onto tokens

The scan's job ends at measurement; migration is a separate, human-reviewed
change. This is the method that made the first production migration (87 sites)
value-identical, kept here so the next one starts from recipes instead of
re-discovery. Work from `scan --json --full` — every hit in
`findings.color.sites` carries a `ctx` class, and the class decides the
substitution.

## Substitution by context class

| ctx | Substitution | Why it is safe / unsafe |
| --- | --- | --- |
| `utility` | `-[#hex]/N` → `-token/N` | Tailwind v4 generates the utility family (all opacity modifiers included) from any `--color-*` token in `@theme` |
| `css-value` | literal → `var(--token)` | plain CSS value position — custom properties resolve |
| `style-attr` | literal → `var(--token)` | inline styles resolve custom properties, in HTML and SVG alike |
| `prop` | READ THE CONSUMER first | a prop injected into CSS (gradients, `color-mix`) takes `var()`; a prop reaching canvas `fillStyle` renders NOTHING with `var()` — silently |
| `svg-attr` | move to `style="fill: var(--token)"` or CSS | `fill="var(--x)"` as a presentation attribute is invalid and paints black |
| `string` | assume the code does math on it | hex+alpha concat (`` `${C}40` ``) breaks with a `var()` value — convert the MATH, not the constant: `` `color-mix(in srgb, ${C} 25%, transparent)` `` (alpha byte → percent: `0x40`→25%, `0x1a`→10%, `0x4d`→30%) |

A constant (`const ACCENT = '#hex'`) is only var-safe after every one of its
uses is: fix the `string`-class uses first, then swap the constant.

## Minting the token

Add the brand token to the `@theme` under a namespaced `--color-<brand>` name
(that is what makes Tailwind generate the utilities), and point any legacy
alias (`--primary`) at it with `var()` — one hop, which the scanner resolves.

## Proof checklist — done means all four

1. Typecheck and production build pass.
2. The BUILT css contains the generated utilities (`grep '\.text-<tok>' dist/…`).
3. The built css resolves each modifier to the SAME value the literal had.
   Tailwind v4 emits `color-mix(in srgb, <literal> N%, transparent)` plus an
   `@supports`-gated oklab/var() form; a minifier that constant-folds the srgb
   branch (lightningcss does) leaves a bare `#39ff14cc`-style hex+alpha in the
   artifact. Either way the check is the same: the literal (or folded hex) and
   the percent must match the original alpha byte — that resolved value IS the
   value-identity proof.
4. Re-run the scan: the count dropped by exactly the migrated sites, and every
   remaining literal is either in another brand's scope or recorded in
   REVIEW.md with the reason it stays (canvas, gradient intent, pending token).

Then tighten: `--tighten` snaps the budgets to the new actuals in the same PR.
Commit the migration BEFORE any rebase — a rebase over a squash-merged base
conflicts, autostashes uncommitted work, and a tighten run in that limbo
measures the pre-migration tree with total confidence (this happened; the
provenance line in scan output exists because of it).
