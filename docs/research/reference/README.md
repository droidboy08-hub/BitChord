# BitChord engine: JavaScript reference implementations

Dependency-free JavaScript re-implementations of the mechanisms described in
[`../BITCHORD_ENGINE_RESEARCH.md`](../BITCHORD_ENGINE_RESEARCH.md). They are
written so another music app can port BitChord's techniques. Every module
names the Kotlin file(s) it mirrors, and every deliberate difference from
BitChord is commented where it happens.

```bash
node --test        # Node >= 18 · 546 offline tests · ~2 s · no network access needed
```

| Folder | What's inside |
|---|---|
| `transport/` | Range-chunked reads that avoid googlevideo's pacing (`chunkedStream`) |
| `sources/` | YouTube audio resolver (no-cipher InnerTube clients, probe, caches); JioSaavn with pure-JS DES; the source race (`raceWithFallback`, `bestAcross`); `TrackMatcher`; the addon HTTP client; the JS-module host and an example module; TTL/LRU and single-flight caches |
| `lyrics/` | The 16-provider lyrics chain (`defaultLyricsRepository()`), every provider, TTML and LRC parsers, background vocals, gaps and duet alignment, and the provider-sheet state machine |
| `lib/` | Small fetch helpers (injectable `fetch`, timeouts, a fake fetch for tests) |
| `test/` | `node:test` suites with fixture responses shaped like the real services |

For a file-by-file map, a combined "fast path" example and the list of
differences from BitChord, see **Appendix D** of the paper.

## Notes

- **Where it runs.** Node 18+, browsers and React Native. Only standard web
  APIs are used, and the crypto is pure JS. The exception is `sources/moduleHost.js`,
  which uses `node:vm`. That is not a sandbox; in an app, run modules in a real
  JS engine binding such as QuickJS.
- **Not tested live.** The environment these were written in could not reach
  the music or lyrics services, so all tests use fixtures. Upstream APIs change
  often: expect to adjust parsers and client constants.
- **No secrets.** No API keys or secrets are included. Keyed providers
  (PaxSenix, and the optional Musixmatch signing-secret fallback) read them
  from `ctx.keys`.
- **Licence.** BitChord and InnerTubeX are GPL-3.0, and this code closely
  follows their structure and constants, so treat it as **GPL-3.0**, the same
  as the rest of this repository. If your app is not GPL-compatible, use the
  paper as a specification and write your own implementation.
