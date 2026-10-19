# YouTube upload kit

Files (in `demo/`):
- Video: `video/out/GreenSilicon_demo.mp4` (4:36, 1080p, female US-English voice-over, burned-in captions)
- Thumbnail: `brand/youtube-thumbnail.png` (1280×720)
- Captions: `video/captions.srt` (English)

## Steps
1. Go to **studio.youtube.com** → **Create** → **Upload videos** → select `GreenSilicon_demo.mp4`.
2. **Details** tab:
   - **Title**: paste the title below.
   - **Description**: paste the description below.
   - **Thumbnail**: *Upload file* → `youtube-thumbnail.png`. Custom thumbnails need a verified account: Studio → Settings → Channel → Feature eligibility → verify by phone. It takes a minute.
   - **Audience**: "No, it's not made for kids".
   - **Show more** → **Tags**: paste the tags below. **Category**: Science & Technology. **Video language** and **Caption certification**: English / "None".
3. **Video elements**: optionally add an end screen with a link to the repo or the website.
4. **Subtitles** (Studio → Subtitles → your video → Add language: English → Add → **Upload file** → *With timing* → `captions.srt`). The captions are already burned in, so this is for accessibility and search; viewers can turn it on or off.
5. **Visibility**: **Public** is recommended (judges and anyone can find it), or **Unlisted** (only people with the link). Do **not** choose Private, because judges couldn't open it.
6. Copy the video link and paste it into:
   - Devpost → *Project details* → **Video demo link**
   - `site/assets/app.js` → `video: "..."`, then commit and push.

## Title (98/100 characters)
```
GreenSilicon: Verified Carbon & Water for AI Chips, from Fab to Inference | IEEE ClimateChain 2026
```

## Description
```
What does an AI chip really cost the planet, in carbon and in water, from the fab where it is made to every AI job it runs?

GreenSilicon gives each semiconductor production lot a tamper-proof digital product passport on the blockchain. Suppliers sign their carbon, water and energy disclosures; an AI auditor (physics models, device-signed IoT meters, an anomaly model and Claude) checks them; and the same passport follows the chip into the data center, where every AI job gets a Green Compute Certificate with its energy, water and share of the chip's manufacturing footprint. Nothing is counted twice, and identical work is never computed twice.

Highlights from the working prototype:
• Greenwashing caught: a fab claiming 99.9% gas abatement was contradicted by its own on-chain meter (90%) and rejected
• Up to 90% less CO2 for an AI training job by scheduling it to a cleaner site and hour
• 80%+ less energy per AI question with caching, small-model routing and speculative decoding
• Seawater cooling analysis: when it removes freshwater use, and when power-plant water dominates
• Carbon credits that can't be double-claimed; recycling rewards; a GHG Protocol Scope 3 report for buyers

Built for the IEEE ClimateChain Global Hackathon 2026
Primary track: Sustainable Supply Chains (also addresses Carbon Markets, Renewable Energy, and Climate Data & Environmental Monitoring)

By Divya Kohli, third-year PhD student, University of California, Santa Cruz (UCSC), CA, USA

Code (open source, MIT): https://github.com/Divya2030/GreenSilicon
Website and full analysis: <your site URL>

Chapters
0:00 Intro
0:19 The problem
0:49 Design Lab: carbon-aware chip design
1:22 AI audit: a prompt-injection attack rejected
1:59 IoT evidence from fab meters
2:29 The chip passport
2:51 AI compute: scheduling, reuse, energy per question, seawater cooling
3:52 No double counting and the Scope 3 report
4:10 Trustless verification and wrap-up

Data sources: ACT (Gupta et al., ISCA 2022), imec.netzero, 3D-Carbon (DAC 2024), Ember, "Making AI Less Thirsty" (Li et al.), Epoch AI, Google (2025). Companies in the demo scenario are fictional; physics and data are real. Voice-over: synthetic voice (Microsoft neural TTS).

#ClimateTech #Semiconductors #Blockchain #AI #Sustainability #IEEE
```

## Tags
```
GreenSilicon, IEEE ClimateChain, climate tech, semiconductors, chip design, AI accelerators, blockchain, smart contracts, digital product passport, carbon footprint, embodied carbon, data center water, sustainable AI, green computing, carbon credits, supply chain transparency, IoT, Ethereum, Claude AI, hackathon
```
