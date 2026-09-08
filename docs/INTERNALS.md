# Internals

Notes for changing this code. Everything here was established by testing against
the live site — the traps in particular cost real debugging time, and at least
one of them shipped as a visible bug before being found.

---

## Jump Ahead: where the data lives

The chip is server-driven, delivered as `timelyActions`:

```
timelyActionViewModel:
  startTimeMilliseconds: "30000"                  # when the chip appears
  content.buttonViewModel.title: "Jump ahead"     # localized label
  rendererContext.commandContext.onTap:
    serialCommand.commands[]
      .innertubeCommand.seekToVideoTimestampCommand
        .offsetFromVideoStartMilliseconds: "72000"    # where it lands
```

### Two traps

**1. The field is `offsetFromVideoStartMilliseconds`, not `...Millis`.**
The abbreviated spelling reads perfectly plausibly and silently matches nothing.

**2. `onTap` contains several `seekToVideoTimestampCommand`s.**
A blind deep search finds the wrong one — typically a logging variant with
offset `0` — and the jump goes nowhere. Extraction in `src/core/segments.js`
follows an explicit ordered path for exactly this reason.

`test/markers.test.js` has a case named after this trap, using a decoy command
that returns `0` if anyone reintroduces a deep search.

### A third, non-obvious one

**YouTube keeps the chip in the DOM at 0×0 while the player controls are
hidden.** Any `getBoundingClientRect()` visibility filter throws away the exact
element the fallback is hunting for. `findJumpChip()` in
`src/isolated/dom-actions.js` deliberately does not require layout — every other
action in that file correctly does.

---

## Response shapes

SPA navigation fires `/youtubei/v1/get_watch`, not `/youtubei/v1/player`. Missing
it means the primary path only ever works on the first, hard-loaded video.

That response is a **top-level array**, with the payload nested under
`[1].watchNextResponse.…`. A fixed key path from the root finds nothing, which is
why parsing walks structurally. `fixtures/real-get-watch.json` is a real captured
response preserving this shape.

Interception must happen at `document_start`, before YouTube's own scripts run.
Patching later does not reliably catch its requests.

---

## Transcripts

The obvious route is dead. `captionTracks[].baseUrl` now carries `exp=xpe` and
returns **HTTP 200 with a zero-byte body** — even from inside the page with the
user's own session. Forging `/youtubei/v1/get_transcript` fails too
(`FAILED_PRECONDITION`). Both verified live.

So transcripts come from YouTube's own traffic or DOM, cheapest first:

1. **Intercept `/api/timedtext`** — fetched by YouTube itself to render captions.
   Exact milliseconds, nothing on screen disturbed.
2. **Intercept `/youtubei/v1/get_transcript`** — fires when the transcript panel
   opens. Also exact.
3. **Open the panel, scrape it, restore it.** ~1 second precision.

### Deduplication

Auto-captions repeat the same text on consecutive cues. Those are dropped — but
only when **adjacent**. Deduplicating globally deletes legitimately repeated
content (a song chorus, a catchphrase) and shifts every line index the model
reasons about. `fixtures/panel-rows.sample.json` is a real transcript whose
chorus repeats six times non-adjacently, and a test asserts those survive.

---

## Why the LLM never emits timestamps

A model asked for timestamps invents them, and an invented timestamp silently
eats real content. It only ever receives indexed lines:

```
[0] hey everyone welcome back to the channel
[1] before we start, today's video is sponsored by
[2] NordVPN keeps your connection private and secure
```

It returns `{startLine, endLine, category, confidence, quote}`; line indices map
back to times on our side. A segment is discarded when:

- an index is out of range, or `endLine < startLine`
- the `quote` does not appear in those lines (proof it read the transcript rather
  than pattern-matching "this sounds sponsor-ish")
- confidence is below threshold — default `0.7`
- the span exceeds 25% of the video, or 6 minutes

A fabricated timestamp is structurally impossible. The worst case is a rejected
segment, never a silent skip of real content.

If the prompt builder is ever changed, keep timestamps out of it. There is a test
asserting the rendered prompt contains no clock-style times.

---

## SponsorBlock

Only the hash-prefix endpoint is used: the first 4 hex characters of
`sha256(videoId)`.

```
full sha256 : 775e3b4eb2fe01af45cb87d107a1137b37f176647b60dd4d5a1d90f466ef2d39
sent prefix : 775e   (60 hex chars withheld → a bucket of ~57 videos)
```

The bucket is filtered locally. **Never use `/api/skipSegments?videoID=`** — it
leaks the exact video.

Downvoted segments are dropped; `locked` (moderator-approved) segments are
trusted regardless of votes. Only `actionType: "skip"` is acted on — `mute`,
`poi` and `full` are different behaviours.

---

## Execution contexts

Three contexts, and each boundary exists because something can only be done on
one side of it.

| Context | Holds | Because |
|---|---|---|
| **MAIN** | Player control, network capture | `seekTo()` is a page object; `fetch` must be patched before YouTube's scripts run |
| **ISOLATED** | Settings, transcripts, toast, DOM actions | `chrome.*` APIs exist only here |
| **Worker** | SponsorBlock + LLM calls, cache | Holds host permissions, and the API key must never touch the page |

MAIN ↔ ISOLATED communicate via `window.postMessage` with an origin check.
ISOLATED ↔ worker via `chrome.runtime.sendMessage`.

### The API key rule

`settings` is broadcast wholesale into the MAIN world, which shares scope with
YouTube's own scripts. The API key therefore lives under a **separate storage
key**, read only by the worker and the popup.

Keep it that way. Filtering a secret out of a broadcast object is a mistake
waiting to happen; storing it somewhere the broadcast never touches is not.

### Segment sources are interchangeable

`buildRanges()` takes `{triggerMs, seekTargetMs, label, source}` and
`decideJump()` operates purely on ranges. Jump Ahead and sponsor segments merge
through one clipping pass, so overlapping ranges can't produce two fighting
seeks. Adding a new source means emitting that shape — not touching the engine.

---

## Testing without the real thing

Neither Premium data nor an LLM key is needed to verify the logic.

- `src/core/*.js` assign to `globalThis` and end with a `module.exports` guard,
  so the same file is both a content script and a Node module.
- `__autoskip.simulate()` and `simulateSponsor()` inject synthetic segments in
  the **real** payload shape — decoy command included — through the normal
  capture path.
- `__autoskip.selftest()` synthesises the DOM YouTube would produce for the ad
  button, chips and dialogs. Two of its five cases are negative.

One wrinkle if you extend the self-test: `yt-confirm-dialog-renderer` is a live
custom element, and children appended before it connects get wiped when Polymer
upgrades it. Connect first, let the upgrade settle, then append.
