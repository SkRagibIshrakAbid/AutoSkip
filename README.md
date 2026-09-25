# AutoSkip for YouTube

**Stop waiting for the good part.** AutoSkip presses the buttons YouTube already
gives you — and finds the ones it doesn't.

A Manifest V3 Chrome extension. No build step, no dependencies, no telemetry,
no accounts.

---

## Why this exists

YouTube Premium ships a feature called **Jump Ahead**: an AI-picked jump past the
dull stretch of a video. It works well. It is also, oddly, *manual* — a chip you
have to notice and click, which YouTube only renders while the player controls
are visible. So it hides until you seek forward once and the controls pop up,
and half the time you never see it at all.

And Jump Ahead deliberately does not touch the segment most people actually want
to skip: the **in-video ad read** the creator was paid for. YouTube has no
incentive to help there.

AutoSkip closes both gaps:

- **With Premium**, Jump Ahead becomes automatic, and whether the chip is visible
  stops mattering.
- **Without it**, sponsor segments get skipped anyway — using the SponsorBlock
  community database, and optionally an LLM you choose and control.

Everything follows one principle: **a wrong skip must be cheap.** Never seek
backwards, never re-skip the same segment, always leave a way out.

---

## Features

| | Feature | Needs Premium | Default |
|---|---|---|---|
| ⏭ | **Auto Jump Ahead** — performs Premium's Jump Ahead, chip visible or not | Yes | On |
| 📺 | **Sponsor skip** — skips in-video ad reads | No | **Off** |
| ⏩ | **Ad skip** — skips YouTube ads the moment they become skippable | No | On |
| 🎬 | **Skip-intro chips** — clicks skip-style suggested-action chips | No | On |
| ⏸ | **"Continue watching?"** — dismisses the idle prompt | No | On |
| ↩ | **Undo toast** — every sponsor skip is one tap from reversed | No | On |
| 🔇 | **Blocklist** — never auto-skip a given channel or video | No | — |

---

## Status

**Pre-release.** Load it unpacked for now.

Once testing is complete and every feature is confirmed working on real accounts
— the LLM backends against live endpoints, the "Continue watching?" dialog
against a real one, and sponsor skip across enough videos to trust it — this is
headed for the **Chrome Web Store**. The open items are listed under
[Known limits](#known-limits); they are the gate.

---

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

Requires **Chrome 111+**. Permissions: `storage`, `activeTab`, and host access to
YouTube and SponsorBlock. LLM provider hosts are *optional* permissions,
requested only if you turn that on.

---

## How it works

### Jump Ahead

Rather than hunting for the chip, AutoSkip reads the same data YouTube builds the
chip from, and seeks past the segment itself. The chip never has to appear — no
hovering, no synthetic clicks, no waiting for the controls.

If that data path ever breaks, a fallback clicks the chip directly, matching it
by the server's own localized label so it works in any language.

### Sponsor skip

**SponsorBlock first.** Free, instant, human-verified, and no transcript needed.
Looked up by a short hash prefix, so the server never learns which video you are
watching.

**Your own LLM second**, only when SponsorBlock has nothing:

| Provider | Key needed | Notes |
|---|---|---|
| **Ollama** (local) | No | The transcript never leaves your machine |
| **OpenAI-compatible** | Yes | Also covers Groq, OpenRouter, LM Studio, llama.cpp |
| **Anthropic** | Yes | Claude |
| **Google Gemini** | Yes | Has a usable free tier |

Results are cached per video, so nothing is ever analysed twice. Transcripts come
from YouTube's own caption data; videos without captions can't use this path, and
the extension says so rather than looking broken.

**The model never sees or produces a timestamp.** It works on numbered transcript
lines and returns line numbers, which AutoSkip maps back to times itself. A
segment is thrown away if the quote it cites isn't actually in those lines, if
confidence is low, or if it would swallow an implausible chunk of the video. A
fabricated timestamp is impossible by construction — the worst case is a segment
that gets rejected.

---

## Safety rails

Every skip, whatever produced it, passes the same checks:

- **Never seeks backwards.** A result that arrives too late is dropped.
- **One skip per segment.** Scrub back in and it stays put.
- **Cooldown and a per-video cap**, so it can't loop.
- **Inert during ads.**
- **Undo detection.** Seek back right after an auto-skip and AutoSkip takes the
  hint and stops for that video.
- **One-tap Undo** on every sponsor skip.

The other actions are guarded too, because they share DOM with things that must
never be auto-clicked — a suggested-action badge can be a shopping link, and the
idle prompt uses the same dialog as *delete comment*. Product badges are excluded,
and a dialog is only ever confirmed after a long stretch of no interaction, which
one you just opened yourself can never satisfy.

---

## Privacy

- **No telemetry.** No analytics, no server of its own.
- **SponsorBlock** only ever receives a short hash prefix, never the video id.
- **Ollama** keeps transcripts entirely on your machine.
- **Cloud providers do receive the transcript.** The popup says which, and what
  it sends, before you enable it.
- **Your API key is stored apart from ordinary settings** and is only ever read
  by the extension's background worker — it never reaches the page.

---

## Diagnostics

Open DevTools on any YouTube video:

```js
__autoskip.report()          // what was captured, what was rejected, and why
__autoskip.transcript()      // which transcript path won, and how many lines
__autoskip.simulate()        // fake a Jump Ahead segment 5s ahead
__autoskip.simulateSponsor() // fake a sponsor segment → skip + toast + Undo
__autoskip.selftest()        // exercise ad-skip, chips and dialogs (~15s)
__autoskip.reset()           // clear this video's state
```

The simulators feed fake segments through the *real* pipeline, so a successful
simulated skip proves the whole path works — even on a video that offers nothing
to skip. `selftest()` builds the DOM YouTube would produce and checks the real
code reacts; three of its six cases are negative, confirming that a shopping
badge, a user-opened dialog and a still-counting-down ad are all correctly left
alone.

Warnings carry a stable code so they stay identifiable:

| Code | Meaning | Serious? |
|---|---|---|
| `[W-TRAP]` | Script didn't start early enough; first video's data missed | **Yes** |
| `[W-CHIP-NO-DATA]` | A Jump Ahead chip appeared that the parser couldn't explain | **Yes** |
| `[W-PARSE]` | A response failed to parse | Usually benign |
| `[W-SEEK]` / `[W-UNDO]` | A seek call threw | Rare |

The console opens with a build banner, so you can always tell which version is
loaded.

---

## Tests

```bash
node test/markers.test.js     # Jump Ahead engine
node test/segments.test.js    # sponsor segments + transcripts
```

56 tests. No browser, no Premium account, no API key. Fixtures include real
captured data from YouTube and SponsorBlock.

---

## Project layout

| Path | Role |
|---|---|
| `src/core/` | Pure logic — parsing, validation, decisions. Runs in Node for tests |
| `src/main/` | Player control and data capture |
| `src/isolated/` | Settings bridge, transcripts, toast, DOM actions |
| `src/providers/` | SponsorBlock and LLM clients |
| `src/popup/` | Settings UI |
| `src/sw.js` | Background worker — orchestration, cache, API keys |

Implementation notes, and the YouTube payload quirks worth knowing before
changing any of this, are in **[docs/INTERNALS.md](docs/INTERNALS.md)**.

---

## Changelog

### 0.3.1 — Ad skip actually skips

**Fixed**
- **Ads were never skipped.** YouTube no longer responds to a synthetic click on
  its skip button — verified live, a full pointer-event sequence is ignored too,
  and an ad played to the end through five click attempts. Skipping now
  fast-forwards the ad instead, which works.
- The skip button is still used as the *signal*: nothing happens until YouTube
  gives it real size, which is its own way of saying the countdown is over. An
  ad you're required to watch is still left alone.
- One button element is reused for every ad in a pod, and the old code marked it
  as already-clicked — so even had clicking worked, only the first ad in a break
  would have been skipped.

**Added**
- A sixth self-test case asserting a still-counting-down ad is not touched.

### 0.3.0 — Sponsor skip

Ad-read skipping for **everyone**, Premium or not.

**Added**
- SponsorBlock integration, looked up by hash prefix so the video id never leaves
  your machine.
- LLM fallback with four backends: Ollama, OpenAI-compatible, Anthropic, Gemini.
- Transcript pipeline with three acquisition paths.
- Undo toast, isolated from YouTube's styling.
- Per-video segment cache with a bounded LRU.
- New diagnostics and 29 new tests, including a dedicated hallucination guard.

**Security**
- API keys moved out of ordinary settings, which are broadcast to the page, into
  storage only the background worker reads.

**Changed**
- Sponsor and Jump Ahead segments now merge through one pass, so overlapping
  ranges can't produce two fighting seeks.
- Warnings carry stable codes; the console logs a build banner on load.

### 0.2.0 — Jump Ahead, actually working

0.1.0 looked complete and did nothing. Four separate defects, found by reading a
working third-party implementation and testing against the live site:

- **Wrong data source** — the feature is driven by different data than assumed.
- **Wrong field name** in the seek command.
- **Zero-size elements.** YouTube keeps the chip in the DOM at 0×0 while the
  controls are hidden; the visibility check was discarding the exact element it
  was looking for.
- **A designed-in dead end.** When the primary path reported "no data", the
  fallback went passive and refused to reveal the controls the chip needs —
  disabling both paths at once.

Also fixed a prefetch leak where the next video's data could overwrite the
current one's, and added the self-test and simulator.

### 0.1.0 — Initial

Auto Jump Ahead, ad-skip, skip-intro chips, "Continue watching?" dismissal,
popup, blocklist, diagnostics.

---

## Known limits

- **Jump Ahead is Premium-only**, and was limited to English-language videos in
  the US at the time of writing. Elsewhere it is correctly inert — sponsor skip
  still works.
- **The LLM path needs captions.** SponsorBlock doesn't.
- **The four LLM clients have not been tested against live endpoints.** The
  popup's **Test connection** button exists because that's a claim only you can
  confirm with your own key.
- **The "Continue watching?" selectors** were never confirmed against a real
  dialog. Capture mode will log the real element if it misses.
- **YouTube changes things.** When it does, `__autoskip.report()` shows what was
  rejected and why.

---

## Credits

The YouTube payload details behind Jump Ahead were established by reading
[jiahongc/auto-jump-ahead-for-youtube](https://github.com/jiahongc/auto-jump-ahead-for-youtube).
No code was copied.

Sponsor segments come from [SponsorBlock](https://sponsor.ajay.app/), built and
maintained by volunteers. If this is useful to you, consider
[submitting segments](https://wiki.sponsor.ajay.app/w/Guidelines) back.
