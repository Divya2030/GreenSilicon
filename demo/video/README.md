# Demo video

`record.mjs` drives the real app in a browser and records a captioned walkthrough
(about 4 minutes, inside the hackathon's 3–5 minute limit).

```bash
./scripts/dev.sh --prod                 # fresh demo data (re-run before every recording)
cd demo/video && npm i && npx playwright install chromium
node record.mjs                         # -> out/GreenSilicon_demo.mp4, out/captions.srt, out/narration.md
```

The MP4 has captions burned in and no audio. `narration.md` is the voice-over script, timed to
the video. `captions.srt` can be uploaded to YouTube as closed captions.

## Finishing it (free tools)

| Step | Recommended free tool | Why |
|---|---|---|
| Record your voice-over | **Audacity** or **Clipchamp** (built into Windows) | Read `narration.md` while the video plays; judges respond best to the creator's own voice. Audacity's noise reduction cleans up a laptop mic. |
| Combine voice + video | **Clipchamp**, **CapCut desktop** or **DaVinci Resolve** | Drop in the MP4 and your voice track, trim, export at 1080p. CapCut and Clipchamp also offer auto-captions and text-to-speech voices if you prefer an AI voice. |
| Add a 10-second personal intro | Phone camera or **OBS Studio** | A short "I'm Divya, I design chips, and this is why I built GreenSilicon" makes the story memorable. |
| Background music (optional) | **YouTube Audio Library** | Royalty-free; keep it at -25 dB under the voice. |
| Publish | **YouTube** (unlisted) or **Vimeo** | Paste the link into Devpost and into `site/assets/app.js` (`SITE.video`). Upload `captions.srt` as subtitles. |

Tips: keep it under 5:00 after adding the intro (trim the Scope 3 or verifier scene if needed),
speak at about 150 words per minute, and export at 1080p, 30 fps.
