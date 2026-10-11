# Local packaging evidence — 2026-10-11

Implemented prerequisite, production availability remains blocked. No VM, live
Winter app/daemon/home, Keychain, credential or host-pressure workload was used.

## Verified dependency stage

```sh
python3 -m unittest discover -s apple/Cowork/packaging -p 'test_*.py'
python3 apple/Cowork/packaging/build.py --dependencies-only \
  --source-cache apple/Cowork/packaging/out/source-inspect --jobs 4
python3 apple/Cowork/packaging/closure.py \
  apple/Cowork/packaging/out/build-nzn18phm/bundle/lib
python3 apple/Cowork/packaging/build.py --dependencies-only \
  --dependency-bundle apple/Cowork/packaging/out/build-nzn18phm/bundle --jobs 4
```

Seven closure/environment/cache tests pass. The original from-source bundle is
`out/build-nzn18phm/bundle`; its manifest records exact archive pins, build
commands/options/logs, toolchain, source/notices/build-material hashes and
`components: dependencies-only`. GLib, gettext-runtime libintl and PCRE2 were
configured, compiled and installed into this invocation's private prefix.
GLib's optional fallback downloads are disabled; pkg-config sees only the
private libraries and explicit Apple SDK system metadata.

All three runtime libraries are arm64. `otool` for every library records only
`@loader_path` sibling references and Apple system libraries/frameworks. There
are no Homebrew or temporary build-prefix load commands and no rpaths.
Versioned dylib SONAMEs and the unversioned linker aliases are retained.

| Runtime dylib | SHA256 |
| --- | --- |
| `libglib-2.0.0.dylib` | `61d26721f05b546a3aefcc3363807bc3b9a7d9ad457679493a0db2554ab8e75e` |
| `libintl.8.dylib` | `74ca236469c251c7e12f6ab2e6a3bda191a2f0691cad69925d932c4e00d8f541` |
| `libpcre2-8.0.dylib` | `dfe85dcea7a1c726ff12e9e4c8000a94e8040b9541c0dd34e9bdfc39e0f64aab` |

The final from-source dependency stage completed in 154 seconds and its
relocated C smoke passed. Its log
`out/build-nzn18phm/logs/19-relocated-dependency-smoke.log` reports:

```json
{"relocatedDependencies":true,"glib":"2.90.0","libintl":"1.0","pcre2":"10.49"}
```

The smoke asserts the actual runtime versions, matches a bounded GLib regex
through the shared PCRE2 library, and calls gettext under the C locale. It loads
libraries from a copied directory with loader/search injection variables
removed; it performs no network request. Re-export modifies only fresh copies.
Verified cache import/re-export also passed using the earlier source-built
`out/build-w02gqv9w/bundle`, producing `out/build-u2lrjeqo/bundle`. The
source-built originals remain unchanged. The current source-built cache for
future packaging is `out/build-nzn18phm/bundle`.

## Verified libslirp provenance mechanism

```sh
python3 apple/Cowork/packaging/libslirp_provenance.py \
  --destination apple/Cowork/packaging/out/libslirp-provenance-initial4 \
  --upstream-checkout apple/Cowork/packaging/out/libslirp-upstream-9nc0wfan
```

The clean upstream checkout was fetched from the primary libslirp GitLab
repository at commit `390848f47391f412451b2d259d8527fabb51e5e3`; its Git tree is
`0509386ab50c032b58f5af4576f8ee5f79157c51`. The script retains a complete upstream
archive, computes per-file vendor hashes, generates a binary-capable patch and
verifies that applying it reconstructs the exact vendored tree. This initial
artifact predates ongoing network review fixes; its vendor/patch hashes are
historical and must be regenerated for the final reviewed package. The script
does not edit the vendor sources. Git identity verification does not establish
a verified publisher signature.

## Pending

Controller/Node-API and network Swift products, their relocated fake/synthetic
smokes, and final libslirp provenance are deferred while review fixes modify
those sources. The recipe's `--dependency-bundle` option permits packaging a
fresh reviewed source snapshot without repeating the dependency source build.
The approved verified-EOF Containerization build profile must also be wired to
its fixed prepare/verify helper and included in the artifact graph once that
helper is supplied by the native owner. Production team signing, hardened
compiled-Bun loading, replacement/relinking
policy, CI provenance, notarization, app integration and all VM/authority
feasibility gates remain open. This evidence does not authorize enabling Cowork.
