# AutoSkip for YouTube

Automatically performs YouTube Premium's **Jump Ahead**, plus a few related
one-click chores: the ad "Skip" button, "Skip intro"-style chips, and the
"Video paused. Continue watching?" dialog.

## Why this isn't just an auto-clicker

Jump Ahead's chip is awkward to catch. YouTube's player only renders it while
the controls are visible, which is why it often stays hidden until you seek
forward once and the controls pop up.

Rather than fight for the button, AutoSkip reads the data the button is built
from. Jump Ahead is server-driven, delivered as `timelyActions`:

```
timelyActionViewModel:
  startTimeMilliseconds: "30000"                 # when the chip appears
  content.buttonViewModel.title: "Jump ahead"    # localized label
  rendererContext.commandContext.onTap:
    serialCommand.commands[]
      .innertubeCommand.seekToVideoTimestampCommand
        .offsetFromVideoStartMilliseconds: "72000"   # where it lands
```

AutoSkip intercepts that, builds the skippable ranges, and seeks with
`#movie_player.seekTo()`. **The chip's visibility stops mattering.**

Two traps this code handles explicitly, both worth knowing if you touch it:

1. The field is `offsetFromVideoStartMilliseconds` — not `...Millis`.
2. `onTap` contains **several** `seekToVideoTimestampCommand`s. A blind deep
   search returns the wrong one and the jump goes nowhere, so extraction
   follows an explicit ordered path. There is a test named after this trap.

A second, secondary source is also read: `SOURCE_TYPE_SMART_SKIP` macro
markers, which the player's `base.js` consumes but which don't drive the
desktop chip today.

## Install

1. `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

Chrome 111+ (MAIN-world content scripts). Permissions: `storage`, `activeTab`,
and `*://*.youtube.com/*`. Nothing is sent anywhere — no network calls of its
own, no analytics.

## How it decides to jump

Two tiers:

- **Tier 1 — marker-direct (primary).** Patches `fetch` / `XMLHttpRequest` at
  `document_start` (before any YouTube script runs) and traps the inline
  `ytInitialPlayerResponse`. Pulls smart-skip markers out, builds ranges, and
  seeks. Jump target: a seek offset parsed from the `onActive` command if one
  is recognizable, otherwise the end of the range.
- **Tier 2 — chip click (fallback).** Only if tier 1 produced nothing at all
  for the current video. Matches the chip by the **server's own localized
  title** captured in tier 1 — so it works in any language — falling back to a
  selector allowlist. This is the only path that ever synthesizes input, and
  it's capped so a video that simply has no Jump Ahead never ends up with its
  controls pinned open.

If tier 1 is working and reports "this video has no jump-ahead data", tier 2
stays passive and never synthesizes anything.

## Safety rules

- Never seeks backwards.
- Each range is consumed once; scrubbing back in does not re-trigger it.
- Per-video jump cap and a cooldown between jumps.
- Inert while an ad is showing.
- **Undo detection**: seek backwards shortly after an auto-jump and AutoSkip
  suspends itself for that video.
- Blocklist by channel name or video id, plus a one-click "never on this video".

The other three actions are guarded too, because they share DOM with things
that must never be auto-clicked:

- *Continue watching?* — `yt-confirm-dialog-renderer` is also used for
  destructive confirms like deleting a comment. AutoSkip only confirms after
  60s with no trusted user input, which the idle prompt requires anyway and a
  user-opened dialog never satisfies.
- *Suggested chips* — a suggested-action badge can be a shopping link. Product
  badges (`ytp-featured-product`, or containing product imagery) are excluded,
  and the label must read as skip-like.

## Testing it

```bash
node test/markers.test.js
```

27 tests over `src/core/markers.js`, no browser and no Premium account needed.

**On a live page**, open DevTools on any YouTube video and use the diagnostic
surface the extension exposes:

```js
__autoskip.report()          // what was captured, what was rejected, and why
__autoskip.simulate()        // inject a fake jump 5s ahead, then jump 30s
__autoskip.simulate(3, 60)   // trigger in 3s, skip 60s
__autoskip.state()           // raw ranges / segments / rejects
__autoskip.reset()           // clear this video's state
```

`simulate()` builds a payload in the **real** `timelyActions` shape — decoy
command included — and feeds it through the normal capture path, so a
successful simulated jump exercises parse → range → decide → seek end to end.
It proves the engine works even on a video that offers no real Jump Ahead.

In `report()`, `payloads seen: 0` means capture never ran at all (the script
didn't load at `document_start`) — a different problem from capturing payloads
but extracting nothing, which points at a payload shape change and will show up
under `rejected`.

If the extension ever sees a real Jump Ahead chip while having extracted no
segments, it logs a loud warning — that mismatch is the highest-signal clue
that YouTube changed the payload.

### Layout

| Path | World | Role |
|---|---|---|
| `src/core/markers.js` | both | Pure parsing / range / decision logic |
| `src/main/inject.js` | MAIN | Network capture, player control, jump engine, `__autoskip` |
| `src/isolated/bridge.js` | ISOLATED | Settings, stats, blocklist, world bridge |
| `src/isolated/dom-actions.js` | ISOLATED | Ad skip, dialogs, chips, chip fallback |
| `src/popup/` | — | Toggles, tuning, diagnostics |

`markers.js` is loaded as a MAIN-world content script *and* `require()`d by the
tests, which is what makes the core logic testable without a browser.

### Capture mode

Logs the full selector chain of anything you click inside the player or a
dialog. Use it to pin down selectors if they ever drift.

## Known limits

- Jump Ahead is Premium-only and was, at time of writing, limited to
  English-language videos in the US. Elsewhere no data ever arrives and the
  extension is correctly inert.
- The `timelyActions` shape here was derived from a working third-party
  implementation and encoded in fixtures, not observed on a live Premium
  session by the author. If YouTube shifts it, `__autoskip.report()` shows
  exactly which entries were rejected and why.
- The "Continue watching?" selectors are not confirmed against a live dialog.
  Use capture mode to correct them if it misses.

## Credit

The `timelyActions` payload shape, the `offsetFromVideoStartMilliseconds`
field name, the multi-command `onTap` trap, and the fact that YouTube keeps the
chip in the DOM at 0x0 while controls are hidden were all established by
reading [jiahongc/auto-jump-ahead-for-youtube](https://github.com/jiahongc/auto-jump-ahead-for-youtube),
which documents the command-ordering issue as a regression it shipped and
fixed. No code was copied.
