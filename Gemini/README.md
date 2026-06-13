# ComfyUI CloudGen Panel for After Effects

A ScriptUI panel that routes prompts and reference images to Google Gemini models through a local ComfyUI instance. Generation is billed via ComfyUI credits (platform.comfy.org) — no Google API key required for the default models.

![CloudGen Panel](https://raw.githubusercontent.com/ckonteos80/Adobe-After-Effects-ComfyUI-Panels/main/Screenshots/Gemini.jpg)

## Features

- **4 Gemini model variants** in a single panel — Nano Banana and Nano Banana Pro, each available as a ComfyUI-credit node or a Google-API-key PromptModel node
- **Text-to-Image and Image-to-Image** — mode is auto-detected: T2I when no reference slots are active, I2I when one or more slots have a layer assigned
- **Flexible prompt sources**: type a prompt manually, auto-use the topmost active text layer (tracks changes across the work area), or pick a specific named text layer
- **Reference image slots** (up to 5 or 14 depending on model): assign a specific layer, or use dynamic `[Top image layer]` / `[Lowest image layer]` — the panel resolves the correct layer at each point in time
- **FX rendering** — render a slot through After Effects effects before uploading (requires an "PNG After 2 Comfy" output module template)
- **Match comp aspect ratio** — automatically selects the closest supported ratio for the active composition
- **Resolution control** — 1K / 2K / 4K (model-dependent)
- **Variations** — generate 1–10 images per prompt or per timeline segment in one run
- **Composition-aware generation planner** — when using dynamic slots and a text-layer prompt source, automatically segments the work area at every transition point and generates one batch per unique segment
- **Cost confirmation dialog** — shows the full generation plan (prompts, references, aspect, resolution, variations) with estimated credit cost before anything is submitted
- **Automatic import** — results are imported into your AE project, placed in the timeline at the correct in/out range, scaled to fit the comp, and renamed with batch context
- **Per-composition memory** — model choice, slots, prompt, folders, and output settings are saved and restored per composition
- **Session cost tracker** — running count of images generated and credits used in the current session
- **Persistent settings** — host, port, API keys, and file prefix are saved between sessions
- **No external dependencies** — pure ExtendScript + Socket HTTP

## Installation

1. In After Effects, go to **File → Scripts → Install ScriptUI Panel...**
2. Select `ComfyUI_Gemini.jsx` and click Open
3. Restart After Effects
4. Open the panel via **Window → ComfyUI_Gemini.jsx**

> **Note:** Enable script access if prompted:  
> **Edit → Preferences → Scripting & Expressions → Allow Scripts To Write Files And Access Network**

## Requirements

- Adobe After Effects CC 2018+
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) running locally or on your network (default: `127.0.0.1:8000`)
- ComfyUI credits account at [platform.comfy.org](https://platform.comfy.org) — for the **ComfyUI-variant** models (Nano Banana and Nano Banana Pro)
- [COMFYUI_PROMPTMODELS](https://github.com/cdanielp/COMFYUI_PROMPTMODELS) custom nodes and a Google AI API key — for the **PromptModel-variant** models only
- An AE output module template named **"PNG After 2 Comfy"** — required only when using FX rendering on reference slots (see [FX Rendering](#reference-slots--fx-rendering))

## Models

| Display Name | Underlying model | ComfyUI node | Max refs | API key type | Resolution |
|---|---|---|---|---|---|
| Nano Banana Pro (ComfyUI) | gemini-3-pro-image-preview | `GeminiImage2Node` | 14 | ComfyUI credits | 1K / 2K / 4K |
| Nano Banana (ComfyUI) | gemini-2.5-flash-image-preview | `GeminiImageNode` | 5 | ComfyUI credits | — |
| Nano Banana Pro (PromptModel) | gemini-3-pro-image-preview | `GoogleAI_NanoBananaNode` | 5 | Google AI | 1K / 2K / 4K |
| Nano Banana (PromptModel) | gemini-2.5-flash-image-preview | `GoogleAI_NanoBananaNode` | 5 | Google AI | 1K / 2K / 4K |

The ComfyUI-variant models use the `GeminiImageNode` / `GeminiImage2Node` / `BatchImagesNode` nodes built into ComfyUI — no custom node pack required. The PromptModel variants use [`GoogleAI_NanoBananaNode`](https://github.com/cdanielp/COMFYUI_PROMPTMODELS) from the COMFYUI_PROMPTMODELS pack and require a Google AI API key instead of ComfyUI credits.

## Usage

### Basic Workflow

1. **Start ComfyUI** with the required Gemini nodes available

2. **Open the panel** via **Window → ComfyUI_Gemini.jsx**

3. **Configure connection**:
   - Host: `127.0.0.1` (default)
   - Port: `8000` (default)
   - Click **Ping** to verify

4. **Choose a model** from the Model dropdown

5. **Enter your API key** in the Settings section:
   - *ComfyUI credits models*: paste your [platform.comfy.org](https://platform.comfy.org) API key into **ComfyOrg Key**
   - *PromptModel variants*: paste your Google AI key into **Google Key**

6. **Set the prompt source**:
   - *Type prompt*: enter text in the prompt field
   - *[Top text layer]*: the topmost active text layer at each point in the work area is used automatically
   - *Specific text layer*: a named layer's text is used as-is

7. **Add reference slots** (optional — activates Image-to-Image mode):
   - Click **+ Add reference** to add a slot
   - Pick a layer from the dropdown, or enable the **▲ Top** / **▼ Low** checkboxes for dynamic layer tracking
   - Enable **FX** if you want the layer rendered with its After Effects effects applied

8. **Set output options**:
   - **Aspect**: "Match comp" automatically selects the closest supported ratio
   - **Resolution**: 1K / 2K / 4K (hidden for models that don't support it)
   - **Variations**: number of images per prompt or per timeline segment

9. **Click Generate**:
   - The cost confirmation dialog appears — review all planned jobs and estimated credits
   - Confirm to submit; results are downloaded and imported into your project automatically

### Reference Slots & FX Rendering

Each reference slot can be configured in one of three modes:

| Mode | Description |
|---|---|
| Named layer (dropdown) | A specific footage or precomp layer — its source file is sent directly |
| **▲ Top** checkbox | The topmost active image layer at each generation's key frame — resolved dynamically |
| **▼ Low** checkbox | The bottommost (lowest in stack) active image layer at each key frame |

**FX checkbox**: when enabled, the slot is rendered through the AE render queue so After Effects effects are applied before uploading. This requires an output module template named **"PNG After 2 Comfy"** to exist in AE (create it via **Edit → Templates → Output Module**).

Only one slot can claim Top and one can claim Lowest. If Top and Lowest resolve to the same layer at a given frame, the duplicate is silently dropped and the layer is sent once.

### Composition-Aware Generation Planner

When the prompt source is **[Top text layer]** and at least one slot uses **▲ Top** or **▼ Low**, the panel analyzes the full work area and finds every point where either the topmost text layer or the reference image changes. It creates one generation job per unique combination, so you can lay out a timeline with alternating prompts and reference images and generate a full set in a single click.

Each generated image is imported and placed in the timeline at exactly the time range it corresponds to, scaled to fit the comp, and renamed with its segment and variation number.

### Cost Confirmation Dialog

Before submitting anything to ComfyUI, the panel shows a resizable dialog listing every planned generation: prompt, reference layers, aspect ratio, resolution, variation count, and the total estimated credit cost. Click **Generate** to proceed or **Cancel** to return to the panel.

## Settings Reference

| Setting | Where to find it | Notes |
|---|---|---|
| ComfyOrg API key | Settings → ComfyOrg Key | Used by Nano Banana (ComfyUI) and Nano Banana Pro (ComfyUI) |
| Google AI API key | Settings → Google Key | Used by PromptModel variants |
| Output folder | Settings → Output folder | Where downloaded images are saved; defaults to project folder |
| AE project panel folder | Settings → AE folder | Folder path inside the AE Project panel for imported footage (e.g. `CloudGen/Renders`). Leave blank for root. |
| File prefix | Settings → File prefix | Prefix for filenames saved by ComfyUI (e.g. `CloudGen` → `CloudGen_00001_.png`) |

**Persistent files:**
- Settings: `%AppData%\ComfyCloudGen_Settings.json`
- Log: `%TEMP%\Comfy_CloudGen_Panel.log`

## Troubleshooting

### "Could not connect to 127.0.0.1:8000"
- Make sure ComfyUI is running
- Check that the host and port in the panel match your ComfyUI instance
- Verify no firewall is blocking the connection

### Node errors / "execution_error" from ComfyUI
- The ComfyUI-variant models require `GeminiImageNode`, `GeminiImage2Node`, and `BatchImagesNode` to be available in your ComfyUI installation
- The PromptModel variants require `GoogleAI_NanoBananaNode`
- Make sure you selected the correct model variant for the nodes you have installed

### "Output module template 'PNG After 2 Comfy' not found"
- This is only needed when **FX** is enabled on a reference slot
- Create the template in AE: **Edit → Templates → Output Module**, set format to PNG, save as "PNG After 2 Comfy"

### "Nothing to generate"
- Prompt source is **[Top text layer]** but no text layers are active in the work area
- I2I mode was triggered (a slot is active) but the planner could not resolve a layer for the required frame — check the log for details

### Credit or authentication errors from ComfyUI
- Verify your ComfyOrg API key at [platform.comfy.org](https://platform.comfy.org) → Account → API Keys
- Check your credit balance

### Sliders or dropdowns reset when switching compositions
- This is the per-comp memory system restoring that composition's saved state
- Use **Clear comp memory** to reset the active comp to defaults

## Tips

- **Match comp** aspect automatically finds the closest supported ratio — you don't need to calculate it manually
- Per-comp memory means each composition remembers its own model, slots, and settings; switching between comps restores the right configuration instantly
- Use the **session counter** at the bottom of the panel to track how many images and credits a batch run cost; click **Reset session counter** before starting a new batch
- **Clear comp memory** resets only the active comp; **Clear all comps memory** resets every composition
- When using dynamic **▲ Top** / **▼ Low** slots with a text-layer prompt, lay your reference images and text layers in the timeline and the planner will handle the segmentation automatically
- The panel saves the project after each successful generation

## License

MIT License — Free for personal and commercial use

## Related Panels

- [Text2Image Panel](../Text2Image/) — Generate images from text prompts or AE text layers using local ComfyUI workflows
- [Image2Image Panel](../Image2Image/) — Transform existing image layers with AI using local ComfyUI workflows
- [JSON Reader Panel](../JsonReader/) — Inspect ComfyUI generation metadata from PNG files
