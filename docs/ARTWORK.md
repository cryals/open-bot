# README artwork and badges

## Module headers

Each of the 23 module reference pages has its own conceptual header illustration. Files are stored in `assets/modules/<module-id>.png`. These are built-in imagegen outputs in the monochrome Open Bot style, not screenshots or diagrams of the exact runtime. The Markdown heading supplies the module name; the artwork deliberately contains no text.

The [module artwork manifest](assets/modules/manifest.json) records the output filename, module and complete final prompt for each image. The documentation generator adds available headers inside its managed page region; subsequent command-reference generation preserves them and leaves handwritten notes outside the markers intact.

## Assets

| File                                                | Purpose                                                                                          | Production        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------- |
| [open-bot-cover.png](assets/open-bot-cover.png)     | README masthead; includes the supplied Stopco symbol on white                                    | Built-in imagegen |
| [open-bot-modules.png](assets/open-bot-modules.png) | Concept illustration of a modular control system, not a screenshot or exact architecture diagram | Built-in imagegen |
| [badges/](assets/badges/)                           | Six monochrome SVG badges                                                                        | Project script    |

Generated on 2026-10-30 with the built-in image generation tool, not the fallback CLI. Final PNG outputs were copied unchanged into the repository. The cover used [public/stopco.png](https://github.com/cryals/open-bot/blob/main/public/stopco.png) as a supporting reference for the existing brand symbol. It did not replace that original logo.

## Recreate badges

```sh
node scripts/readme-badges.mjs
```

The badge source is [scripts/readme-badges.mjs](https://github.com/cryals/open-bot/blob/main/scripts/readme-badges.mjs). The palette follows the panel: near-black surfaces, white square corner details, gray labels and white values. SVG keeps small text sharp at different display scales.

Badges describe project properties, not live server availability. `STATUS / RELEASE` is editorial metadata. `CI / VIEW RUNS` links to the actual Checks workflow; no passing result is hard-coded. Runtime, Discord format and license labels must be updated with the project when those properties change.

## Image generation prompts

### open-bot-cover.png

```text
Use case: ads-marketing
Asset type: final GitHub README masthead for Open Bot, panoramic landscape 3:1.
Primary request: Create an elegant monochrome editorial banner for "Open Bot", a self-hosted Discord server management bot with a modular core, web panel, rule editor and message composer. Match the owner's dark AL-S / Stopco visual language.
Input image: supporting brand symbol reference only. Keep its black silhouette recognizably unchanged inside a small crisp white square; it is the existing Stopco symbol, not an invitation to invent a new logo.
Scene/backdrop: near-black ink background, restrained very faint CRT scanlines, tiny silver terminal rules, lots of clean negative space.
Composition: left half huge impeccably typeset uppercase "OPEN BOT"; small label underneath "DISCORD SERVER MANAGEMENT". Small white square Stopco mark just before the wordmark. Right half a beautiful technical still life: one abstract brushed black metal terminal module, slender white signal paths, fine engraved rectangular details. Understated, precise and calm. No rounded cartoon robot.
Color palette: black #030303, charcoal #101010, white #f4f4f2, muted gray #969694. No colored accents, no purple or neon.
Text (verbatim): "OPEN BOT" and "DISCORD SERVER MANAGEMENT". Only these words, no fake statistics or feature claims.
Constraints: strong legibility at README width 900px; wide quiet border margins; flat square corners; no screenshot, no web app mockup, no watermark, no random text. Original artwork for README, not a runtime status indicator.
```

### open-bot-modules.png

```text
Use case: illustration-story
Asset type: wide 3:1 conceptual illustration for the Open Bot GitHub README, below a "Modular by design" section.
Primary request: A precise monochrome technical cutaway illustration of a modular Discord management bot. This is conceptual artwork, not a screenshot and not a technical diagram.
Scene/backdrop: near-black #030303 background with a quiet fine square drafting grid, graphite metallic edges, pure white markings.
Subject: one low, elegant central control chassis with four removable rectangular modules arranged across a clean workbench; thin white signal paths and two neatly separated black processor bays suggest bot and web processes. A small document card, a terminal cursor, and spare line geometry suggest rules, messages, and logging. Give each shape room; no ornamental circuit clutter.
Style/medium: refined editorial industrial illustration, charcoal pencil detail combined with crisp schematic linework, subtle engraved surface texture.
Composition/framing: panoramic, centered with generous margins, strong horizontal rhythm and plenty of black negative space; calm, useful, engineered, high contrast. Square-cut edges.
Text: no words or numbers at all.
Avoid: colorful gradients, neon, mascots, rounded cartoon robots, logos, illegible faux UI, fake screenshots, fake dashboards, watermarks.
```

## Documentation screenshots

`assets/screenshots/{rules,info,settings,messages,activity,history}.png` are real Playwright captures from the isolated FakeDiscord UI, not production Discord or customer data. The companion `rules-guide.png` was edited with the built-in imagegen tool from the clean `rules.png`; it is an annotated illustration, not a separate behavior check. Clean originals remain available alongside it.

Prompt for `rules-guide.png` (built-in edit mode):

```text
Use case: precise-object-edit. Asset type: annotated screenshot for Open Bot user documentation. Input image is the edit target, a real 1440x1000 web UI screenshot. Preserve the ENTIRE original screenshot, all existing Russian UI text, every button and its disabled state, fonts, layout and dimensions. Make only an overlay of four small amber-yellow numbered circles and thin amber rectangular outlines with arrows. Do not repaint, translate, rewrite, invent or move any interface content. Number 1 highlights the left page-list area x34..240 y403..700. Number 2 highlights the central text editing area x350..937 y554..754. Number 3 highlights the right preview area x1002..1386 y230..877. Number 4 highlights the top save/publish buttons x1115..1387 y125..164. Place numbers near each outlined area's corner, without hiding button labels. Only added text allowed is digits 1,2,3,4. No explanatory labels, watermark or extra decoration. The illustration must remain an exact screenshot with simple educational annotations.
```

The generated output was visually compared with the source. Imagegen rescaled/reconstructed the raster; use the clean screenshot and written steps as the authoritative UI reference. Numbers show: 1 — pages, 2 — text block, 3 — preview, 4 — save/publish. The stored illustration uses only demonstration content.

## Sources and rights

The [Stopco source](https://github.com/cryals/cryals/blob/main/web/public/logo/stopco.png) and existing AL-S styling were supplied by the project owner. See [THIRD_PARTY_NOTICES.md](https://github.com/cryals/open-bot/blob/main/THIRD_PARTY_NOTICES.md) for scope and upstream rights. The wordmark uses the product name **Open Bot**; supplied community rule content keeps the name **Open Space**.

## Release 1.3 artwork and screenshots

Generated on 2026-10-31 with built-in imagegen. Outputs were inspected and copied unchanged into the repository. These are editorial illustrations; they do not show actual Discord responses or imply performance measurements.

- `assets/readme-commands-1.3.png`: `/help`, `/ping`, `/send-info`; README command illustration.
- `assets/readme-monitoring-1.3.png`: five supported games and separate SS14 Watchdog power actions.
- `assets/screenshots/release13-automod.png`, `release13-role-panel.png`, `release13-intents.png`, `release13-access.png`: real Playwright captures at 1480×1080 from the isolated module harness with FakeDiscord and an in-memory SQLite database. No image generation or retouching was applied to these screenshots. The role panel is an unsaved example; disabled module/restart controls retain their actual state.

Final prompt for `readme-commands-1.3.png`:

```text
Create one premium editorial illustration for the GitHub README of Open Bot, a modular Discord administration bot. Wide landscape 1536x864. Dark monochrome AL-S visual language: near black #080808 background, silver and warm white typography, very fine graphite rectangular borders, square corners, restrained tiny crosshair registration marks. Beautiful tactile etched metal and fine grain, substantial negative space. NOT a screenshot and NOT a fake Discord interface. A striking sculptural white geometric terminal cube at the left, and three large beautifully typeset command strips on the right. Exact text only: top small 'OPEN BOT / COMMANDS'; first strip '/help' with small label 'MODULES & COMMANDS'; second '/ping' with small label 'GATEWAY LATENCY'; third '/send-info' with small label 'PUBLISH INFORMATION'. Footer tiny 'RELEASE 1.3'. All spellings exact. Accessible high contrast, architectural technical editorial composition, elegant Github project illustration. No colored gradients, no robots, no Discord logo, no invented performance numbers, no claim that this is actual UI.
```

Final prompt for `readme-monitoring-1.3.png`:

```text
Create a refined wide editorial raster illustration for Open Bot README and documentation, landscape 1536x640. Same visual family as fine dark monochrome technical engraving: nearly black background, warm white, gray, thin rectangular borders, tiny registration marks, etched stone and metal texture, no bright color or gradients. It is explicitly conceptual artwork, NOT a screenshot or actual app UI. Composition: one sculptural white modular cube hub at center with five distinct thin connections to understated rectangular plaques around it, balanced and spacious, not crowded. Exact title text at top 'GAME SERVER STATUS'. Five plaque labels EXACTLY: 'SPACE STATION 14', 'SPACE STATION 13', 'MINECRAFT', 'TERRARIA / TSHOCK', 'PROJECT ZOMBOID'. Bottom band command text '/server-status' then tiny 'STATUS' and '/watchdog' then tiny 'SS14 POWER ACTIONS'. These are distinct operations: status supports all five games, power actions are SS14 only. No decorative fake metrics or status values. White serif command lettering with small monospaced labels, sophisticated developer project illustration, all text spelled correctly and clearly. Use no game logos or characters.
```
