import Foundation

/// CLAUDE'S "PREAPPROVED HOSTS" LIST FOR `WebFetch` — the Swift mirror of the agent SDK's
/// `packages/runtime/src/web/preapproved-hosts.ts`, which extracted the 92 literals (91 distinct —
/// `learn.microsoft.com` is listed twice in the source array — 9 of them path-scoped) from the pinned
/// claude binary. Kept in the SDK's own source order so a future re-extraction diffs cleanly.
///
/// THE LIST HAS THREE EFFECTS IN CLAUDE, AND THIS ENGINE CARRIES TWO OF THEM:
///   1. **permissive quoting guidelines** on the digest pass — carried (`WebFetchTool`);
///   2. **verbatim markdown passthrough** under 100,000 characters, skipping the digest model
///      entirely — carried (`WebFetchTool`);
///   3. **auto-allow** in the permission layer — MOOT here and deliberately absent. Chat never
///      prompts for anything (the standing user rule), so there is no approval to skip: a public
///      fetch is already free, and the two floors this engine does keep (the dangerous-domain list
///      and the private-address deny) are floors no allow-list may lift, preapproved or not.
///
/// The scope machinery (`scopeOf`/`staysWithinScope`) is carried because the REDIRECT WALK needs it:
/// a hop that leaves a preapproved PATH scope must not be auto-followed even when it stays on the
/// same host.
enum PreapprovedHosts {
    /// The 92 literals exactly as they appear in the binary's own `c7t` source order.
    static let entries: [String] = [
        "platform.claude.com",
        "code.claude.com",
        "claude.com/docs",
        "modelcontextprotocol.io",
        "github.com/anthropics",
        "agentskills.io",
        "docs.python.org",
        "en.cppreference.com",
        "docs.oracle.com",
        "learn.microsoft.com",
        "developer.mozilla.org",
        "go.dev/doc",
        "go.dev/ref",
        "www.php.net",
        "docs.swift.org",
        "kotlinlang.org",
        "ruby-doc.org",
        "doc.rust-lang.org",
        "www.typescriptlang.org",
        "react.dev",
        "angular.io",
        "vuejs.org",
        "nextjs.org",
        "expressjs.com",
        "nodejs.org",
        "bun.sh",
        "jquery.com",
        "getbootstrap.com",
        "tailwindcss.com",
        "d3js.org",
        "threejs.org",
        "redux.js.org",
        "webpack.js.org",
        "jestjs.io",
        "reactrouter.com",
        "docs.djangoproject.com",
        "flask.palletsprojects.com",
        "fastapi.tiangolo.com",
        "pandas.pydata.org",
        "numpy.org",
        "www.tensorflow.org",
        "pytorch.org",
        "scikit-learn.org",
        "matplotlib.org",
        "requests.readthedocs.io",
        "jupyter.org",
        "laravel.com",
        "symfony.com",
        "wordpress.org/documentation",
        "docs.spring.io",
        "hibernate.org",
        "tomcat.apache.org",
        "gradle.org",
        "maven.apache.org",
        "asp.net",
        "dotnet.microsoft.com",
        "blazor.net",
        "reactnative.dev",
        "docs.flutter.dev",
        "developer.apple.com",
        "developer.android.com",
        "keras.io",
        "spark.apache.org",
        "huggingface.co/docs",
        "www.kaggle.com/docs",
        "www.mongodb.com",
        "redis.io",
        "www.postgresql.org",
        "dev.mysql.com",
        "www.sqlite.org",
        "graphql.org",
        "prisma.io",
        "docs.getdbt.com",
        "docs.aws.amazon.com",
        "cloud.google.com",
        "learn.microsoft.com",
        "kubernetes.io",
        "www.docker.com",
        "www.terraform.io",
        "www.ansible.com",
        "vercel.com/docs",
        "docs.stripe.com",
        "docs.netlify.com",
        "devcenter.heroku.com",
        "dev.wix.com/docs",
        "cypress.io",
        "selenium.dev",
        "docs.unity.com",
        "docs.unrealengine.com",
        "git-scm.com",
        "nginx.org",
        "httpd.apache.org",
    ]

    /// The registered entry that matched a url. `pathPrefix` is `nil` for a hostname-only entry.
    struct Match: Equatable, Sendable {
        let host: String
        let pathPrefix: String?
    }

    /// `c7t`'s own `HOSTNAME_ONLY` half: entries with no `/`, as an exact-match set.
    private static let hostnameOnly: Set<String> = {
        Set(entries.filter { !$0.contains("/") })
    }()

    /// `c7t`'s own `PATH_PREFIXES` half: hostname → every path prefix registered for it.
    private static let pathPrefixes: [String: [String]] = {
        var map: [String: [String]] = [:]
        for entry in entries {
            guard let slash = entry.firstIndex(of: "/") else { continue }
            let host = String(entry[entry.startIndex ..< slash])
            let prefix = String(entry[slash...]) // keeps the leading "/"
            map[host, default: []].append(prefix)
        }
        return map
    }()

    /// claude's own encoded-slash/backslash/dot guard on the PATH half, verbatim (`/%(25)*(2f|5c|2e)/i`)
    /// — exactly the traversal class that would otherwise let `/docs%2f..%2fadmin` read as a
    /// legitimate child of `/docs`.
    private static func hasEncodedTraversal(_ pathname: String) -> Bool {
        pathname.range(of: "%(25)*(2f|5c|2e)", options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// `wX(hostname, pathname)`, verbatim: an EXACT hostname match (no subdomains) against the
    /// hostname-only half, OR a hostname with a registered path prefix whose pathname is that prefix
    /// or a `/`-bounded child of it.
    ///
    /// `pathname` must ALREADY be WHATWG-shaped — percent-encoded and dot-segment-collapsed. Every
    /// in-kit caller goes through `standardizedPath`, which is what produces that; a raw
    /// `URL.path` here would reopen the scope escape that function's header documents.
    static func isPreapproved(host: String, pathname: String) -> Bool {
        if hostnameOnly.contains(host) { return true }
        guard let prefixes = pathPrefixes[host] else { return false }
        if hasEncodedTraversal(pathname) { return false }
        return prefixes.contains { pathname == $0 || pathname.hasPrefix("\($0)/") }
    }

    static func isPreapproved(_ url: URL) -> Bool {
        isPreapproved(host: WebFetchURL.bareHost(url), pathname: standardizedPath(url))
    }

    /// The scope's own host, that host with a leading `www.` stripped, and that stripped form with
    /// `www.` re-added — the SAME three-way set `staysWithinScope` applies, deduplicated.
    private static func candidateHosts(_ hostname: String) -> [String] {
        let stripped = hostname.hasPrefix("www.") ? String(hostname.dropFirst(4)) : hostname
        var seen: [String] = []
        for candidate in [hostname, stripped, "www.\(stripped)"] where !seen.contains(candidate) {
            seen.append(candidate)
        }
        return seen
    }

    /// The registered entry that matched `url`, distinguishing a bare hostname match from a
    /// path-scoped one so the redirect walk can ask "does the hop's own path still fall under the SAME
    /// scope" rather than only "is this host preapproved at all."
    ///
    /// HOSTS are matched the same three-way way `staysWithinScope` does (an SDK security-review fix,
    /// carried): an exact-only match here made a `claude.com/docs` → `www.claude.com/docs/a` hop
    /// recompute an EMPTY scope on the second hop, which `isEligibleAutoFollow`'s
    /// `scope != nil && …` guard then short-circuits to "no restriction at all" — auto-following a
    /// third hop genuinely outside `/docs`.
    static func scopeOf(_ url: URL) -> Match? {
        let pathname = standardizedPath(url)
        for host in candidateHosts(WebFetchURL.bareHost(url)) {
            if hostnameOnly.contains(host) { return Match(host: host, pathPrefix: nil) }
            guard let prefixes = pathPrefixes[host] else { continue }
            if hasEncodedTraversal(pathname) { return nil }
            if let prefix = prefixes.first(where: { pathname == $0 || pathname.hasPrefix("\($0)/") }) {
                return Match(host: host, pathPrefix: prefix)
            }
        }
        return nil
    }

    /// Whether `url` still falls under the SAME preapproved scope `from` matched — the redirect walk's
    /// "not leaving a preapproved path scope" gate.
    static func staysWithinScope(_ from: Match, _ url: URL) -> Bool {
        let stripped = from.host.hasPrefix("www.") ? String(from.host.dropFirst(4)) : from.host
        let acceptable: Set<String> = [from.host, stripped, "www.\(stripped)"]
        guard acceptable.contains(WebFetchURL.bareHost(url)) else { return false }
        guard let prefix = from.pathPrefix else { return true } // a hostname-only scope covers the host
        let pathname = standardizedPath(url)
        if hasEncodedTraversal(pathname) { return false }
        return pathname == prefix || pathname.hasPrefix("\(prefix)/")
    }

    /// WHATWG `URL.pathname`, which is TWO things this needs and `Foundation.URL.path` is only one of:
    ///
    ///   * **PERCENT-ENCODED**, because the encoded-traversal guard reads `%2f`/`%5c`/`%2e` off exactly
    ///     this string — a decoded path would already have collapsed them into real separators;
    ///   * **DOT-SEGMENT-COLLAPSED**, which WHATWG's basic URL parser does at parse time and Foundation
    ///     does not. That gap was a real scope escape (whole-branch review M1, measured):
    ///     `https://claude.com/docs/../evil` matched the `claude.com/docs` entry because the raw path
    ///     literally starts with `/docs`, so the page got the PERMISSIVE quoting guidelines and was
    ///     eligible for the verbatim markdown passthrough — and `staysWithinScope` said a redirect to
    ///     `…/anthropics/../someuser/repo` stayed inside the `github.com/anthropics` scope, so
    ///     `isEligibleAutoFollow` FOLLOWED a hop that had left it. claude answers `false` to all three.
    ///
    /// `URL.standardized` collapses `.`/`..` (and `..` above the root, exactly as WHATWG does) while
    /// leaving every percent-escape alone — `/docs/%2e%2e/evil` and `/docs/..%2fevil` come through
    /// untouched, which is what keeps `hasEncodedTraversal` the thing that catches them. Query, fragment,
    /// host and port all survive.
    ///
    /// Always at least `/` for an http(s) url, matching WHATWG's non-empty-path rule.
    static func standardizedPath(_ url: URL) -> String {
        let path = url.standardized.path(percentEncoded: true)
        return path.isEmpty ? "/" : path
    }
}
