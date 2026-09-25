# Testing AutoSkip

Thanks for helping. This is a pre-release build — the goal is to find out what
breaks on someone else's machine, account and viewing habits.

Roughly 15 minutes for the core pass. Anything you notice beyond it is a bonus.

---

## Setup

1. Unzip the folder somewhere permanent (Chrome reads it from disk every time —
   if you move or delete it, the extension breaks).
2. Open `chrome://extensions`
3. Turn on **Developer mode**, top right
4. Click **Load unpacked** and pick the folder (the one containing
   `manifest.json`)
5. Open any YouTube video, then open DevTools (`F12` or `Cmd+Option+I`) →
   **Console** tab

You should see:

```
[autoskip] v0.3.0 ready — __autoskip.report()
```

If you don't see that line, stop here and tell me — nothing else will work.

> Chrome will warn about "extensions in developer mode" on startup. That's
> normal for any unpacked extension and can be dismissed.

---

## 1 · Does it install cleanly?

- [ ] No red **Errors** button on the extension's card in `chrome://extensions`
- [ ] The banner line appears in the console
- [ ] The toolbar icon opens the popup

---

## 2 · Self-test (30 seconds, everyone)

Paste into the console on a YouTube video:

```js
__autoskip.selftest()
```

Takes about 15 seconds. The video pauses and resumes — that's expected.

- [ ] Reports **6 passed, 0 failed**

If any case fails, copy the whole output. Three of the six are deliberately
"nothing should happen" cases, so a *failure* there means it acted when it
shouldn't have — that's the most important bug you could find me.

---

## 3 · Sponsor skip (everyone — this is the main new feature)

It ships **off**. Turn it on first: click the toolbar icon → enable
**Skip sponsor segments**.

Then open this video — its sponsor segment starts at 0:00, so the skip should
happen the moment it starts playing:

```
https://www.youtube.com/watch?v=TZdUz0YRJ3g
```

- [ ] It jumps forward ~60 seconds almost immediately
- [ ] A small toast appears bottom-left: *"Skipped 1m 0s — Sponsor"* with **Undo**
- [ ] Clicking **Undo** puts you back where you were
- [ ] After undoing, it does **not** immediately skip you forward again

Second one, where the segment starts at 0:21:

```
https://www.youtube.com/watch?v=9AzzCZcrGHQ
```

Then try it on your own normal viewing for a while — ideally videos from
channels that do sponsor reads. What I most want to know:

- [ ] Did it ever skip something that **wasn't** an ad? (most important)
- [ ] Did it miss obvious ad reads?
- [ ] Did the skip land in the right place, or cut off early/late?

---

## 4 · If you have YouTube Premium

Jump Ahead only has data on **English-language videos, in the US**. If you're
elsewhere it'll simply do nothing, which is correct — not a bug.

- [ ] Play a longer video and let it run. It should jump ahead on its own,
      without the "Jump ahead" chip ever appearing
- [ ] Run `__autoskip.report()` and send me the output

---

## 5 · If you don't have Premium

- [ ] When a YouTube ad plays, does it disappear by itself the moment the
      "Skip" button would have become clickable?
- [ ] An ad still counting down ("Skip in 5") should **not** be skipped early —
      you should still see those few seconds

---

## 6 · Make sure it doesn't get in the way

This matters as much as the features working. Use YouTube normally for a bit:

- [ ] Seeking, pausing, fullscreen, playback speed all behave normally
- [ ] Playlists and autoplay work
- [ ] Clicking between videos repeatedly (no reload) stays stable
- [ ] Live streams and Shorts aren't disturbed
- [ ] Nothing feels slow or janky

---

## 7 · Optional — the LLM path (only if you're up for it)

Used only when SponsorBlock has no data for a video. Skip this section entirely
if you'd rather not.

**Private option:** install [Ollama](https://ollama.com), run
`ollama pull llama3.1`, and start it with `OLLAMA_ORIGINS=*` set. Nothing leaves
your machine.

**Cloud option:** paste an API key for OpenAI / Anthropic / Gemini. Note that
this sends video transcripts to that provider — don't do it if that bothers you,
and use a key you can revoke.

In the popup: enable **Use an LLM**, pick the provider, hit **Test connection**.

- [ ] Test connection succeeds
- [ ] On a video with an ad read that SponsorBlock doesn't cover, it eventually
      finds and skips it (give it 10–30 seconds — it has to read the transcript)

---

## What to send me

For anything that goes wrong:

1. **Chrome version** and **OS**
2. **Do you have Premium?** And roughly what country
3. The **video URL** it happened on
4. Console output of:
   ```js
   __autoskip.report()
   ```
5. Any console line starting with `[autoskip]` — especially ones containing
   `[W-` (those are warnings I've tagged deliberately)
6. If the extension card shows a red **Errors** button, click it and screenshot

A description like "it skipped 30 seconds of actual content at 4:20 in this
video" is genuinely more useful than a stack trace.

---

## Known already — no need to report

- Jump Ahead does nothing without Premium, or outside US/English videos
- Sponsor skip does nothing on videos SponsorBlock hasn't covered, unless you
  set up the LLM
- The LLM path needs the video to have captions
- The "Continue watching?" auto-dismiss is hard to test on purpose — it needs
  ~30 minutes of no interaction. The self-test covers the click path instead
- Chrome's "developer mode extensions" startup warning
