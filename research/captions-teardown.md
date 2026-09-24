# Premium captions teardown: Captions/Mirage, Submagic, CapCut, Opus Clip, Descript (as of Sept 2026)

Your read is right: autobroll does have captions, but they sit at the level every one of these tools treats as the minimum. What makes captions "premium" is animation per word, emojis and sounds tied to words, AI-chosen emphasis, and a large set of named presets. A gap list for autobroll is in section 4.

Each claim has a URL. **[UNVERIFIED]** means the source is only marketing, a third party, a search snippet, or a page that no longer loads. **[CONFLICT]** means sources disagree. Captions.ai's company renamed itself Mirage in Sept 2025; the app is still called Captions ([TechCrunch](https://techcrunch.com/2025/09/04/captions-rebrands-as-mirage-expands-beyond-creator-tools-to-ai-video-research)).

## 1. Feature checklist

### Per-word timing and animation types

- **Descript** has the most complete published list. Enter/exit presets: Blur, Fade, Scale, Slide, Spin, Wipe. Text-only presets: Appear, Reveal, Pop, Bounce, Pulse, Glitch, Flicker, Wave, Wiggle. Each can run by character, word, line or paragraph, with Duration and Easing controls ([help](https://help.descript.com/effects-animations-transitions/text-animations)).
  - Sept 17, 2026 redesign: 18 new presets, 10 new text animations (15 in total), separate in and out motion ([changelog](https://feedback.descript.com/changelog)).
- **Captions** documents these controls ([styles doc](https://captions.ai/help/docs/captions/styles)):
  - "Captions transitions" and "Active word background transitions"
  - "Auto movement" (captions move position), "Auto scale" (captions grow and shrink), "Randomize rotation"
  - "Target", which sets how many captions appear at once
  - A claim that styles include pop-in, slide, bounce and fade word animations comes from a guide page that now returns 404 **[UNVERIFIED]**.
- **Submagic** advertises "35+ animation templates that highlight, bounce, and fade word by word" ([ai-caption](https://www.submagic.co/ai-caption)).
  - An entry in its changelog adds "Choose different animation styles" and "Customize word and emoji animations" ([changelog](https://submagic.canny.io/changelog/customize-your-caption-animations)). The changelog summary dates it to Jan 27, 2026, but the post itself shows no date **[UNVERIFIED date]**.
  - The Beast template has a glow animation with S/M/L settings ([blog](https://www.submagic.co/blog/how-to-make-captions-like-mrbeast)).
  - Hormozi style uses a pop-in from bottom to top ([blog](https://www.submagic.co/blog/how-to-make-alex-hormozi-captions)).
- **CapCut** groups text animation into In, Out and Loop, with typewriter among the presets. Preset names change between versions ([capcutguide](https://capcutguide.com/capcut-text-animation/)). Pop, Fade, Slide and Bounce are listed only by a third party ([crepal](https://crepal.ai/blog/aivideo/blog-ai-text-captions-capcut-guide/)) **[UNVERIFIED]**.
- **Opus** has "Animation controls" in its brand template ([help](https://help.opus.pro/docs/article/how-to-add-a-brand-template)) and says it added "10+ fresh caption styles & animations" without naming them ([changelog](https://opusclip.canny.io/changelog/new-caption-styles-animations)).
- **Karaoke fill:** Descript styles the active word and future words separately ([help](https://help.descript.com/visuals/captions)). CapCut has "highlight current word" ([capcutguide](https://capcutguide.com/capcut-word-by-word-captions/)). A true left-to-right sweep is the ASS `\k` tag ([forasoft](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/opus-clip-descript-submagic-captions-ai-video-editor-tools-2026)).
- **3D rotation, and blur-in per word:** no vendor documents either **[UNVERIFIED]**. Descript's "Blur" preset is the closest.

### Active-word highlight

- **Captions:** "Active Word Color" and "Active Word Background", each with its own transition ([styles](https://captions.ai/help/docs/captions/styles)).
- **Descript:** active word fill, stroke and background; future words fill and stroke; a playhead highlight color. One-word presets can't style future words ([help](https://help.descript.com/visuals/captions), [blog](https://www.descript.com/blog/article/new-in-descript-word-level-animations-on-fancy-captions-santa-overdub-voice); the blog post's date is unclear **[UNVERIFIED]**).
- **Opus:** the AI "tracks the currently spoken word on-screen" ([help](https://help.opus.pro/docs/article/how-to-add-a-brand-template)).
- **CapCut:** see karaoke fill above.

### Emphasis and keyword color logic

- **Captions** ([styles](https://captions.ai/help/docs/captions/styles), [word effects](https://captions.ai/help/docs/captions/word-effects)):
  - Automatic: "AI Emphasis - Automatically add text effects to words" (underline, emphasize, supersize), plus an "AI Color Scheme".
  - Separate "Emphasis Color".
  - Manual per word: Supersize, Emphasize, Underline, Effects (background on the word), Color, Font, Visibility.
  - A guide suggesting 1–2 emphasized words per sentence now returns 404 **[UNVERIFIED]**.
- **Opus:** "AI Keywords Highlighter … highlights important keywords" in a color you pick ([help](https://help.opus.pro/docs/article/how-to-add-a-brand-template)). For languages still in beta it warns of "inaccurate emojis or highlighted keywords" ([changelog](https://opusclip.canny.io/changelog/20-languages-support)).
- **CapCut:** Captions → Auto captions → "Auto highlight keywords" → Generate, in 23 languages ([tools](https://www.capcut.com/tools/video-keywords)).
- **Submagic [CONFLICT]:**
  - The help center says highlighting is manual: pick a word, choose "Highlight Color", about 3 colors, and not every theme supports it ([help](https://care.submagic.co/en/article/how-to-apply-highlighting-colors-to-your-words-16ttppq/)).
  - Reviews say keywords are highlighted automatically ([Medium review](https://medium.com/@ali.malikk/submagic-review-2025-best-ai-caption-tool-for-tiktok-shorts-reels-de5729248ef6)) **[UNVERIFIED]**.
  - Beast style: keywords in green with a glow ([blog](https://www.submagic.co/blog/how-to-make-captions-like-mrbeast)).
- **Descript:** no per-keyword highlight. The feature request has been open since Dec 2020 with 58 votes ([canny](https://descript.canny.io/feature-requests/p/highlighting-keywords-in-fancy-captions)).

### Auto-emoji

- **Captions:** "enable auto emojis" ([features](https://captions.ai/features/add-captions-to-videos)).
  - Its emoji placement model was retrained in Feb 2026 ([what's new](https://captions.ai/help/whats-new)).
  - Emoji size, timing and position can be set ([styles](https://captions.ai/help/docs/captions/styles)).
  - Standard or animated emoji can be added per word by hand ([word effects](https://captions.ai/help/docs/captions/word-effects)).
- **Opus:** "Our AI will attempt to add relevant emojis", with a toggle and a movable position ([help](https://help.opus.pro/docs/article/how-to-add-a-brand-template)). Manual add is a double-click on a word, then "Emoji" ([help](https://help.opus.pro/docs/article/captions-and-emojis)).
- **Submagic:** emojis are added by hand per caption, and "only some themes have emojis enabled by default" ([help](https://care.submagic.co/en/article/how-to-add-emojis-rczgrp)). There is a one-click "remove all emojis" ([help](https://care.submagic.co/en/article/how-to-remove-all-emojis-with-one-click-wbx698/)). That suggests themes insert emojis automatically **[inferred]**.
- **CapCut:** "emojis that automatically follow the text" appears only in marketing copy **[UNVERIFIED]**.
- **Descript:** none documented.

### Auto sound effects

- **Captions:**
  - Manual "Sounds" on a single word ([word effects](https://captions.ai/help/docs/captions/word-effects)).
  - Sounds can be generated by AI from a prompt (ElevenLabs, MMAudio, Stable Audio Open) ([sounds](https://captions.ai/help/docs/audio/sounds)).
  - The AI Edit docs mention music and sound effects as part of automatic editing ([ai-edit](https://captions.ai/help/docs/project/ai-edit)).
- **Submagic:** the help center describes sound effects as manual, added per caption or per B-roll ([help](https://care.submagic.co/en/article/how-to-add-sound-effects-1txg6i7/)). Its homepage lists "AI Sound Effects" ([home](https://www.submagic.co/)), so automatic SFX is **[UNVERIFIED]**.
- **Opus:** only fades for music and SFX, set in the brand template (Sept 2, 2026) ([changelog](https://opusclip.canny.io/changelog)). No automatic SFX is documented.
- **CapCut and Descript:** none documented.

### Named presets and templates

- **Submagic** ([API](https://docs.submagic.co/api-reference/templates), [API create](https://docs.submagic.co/api-reference/create-project), [themes](https://care.submagic.co/en/article/what-are-themes-and-themes-categories-1pv8wvz/)):
  - 41 templates from the API: Matt, Jess, Jack, Nick, Laura, Kelly 2, Caleb, Kendrick, Lewis, Doug, Carlos, Luke, Leila, Mark, Sara (the default), Daniel, Dan 2, Hormozi 1–5, Dan, Devin, Tayo, Ella, Tracy, Jason, William, Leon, Ali, Beast, Maya, Karl, Iman, Umi, David, Noah, Gstaad, Malta, Nema, seth.
  - AI edit templates: kelly, karl, ella.
  - Theme categories: Premium, New, Speakers, Emoji, Trend, Custom.
- **Captions:**
  - 100+ caption styles. Named examples: Cove, Energy, M81, Arion Pink, Quintessence, Bellatrix, Prism, Freshly, Thuban, Mars, Runway, Grace, Copernicus, Aldebaran, Nova, Alycone Blue, Travel, Andromeda, Cassiopeia, Citadelle ([features](https://captions.ai/features/add-captions-to-videos)).
  - AI Edit styles: 21 Premium and 95 Basic ([ai-edit](https://captions.ai/help/docs/project/ai-edit)). Named examples: Prism Pro, Paper II, Prime, Elevate, Impact II, Sketch, Lens, Vista, Pop, Orbit, Y2K, Form, Bloom, Chalk, Linen, Evo, Focus, Lift, Stack, Align ([edit-with-ai](https://captions.ai/features/edit-with-ai)); Atrium, Aperture, Bitmap, Byline, Kai, Grit, Rocket, Sonnet ([what's new](https://captions.ai/help/whats-new)).
- **Opus:** Simple, Karaoke, Popline, Beasty and Youshaei come from a third party ([gradually.ai](https://www.gradually.ai/en/youtube-to-shorts/)) **[UNVERIFIED]**. Deep Diver, Pod P, Mozi and Think Media appeared only in a search snippet **[UNVERIFIED]**.
- **CapCut:** no stable preset names ([capcutguide](https://capcutguide.com/capcut-word-by-word-captions/)). Categories include "Glow", "Trending" and "Aesthetic" ([capcut](https://www.capcut.com/resource/caption-template)).
- **Descript:** 18 new presets in Sept 2026, names not published ([changelog](https://feedback.descript.com/changelog)).

### Fonts commonly used

- Hormozi: TheBoldFont (old style), then Anton in uppercase with a yellow stroke and light shadow ([Submagic](https://www.submagic.co/blog/how-to-make-alex-hormozi-captions)).
- MrBeast: Komika in uppercase with a heavy black stroke ([Submagic](https://www.submagic.co/blog/how-to-make-captions-like-mrbeast)).
- Opus lists Montserrat Bold, Bebas Neue and Impact for bold presets, and Helvetica Neue and Lato for minimal ones ([Opus](https://www.opus.pro/blog/best-caption-presets-styles-boost-retention)).
- TikTok's native captions use a Proxima Nova variant ([blitzcut](https://blitzcutai.com/blog/best-caption-fonts-tiktok)) **[UNVERIFIED]**.
- Custom font upload: Captions, Submagic and Opus all support it ([styles](https://captions.ai/help/docs/captions/styles), [Opus help](https://help.opus.pro/docs/article/how-to-add-a-brand-template)).

### Outline, shadow, glow and background box

- **Captions:** Stroke, Shadow, Captions Background, Active Word Background ([styles](https://captions.ai/help/docs/captions/styles)). Added in 2026: negative (inverted) captions in March, stroke effects in May, a background stroke in June ([what's new](https://captions.ai/help/whats-new)).
- **Descript:** stroke and outline, gradient fills and backgrounds ([help](https://help.descript.com/visuals/captions)). Gradient fills on captions added Aug 5, 2026 ([changelog](https://descript.canny.io/changelog/release-round-upaugust-5th-2026)).
- **Opus:** stroke, shadow and case ([help](https://help.opus.pro/docs/article/captions-and-emojis)).
- **Submagic:** glow on the Beast style ([blog](https://www.submagic.co/blog/how-to-make-captions-like-mrbeast)).

### Line breaking and words per page

- **Captions:** "Words per line", "Lines per page", "Autofit", "Capitalization", hide "Punctuation" ([styles](https://captions.ai/help/docs/captions/styles)). Manual break per word: Auto, Line Break, Page Break or No Break ([word effects](https://captions.ai/help/docs/captions/word-effects)).
- **Submagic:** words per line is set in the custom theme ([help](https://care.submagic.co/en/article/how-to-create-custom-template-in-submagic-v6g09s/)). Beast uses 2 words per line; Hormozi 4–6 words over 2 lines ([blog](https://www.submagic.co/blog/how-to-make-captions-like-mrbeast), [blog](https://www.submagic.co/blog/how-to-make-alex-hormozi-captions)).
- **Opus guidance:** 5–8 words per line on mobile, captions shown 100–200 ms before the audio, 1.5–3 s per caption, 150–250 ms gap between captions ([Opus](https://www.opus.pro/blog/best-caption-presets-styles-boost-retention)).
- **Descript:** one-word presets ([help](https://help.descript.com/visuals/captions)).

### Placement and face avoidance

- **Submagic:** API fields `captionPositionY` (0–80%) and `captionPositionX` ([API](https://docs.submagic.co/api-reference/create-project)). Users report having to fix placement by hand ([review](https://max-productive.ai/ai-tools/submagic/)).
- **Captions:** "Auto movement" moves captions, but nothing says it avoids faces ([styles](https://captions.ai/help/docs/captions/styles)).
- **Opus:** a claim that captions use "smart positioning that avoids covering faces" appeared only in a search snippet; I couldn't find it on any Opus page **[UNVERIFIED]**. Opus does have Active Speaker Detection and dynamic layout ([Opus](https://www.opus.pro/tools/ai-caption-generator)), which are reframing features.
- **Descript:** separate caption layer per speaker ([help](https://help.descript.com/visuals/captions)).
- **Result:** no vendor officially documents placing captions to avoid faces.

### Platform safe zones

None of the five vendors documents a safe-zone overlay **[UNVERIFIED absence]**. Numbers from third parties:

- **Meta (unified in 2026):** keep the top 14%, bottom 35% and each side 6% clear ([behaviour.digital](https://behaviour.digital/post/meta-reels-safe-zone-14-top-35-bottom-6-sides-the-2026-official-guide)) **[UNVERIFIED vs official Meta docs]**.
- **TikTok:** figures vary; about 130–200 px at the top, 334–484 px at the bottom, 120–140 px on the right. TikTok says the safe area depends on the ad format ([checksafe](https://checksafe.zone/articles/tiktok-safe-area-overlay-guide-2026), [zeely](https://zeely.ai/blog/tiktok-safe-zones/)) **[UNVERIFIED]**.
- **Opus:** never place captions in the bottom 20% ([Opus](https://www.opus.pro/blog/best-caption-presets-styles-boost-retention)).

### Multi-language

- **Captions:** 60+ caption languages, including a "Multiple Languages" option ([help](https://captions.ai/help/docs/captions/add-captions)). Captions in several languages at once since May 2025 ([what's new](https://captions.ai/help/whats-new)).
- **Submagic:** 123 languages (marketing) ([home](https://www.submagic.co/)).
- **Opus:** 20+ languages including Spanish ([changelog](https://opusclip.canny.io/changelog/20-languages-support)).
- **CapCut:** 23 languages for keyword highlighting; bilingual captions; "Identify filler words" ([tools](https://www.capcut.com/tools/video-keywords), [ai-subtitle](https://www.capcut.com/resource/ai-subtitle-generator)).
- **Descript:** filler-word removal in Spanish, German, French, Portuguese and Italian since Aug 2026 ([changelog](https://feedback.descript.com/changelog)).

## 2. Table-stakes vs differentiators

**Table-stakes** (every tool, or nearly every one, has these):

- Word-level timestamps, active-word color or karaoke fill, one-word and short-page modes
- Stroke, shadow and background box; uppercase
- Font, color and position controls; custom fonts; saved brand templates
- 20+ languages, text-based caption editing, SRT export

**Differentiators** (only one or two tools have these):

- Word-selection logic done by AI, as opposed to only the active word lighting up: Captions' AI Emphasis, Opus's AI Keywords Highlighter, CapCut's Auto highlight keywords. Descript has none.
- Supersize of a single word, underline, and a background on one word (Captions).
- AI emoji placement with its own trained model, plus animated emoji (Captions). Opus has AI emoji too.
- A sound effect attached to a specific word (Captions; Submagic by hand).
- Motion on the whole caption block: auto movement, auto scale, random rotation (Captions).
- Emoji animation styles you can edit (Submagic).
- A large catalog of named creator styles: Submagic has 41 templates and Captions 100+ caption styles plus 116 AI Edit styles.
- Captions bundled with auto-zoom (Submagic: 6 styles, matched to the transcript), B-roll and a hook title ([auto-zooms](https://www.submagic.co/features/auto-zooms), [API](https://docs.submagic.co/api-reference/create-project)).

## 3. What the AI decides vs what the template fixes

**The AI decides:**

- Which words to emphasize and how (Captions AI Emphasis, Opus, CapCut)
- Which emoji go where (Captions, Opus)
- Color scheme (Captions "AI Color Scheme")
- Which template fits the video (CapCut "Style captions with AI" ([capcut](https://www.capcut.com/resource/caption-template)))
- Zoom moments (Submagic)
- B-roll density (Submagic `magicBrollsPercentage`)
- Cuts: silence pace natural/fast/extra-fast and `removeBadTakes` in Submagic; filler words in CapCut and Descript
- In Captions AI Edit: cuts, B-roll, transitions, motion graphics and music, with an "Edit intensity" slider and a free-text prompt on web ([ai-edit](https://captions.ai/help/docs/project/ai-edit))

**The template fixes:**

- Font, sizes, stroke, shadow and glow
- Palette and highlight colors
- Enter/exit and active-word animation
- Words per line and lines per page
- Default position
- Whether emojis are on, and their style (Submagic themes "control" all of these ([themes](https://care.submagic.co/en/article/what-are-themes-and-themes-categories-1pv8wvz/)))
- For AI Edit, the choice of style is always the user's

**Manual per word:** supersize, emphasize, underline, emoji, sound, color, font override and break (Captions word effects); highlight color and SFX in Submagic.

## 4. autobroll today vs this checklist

The code is in `/Users/felipealonzo/autobroll/src/CaptionTrack.tsx` and `/Users/felipealonzo/autobroll/scripts/captions-multiclip.mjs`.

**What it already has:**

- Word timings
- Active word goes from 78% to 100% white and scales to 1.05
- Gemini picks accent words and colors them gold
- Page breaks at 5 words, at clause ends and at pauses over 450 ms, with single-word orphans merged into the previous page
- Caption position per clip based on where the face is. No vendor documents this, so it is a differentiator.
- Each caption page fades in with an 18 px slide-up
- One font (Inter) with a text shadow

**What it's missing:**

- Stroke, background box or glow
- Active-word background pill
- Any per-word entry animation (pop, bounce, blur, typewriter)
- Supersize, and emphasis styles beyond a color
- Auto-emoji
- Sound effects on words
- Named presets or a theme system (it has one accent color)
- Uppercase and punctuation options
- Safe-zone limits (the default position is 58% from the top)
- Words-per-line and lines-per-page settings

**Worth knowing for your harness:** Opus became an official Claude connector on Sept 11, 2026 and launched Motion Studio for motion-graphics B-roll on Sept 18, 2026 ([changelog](https://opusclip.canny.io/changelog)). Submagic has an MCP server ([changelog](https://submagic.canny.io/changelog)).