# License inputs

The release builder copies exact installed npm license/notice texts and records
their package versions and hashes in `licenses/inventory.json`. Missing npm
texts are supplied from the authoritative sources identified by
`scripts/release/notices.ts`, never inferred from an SPDX label alone.

Native core and Deno source/license inputs are pinned by version and content
checksum. The generated native inventory conservatively includes all registry
crates in their matching Cargo.lock files, including platform/build
dependencies; it is not a claim that every listed crate is linked into the
executable.

Generated files belong in the build output, not this source directory. See
`THIRD-PARTY-NOTICES.md` for provenance and replacement/rebuild instructions.
