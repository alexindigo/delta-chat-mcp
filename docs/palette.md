# Globnotes palette provenance

The relay desk uses the default **Globnotes Light / Globnotes Dark** pair,
adapted from `globnotes/client/themes.js` (Copyright © 2026 Alex Indigo,
LGPL-3.0). Source read on 2026-10-25; SHA256:
`c5dd479016c868de1a572c9ce361b8648ec5da9597b31eb4d438d28c85374774`. The
accompanying `client/style.css` was consulted for semantic token use (SHA256
`5b3f3a92b207bf1cb11c69c05ffb48ce276981132fc8492b3c6cb3fe55e0dced`). No
framework, storage, event bus or theme-catalog code is imported.

| Role       | Light     | Dark      |
| ---------- | --------- | --------- |
| Background | `#ffffff` | `#22262c` |
| Elevated   | `#f3f4f5` | `#2c3139` |
| Text       | `#2c3139` | `#c1c7d0` |
| Brand      | `#0284c7` | `#38bdf8` |
| Muted      | `#8891a1` | `#8891a1` |
| Border     | `#eceef0` | `#5e6b80` |

`web/src/palette.ts` owns the raw pair and the port of Globnotes' `statusInk`
resolver: retain the preferred value when sufficient; otherwise blend in 255 RGB
steps toward whichever of black/white has the better minimum contrast across the
surfaces, taking the first sufficient step. Text, quiet and brand ink meet 4.5:1
on both backgrounds; control boundaries meet 3:1. Decorative dividers retain the
raw border. Filled-action labels are separately resolved against their actual
accent fill at 4.5:1. The modal veil uses the source dark background at 50%
opacity. Fonts, layout and focus dimensions are unchanged.

The theme capability owner applies these effective roles at runtime. CSS has the
exact same resolved values for both prepaint modes; an offline contract test
rejects drift. The existing pre-stylesheet bootstrap resolves only the
choice/mode and matching theme-color, before module execution. System/Light/Dark
IDs, live OS following and page-lifetime choice on storage failure are retained.
