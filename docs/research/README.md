# Research

| Document | What it covers |
|---|---|
| [BITCHORD_ENGINE_RESEARCH.md](BITCHORD_ENGINE_RESEARCH.md) | How BitChord's audio engine works end to end: source resolution (YouTube Music, JioSaavn, addons, JS modules); the resolver race and mid-song lossless upgrades; range-chunked transport and identity-keyed caching; decoding and the float DSP/output stage; Automix; downloads; and the 16-provider lyrics fallback chain. It ranks why the engine is fast, audits where quality is lost, lists the defects found, and ends with a scorecard for comparing another engine against it. |
| [reference/](reference) | Dependency-free JavaScript re-implementations of those mechanisms (546 offline tests), for porting into another app. See Appendix D of the paper. |

All line references are pinned to commit `fe198ac`.
