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

## Plain-CSS apps (no Tailwind, no build step)

Same pipeline, simpler mechanics, two different traps. Exercised end-to-end
on a real plain-CSS React app (single stylesheet, 84 literals, 29 migrated).

1. **Tokens land in a `:root` block** at the top of the main stylesheet (or
   a new `styles/tokens.css` imported first). Name them `--color-<primitive>`
   straight from design/tokens/color.json.
2. **Exact-value substitution only, with a hex boundary guard.** Replace a
   literal with `var(--color-x)` ONLY where the value is byte-equal to the
   token's, case-insensitively, and terminate the match at a non-hex
   character: `#fff` must never eat `#fffefa`.
3. **Near-identical variants stay put.** Folding a #fbf9f1 into a #f3ede2
   canvas CHANGES shipped colour — that is a decide record, not a migration.
   Migrate the exact matches; the collapse pass belongs to the human.
4. **Verification without a build.** Exact-value substitution is
   value-identical by construction, so prove hygiene instead: re-scan and
   require zero unresolved tokens (every `var()` must resolve) plus the
   count arithmetic (before − migrated = after, allowing for literals that
   moved onto token-definition lines, which stop counting).
5. **Trap: tokens declared in the app's main stylesheet** (`styles.css`
   opening with `--bg: …`) are NOT recognized as declared tokens —
   token-file detection keys on file naming and declaration density, and an
   app's whole stylesheet qualifies as neither. propose will derive fresh
   names alongside the existing ones. Either move existing tokens into a
   file named `tokens.css`/`globals.css` first, or expect renames and
   migrate the old names too.
