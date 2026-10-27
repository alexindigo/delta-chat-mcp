# Globnotes palette provenance

The relay desk retains all **15 concrete palettes**. The picker offers System as
the single default entry (**Default Light / Default Dark** previews), plus 13
schemes in six named families, adapted from `globnotes/client/themes.js`
(Copyright © 2026 Alex Indigo, LGPL-3.0). Source read on 2026-10-26; SHA256:
`c5dd479016c868de1a572c9ce361b8648ec5da9597b31eb4d438d28c85374774`. The
accompanying `client/style.css` was consulted for semantic token use (SHA256
`5b3f3a92b207bf1cb11c69c05ffb48ce276981132fc8492b3c6cb3fe55e0dced`). No
framework, storage or event bus code is imported. The local catalog carries
exact source IDs, variant metadata and only these six consumed raw roles. Source
`background-elevated` maps to `elevated`, `text-muted` to `muted`.
Code/status/shadow roles not used by this product are not carried. The source
base pair's public labels are Default Light / Default Dark; Globnotes remains
its provenance, not a separate picker family. The palette owner defines one
default-role predicate and selectable projection for groups, keyboard IDs,
selected indicator and focus mapping.

The picker adapts source `client/components/AppearanceSettingsPage.vue`
keyboard, grouping and selected-marker semantics (SHA256
`a1e4697939b7167f6f457ae5c975e04ad8b59ac0a0c7b8150f3f407bdda1d5a6`).
`client/components/settings/ThemeNotePreview.vue` (SHA256
`d4df664633618412ca6e3e8d8626984bd6f632b5b4f3923add0db809ac21b6ca`) informs
values-only preview composition; relay previews show a conversation.

| Role       | Light     | Dark      |
| ---------- | --------- | --------- |
| Background | `#ffffff` | `#22262c` |
| Elevated   | `#f3f4f5` | `#2c3139` |
| Text       | `#2c3139` | `#c1c7d0` |
| Brand      | `#0284c7` | `#38bdf8` |
| Muted      | `#8891a1` | `#8891a1` |
| Border     | `#eceef0` | `#5e6b80` |

`web/src/palette.ts` owns the raw catalog and the port of Globnotes' `statusInk`
resolver: retain the preferred value when sufficient; otherwise blend in 255 RGB
steps toward whichever of black/white has the better minimum contrast across the
surfaces, taking the first sufficient step. Text, quiet and brand ink meet 4.5:1
on both backgrounds; control boundaries meet 3:1. Decorative dividers retain the
raw border. Filled-action labels are separately resolved against their actual
accent fill at 4.5:1. The modal veil uses the source dark background at 50%
opacity. Fonts, layout and focus dimensions are unchanged.

Raw brand remains distinct from readable accent; previews and runtime share the
same effective palette resolver. The theme capability owner alone owns browser
storage, media-query subscription and document updates, publishing choice,
concrete ID, mode, label and live System label to the controller/view.

Static CSS covers every concrete ID via `html[data-theme]`; head metadata
resolves ID/mode/background before styles or module execution. Contract tests
reject drift between catalog, CSS, head and previews; native module-blocked
paint probes inspect actual computed colors. Legacy saved `light`/`dark`
normalize to the concrete default pair without rewriting storage on read. Saved
`globnotes-light`/`globnotes-dark` likewise stay fixed, ignoring OS changes.
Their sole selected tile and focus target is System, with honest saved-fixed
copy and an explicit invitation to select System to follow the device.
Activating it writes `system`; there is no automatic migration. Other explicit
selections write canonical IDs. Invalid values resolve to System; storage denial
retains a page-lifetime choice. System remains System and follows OS live;
explicit names ignore OS changes.
