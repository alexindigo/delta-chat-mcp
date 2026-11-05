# Third-party notices and corresponding source

delta-chat-mcp is LGPL-3.0-only. The accompanying `LICENSE` is the project
license. Generated `licenses/` contains original dependency license and notice
texts with a versioned, SHA-256 inventory. Original license texts are retained
verbatim, including their original character sets.

For declaration-only upstream distributions, the inventory preserves the exact
manifest and any inline source notices, and separately labels standard SPDX
license texts. These templates are not upstream copyright notices; no holder or
year is inferred. `licenses/PROVENANCE.md` explains the generated categories and
the pinned authoritative standard-text source.

| Component                                           | Version                  | License / source                                             |
| --------------------------------------------------- | ------------------------ | ------------------------------------------------------------ |
| Deno runtime                                        | 2.9.6                    | MIT; <https://github.com/denoland/deno/tree/v2.9.6>          |
| Delta Chat native core and RPC client               | 2.65.0                   | MPL-2.0; <https://github.com/chatmail/core/tree/v2.65.0>     |
| Pathfinder                                          | 0.2.4                    | LGPL-3.0-only; <https://jsr.io/@pathfinder/pathfinder/0.2.4> |
| Deno standard modules                               | Versions in deno.lock    | MIT; exact JSR versioned license texts                       |
| Atkinson Hyperlegible                               | Fontsource 5.2.8         | OFL-1.1; original notice in npm package                      |
| IBM Plex Mono                                       | Fontsource 5.2.7         | OFL-1.1; original notice in npm package                      |
| npm application, integration and build dependencies | Exact deno.lock versions | Original texts and provenance in generated inventory         |

The self-extracting compiler preserves the installed npm layout. Its payload can
therefore include build dependencies as well as runtime dependencies. The
inventory covers the installed payload conservatively; it does not relabel
third-party components under the project's license. Rust dependency notices are
collected from checksum-verified registry source archives selected by the
matching upstream lockfiles. Debian image system-library copyrights remain under
`/usr/share/doc/` in the image.

## Source and replacement

Matching application source, build scripts, integration source and lockfile are
available beside the downloads at
<https://github.com/alexindigo/delta-chat-mcp/releases/tag/v0.1.0> (the matching
`v0.1.0` source tag). The source download is free. Pathfinder's exact source is
available at <https://jsr.io/@pathfinder/pathfinder/0.2.4>; the upstream
repository is <https://github.com/alexindigo/pathfinder>. Core source, including
its Cargo.lock and native build instructions, is available at
<https://github.com/chatmail/core/tree/v2.65.0>. No core modifications are made.

You may modify or replace the LGPL components and reverse engineer the combined
work for debugging those modifications. With the matching source and Deno2.9.6,
edit the application or select a modified Pathfinder source in `deno.json`,
update the lockfile deliberately, then run the documented release build. The
same build scripts recombine the modified code into a replacement executable.
Install that executable in place of the original while the service is stopped;
keep the complete external state directory. No signing key, vendor activation or
authorization token is required to run your rebuilt version. For a modified
core, build its same-version stdio server and replace the native package input
before recompiling; the normal package layout/resolver remains in use.

See `docs/release.md` for exact build and installation commands, extraction
ownership and the artifact's measured dynamic ABI requirements. The executable
is application-self-contained, not a fully static ELF.

The factual public relay hostname/homepage snapshot comes from
<https://chatmail.at/relays>, retrieved2026-10-25. Website prose/artwork is not
redistributed and no site-wide license is asserted.
