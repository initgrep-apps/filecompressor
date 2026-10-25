# One icon set: Lucide, through shadcn

Every icon in `src/` renders from `lucide-react`. `@remixicon/react` is gone: no imports, no dependency, and `components.json` declares `iconLibrary: lucide`. Two icon sets meant two stroke weights, two sizing conventions and two migration paths for the same shadcn primitives; the slice cost 27 files once, and every future component would have kept paying it.

## Considered Options

- **Lucide only (chosen)** — matches `iconLibrary: lucide`, what shadcn's own component sources import, and the only set the CLI migrates to.
- **Keep Remix under shadcn** — needs a bespoke mapping for every new primitive; stroke and optical weight drift between app and shadcn icons stays.
- **Both, per-component preference** — no rule decides the choice, so the split silently re-forms.

## Consequences

- Where the Remix glyph and shadcn's canonical Lucide glyph disagree, shadcn wins: sonner uses `OctagonX` and `TriangleAlert`, not the closer `CircleX`/`CircleAlert`. Similar icons look slightly less like their Remix ancestors; toasts stay consistent with the rest of shadcn.
- No Lucide `FileShield` exists, so the brand mark is `FileLock2`.
- Never run `shadcn apply` or `init --preset b3T38WTmL`: that preset still resolves `iconLibrary: remixicon` and reverts the whole tree.
- New icons are bare `lucide-react` imports; the `*Icon` alias suffix is not used.
