# ComfyUI IdeogramGen Panel for After Effects

A ScriptUI panel that drives ComfyUI's native Ideogram 4.0 text-to-image graph directly from After Effects, assembling a structured JSON caption from panel fields and live AE layer geometry.

## Features

- **Structured caption builder** — composes Ideogram's JSON caption format from dedicated fields: high-level description, style description (aesthetics, lighting, photo, medium, color palette), and compositional deconstruction (background + elements)
- **Live text-layer binding** — any caption field can be bound to a text layer in the comp; the field becomes read-only and mirrors that layer's content automatically, even as it changes across the timeline
- **Automatic bounding boxes** — pick a shape layer and the panel scans its vector groups for rectangles, turning each one into an "element" with a bbox computed from its position, transform, and the layer's rotation/scale, normalized to Ideogram's 0–1000 coordinate space
- **Auto-fill or custom color palettes** — per-element and top-level color palettes can pull live from a shape layer's vector fill color, or use manually picked swatches (AE's native color picker)
- **Quality tiers** — Quality (48 steps) / Default (20 steps) / Turbo (12 steps), each mapped to its own preset
- **Match comp aspect ratio** — automatically selects the closest of 8 supported Ideogram aspect ratios for the active composition
- **Two generation modes** — Single frame (current comp time) or Every frame (renders one image per frame across the work area or full duration, re-resolving bounding boxes and prompt text live at each frame)
- **Seed control** — Random, Fixed, or Increment, with a configurable step and variation count
- **Per-composition memory** — prompt parts, layer bindings, color palettes, shape layer choice, and generation settings are restored automatically when switching compositions
- **Live change detection** — dropdowns, bounding boxes, and color swatches refresh automatically when layers are renamed, moved, resized, or recolored — no manual refresh needed
- **Automatic import** — generated images are imported into your AE project, placed at the correct comp time, scaled to fit, and optionally routed into a specific Project panel folder
- **No external dependencies** — pure ExtendScript + Socket HTTP

## Installation

1. In After Effects, go to **File → Scripts → Install ScriptUI Panel...**
2. Select `ComfyUI_IdeogramGen.jsx` and click Open
3. Restart After Effects
4. Open the panel via **Window → ComfyUI_IdeogramGen.jsx**

> **Note:** Enable script access if prompted:
> **Edit → Preferences → Scripting & Expressions → Allow Scripts To Write Files And Access Network**

## Requirements

- Adobe After Effects CC 2018+
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) running locally or on your network (default: `127.0.0.1:8188`)
- Ideogram 4.0 model files installed in ComfyUI:
  - `ideogram4_fp8_scaled.safetensors` (diffusion model)
  - `ideogram4_unconditional_fp8_scaled.safetensors` (diffusion model, unconditional)
  - `qwen3vl_8b_fp8_scaled.safetensors` (CLIP, type `ideogram4`)
  - `flux2-vae.safetensors` (VAE)
- Supporting ComfyUI nodes available in your install: `ResolutionSelector`, `Ideogram4Scheduler`, `DualModelGuider`, `CFGOverride`, `JsonExtractString`, `ComfyMathExpression`, `ComfyNumberConvert`, `StringReplace`, `CustomCombo`, `EmptyFlux2LatentImage`

## Quality Tiers

| Tier | Steps | mu | std |
|---|---|---|---|
| Quality | 48 | 0.0 | 1.5 |
| Default | 20 | 0.0 | 1.75 |
| Turbo | 12 | 0.5 | 1.75 |

## Usage

### Basic Workflow

1. **Start ComfyUI** with the Ideogram 4.0 models loaded
2. **Open the panel** via **Window → ComfyUI_IdeogramGen.jsx**
3. **Configure connection** — Host/Port, click **Ping** to verify
4. **Set Quality and Megapixels** (0.5 / 1.0 / 1.5 / 2.0)
5. **Set Aspect ratio**, or enable **Match comp** to auto-select the closest supported ratio
6. **Fill in prompt parts** (see below)
7. **Optionally add elements** by selecting a shape layer with rectangle vector groups
8. **Set generation mode, seed, output folder, and AE folder**
9. **Click Generate**

### Prompt Parts (Structured Caption)

The panel assembles a JSON caption with these fields, sent as the prompt text:

- `high_level_description` — the overall scene description
- `style_description` (optional, gated by **Include style_description**) — `aesthetics`, `lighting`, `photo`, `medium`, and a shared `color_palette`
- `compositional_deconstruction` — `background` text plus an `elements` array built from the Elements panel

Each field can either be typed directly, or bound to a text layer via its **Layer** dropdown — when bound, the field becomes read-only and always reflects that layer's current text, even if it changes later in the timeline.

### Color Palettes

- **+** adds a manually picked swatch (AE's native color picker)
- **+ fill** opens a picker to choose a shape layer and one of its vector fill groups — the swatch then tracks that fill color live; if it's recolored later in AE, the swatch updates automatically
- Click a swatch to edit it (or change which layer/fill it tracks); **Alt+click** removes it

### Elements (Bounding Boxes)

1. Pick a **Shape layer** in the active comp
2. The panel scans the layer's vector groups for any group containing a Rectangle Path — each one becomes an element row
3. Per element: set **type** (`obj` / `text`), **desc** (the rect group's name, or a custom typed description), and **palette** (auto-detected fill color, or up to 5 custom swatches)
4. Bounding boxes `[y1,x1,y2,x2]` are computed automatically from the rectangle's size, position, and the layer's transform (anchor, position, scale, rotation), normalized to Ideogram's 0–1000 coordinate space, and update live as you move or resize the rectangle

### Generation Modes

| Mode | Behavior |
|---|---|
| **Single frame** | Generates from the current comp time; one image per variation |
| **Every frame** | Iterates every frame across the work area (or full comp duration), re-resolving prompt text and bounding boxes at each frame; one image per frame per variation, placed at that frame's exact time |

**Variations**: with Random or Increment seed mode, generate multiple images per run (disabled when seed mode is Fixed). **Stop** cancels the batch after the current image.

## Settings Reference

| Setting | Where to find it | Notes |
|---|---|---|
| Host / Port | Connection panel | ComfyUI server address |
| Quality | Quality dropdown | Quality / Default / Turbo step presets |
| Megapixels | MP dropdown | 0.5 / 1.0 / 1.5 / 2.0 |
| Aspect | Aspect dropdown / Match comp | 8 supported Ideogram ratios |
| Output folder | Generation → Output | Where downloaded images are saved; defaults to project folder, then `%TEMP%` |
| File prefix | Generation → File prefix | Prefix for filenames saved by ComfyUI |
| AE folder | Generation → AE folder | Project panel folder for imported footage; **Pick** uses the folder currently selected in the Project panel |

**Persistent files:**
- Settings: `%AppData%\ComfyIdeogramGen_Settings.json`
- Log: `%TEMP%\Comfy_IdeogramGen_Panel.log`

## Per-Composition Memory

Prompt parts (text and layer bindings), the color palette, shape layer selection, quality/megapixel/aspect choice, generation mode, seed settings, and folders are all remembered per composition during the session. Switching to a new, never-before-seen composition starts with a clean slate. Use **Reset** to clear the current composition's prompt content without touching generation preferences.

## Troubleshooting

### "Could not connect" / Status: not reachable
- Make sure ComfyUI is running and the host/port match your instance

### ComfyUI rejected workflow (HTTP error)
- Check that the Ideogram 4.0 model files and supporting nodes are installed and up to date

### "Nothing to send — fill at least one prompt part"
- At least one of `high_level_description`, the style fields, or `background` must have content before generating

### Bounding box shows "[bbox n/a]"
- The rectangle's geometry could not be read — check the shape layer's transform and the rect group's path

## Tips

- **Match comp** aspect automatically picks the closest of the 8 supported ratios
- Use **+ fill** swatches when you want a color to stay in sync with a shape layer that's still being designed — no need to re-pick the color after every tweak
- **Every frame** + **Work area only** is the fastest way to batch-generate a sequence — trim the work area to just the range you need
- The panel saves the project after each successful generation

## License

MIT License — Free for personal and commercial use

## Related Panels

- [Text2Image Panel](../Text2Image/) — Generate images from text prompts or AE text layers using local ComfyUI workflows
- [Image2Image Panel](../Image2Image/) — Transform existing image layers with AI using local ComfyUI workflows
- [CloudGen Panel](../Gemini/) — Generate images via Google Gemini through ComfyUI
- [JSON Reader Panel](../JsonReader/) — Inspect ComfyUI generation metadata from PNG files
