# AutoSkip for YouTube — Privacy Policy

**Last updated:** October 29, 2026

AutoSkip is a browser extension that skips sponsor segments, skippable ads and
other parts of YouTube videos you choose. This policy explains exactly what data
it touches. The short version: **the developer collects nothing, runs no server,
and receives no data from you.**

---

## What AutoSkip does not do

- It does not collect, sell, rent or share any personal information.
- It has no analytics, telemetry, tracking or advertising.
- It does not require an account or sign-in.
- It does not read or send your YouTube account details, history, comments or
  any other page content to anyone.
- It does not run remote code. Everything it executes ships inside the
  extension.

## Data stored on your device

AutoSkip uses Chrome's local extension storage (`chrome.storage.local`). This
data stays in your browser profile, is not synced to other devices, and is
never sent to the developer.

| What | Why |
|---|---|
| Your settings, including any channels or videos you add to the "never auto-skip" list | So your choices persist |
| Usage counts (for example, how many ads or sponsor segments were skipped) | Shown in the popup |
| A cache of sponsor-segment results, keyed by YouTube video ID | So the same video isn't looked up twice. Holds at most 500 videos; entries expire after 7–30 days. Clear it any time with **Clear segment cache** in the popup |

Uninstalling the extension deletes all of it.

## Data sent off your device

AutoSkip sends data to exactly one service, and only when you turn on
**Sponsor skip** (it is off by default).

**SponsorBlock** (`sponsor.ajay.app`) — a free, community-maintained database
of sponsor segments. When you open a video, AutoSkip sends:

- the **first 4 characters of a SHA-256 hash of the video's ID** — never the
  video ID itself, and
- the segment categories you have enabled (for example, "sponsor").

SponsorBlock replies with segments for every video whose hash starts with
those 4 characters — typically dozens of unrelated videos — and AutoSkip picks
out the one you are watching on your device. This means SponsorBlock cannot tell
which video you are watching. SponsorBlock describes this design
[here](https://github.com/ajayyy/SponsorBlock/wiki/K-Anonymity).

The request carries no cookies or identifiers from AutoSkip. As with any
website, SponsorBlock's server can see your IP address and basic request
information; its own
[privacy policy](https://gist.github.com/ajayyy/aa9f8ded2b573d4f73a3ffa0ef74f796)
applies to that.

## How AutoSkip uses its permissions

| Permission | Used for |
|---|---|
| Access to `youtube.com` | Detecting skippable segments, ads and dialogs on YouTube pages, and skipping them |
| Access to `sponsor.ajay.app` | Looking up sponsor segments, as described above |
| `storage` | Saving the settings, counts and cache described above, on your device |
| `activeTab` | When you open the popup, reading the current tab's address so it can offer "Never auto-skip this video". Nothing is stored unless you click it |

AutoSkip runs only on YouTube. It has no access to any other website.

## Changes to this policy

If this policy changes, the updated version will be published at this same
address with a new "Last updated" date. If a future version sends data anywhere
new, this policy will say so before that version is released.

## Contact

Questions or concerns: open an issue at
[github.com/SkRagibIshrakAbid/AutoSkip/issues](https://github.com/SkRagibIshrakAbid/AutoSkip/issues).
