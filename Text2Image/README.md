# ComfyUI Text2Image Panel for After Effects

A ScriptUI panel that brings text-to-image AI generation directly into Adobe After Effects via ComfyUI.

![Text2Image Panel](https://raw.githubusercontent.com/ckonteos80/Adobe-After-Effects-ComfyUI-Panels/main/Screenshots/Text2ImagePanel.jpg)

## Features

- **Text-to-Image Generation**: Generate AI images from text prompts without leaving After Effects
- **Text Layer Mode**: Automatically generate one image per enabled text layer in the active composition
- **Variations**: Generate multiple images per prompt or layer with Fixed, Random, or Increment seed modes
- **Full Parameter Control**: Adjust resolution, steps, CFG, sampler, scheduler, denoise, and seed settings
- **Positive & Negative Prompts**: Fine-tune your generations with detailed prompt control
- **Output Folder**: Choose where generated images are saved on disk
- **Workflow Caching**: Instant loading of previously used workflows with automatic cache invalidation
- **API Introspection**: Dynamically loads available samplers and schedulers from your ComfyUI installation
- **Current Value Extraction**: Automatically applies workflow's existing parameter values to the UI
- **Automatic Import**: Generated images are automatically imported into your After Effects project
- **Persistent Settings**: Host, port, workflow, and output folder preferences are saved between sessions

## Installation

1. Copy `ComfyUI_Text2Image.jsx` to your After Effects Scripts folder:
   ```
   C:\Users\[Username]\AppData\Roaming\Adobe\After Effects\[Version]\Scripts\ScriptUI Panels\
   ```
   
2. Restart After Effects

3. Open the panel via **Window → ComfyUI_Text2Image.jsx**

## Requirements

- Adobe After Effects (tested on 2024+)
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) running locally or on network
- ComfyUI API workflow JSON file (text-to-image workflow)

## Usage

### Basic Workflow

1. **Start ComfyUI** with your desired checkpoint/model loaded

2. **Configure Connection**:
   - Host: `127.0.0.1` (default)
   - Port: `8000` (ComfyUI default)

3. **Select Workflow**:
   - Click **Choose...** to select your ComfyUI API workflow JSON
   - The panel connects to ComfyUI to load available samplers, schedulers, and parameter ranges
   - Current workflow values (steps, CFG, etc.) are pre-populated into the UI

4. **Choose Prompt Mode**:
   - **Manual prompt** (default): type your prompt in the Prompt text box
   - **Use all enabled text layers**: tick this checkbox to generate one image per enabled, unlocked text layer in the active comp — each layer's text becomes the prompt

5. **Set Generation Parameters**:
   - **Positive Prompt**: Describe what you want to generate (manual mode)
   - **Negative Prompt**: Specify what to avoid (shown only when the workflow supports it)
   - **Sampler**: Choose from dynamically loaded samplers (euler, dpmpp_2m, etc.)
   - **Scheduler**: Select scheduler (karras, exponential, etc.)
   - **Steps**: Number of sampling steps (range varies by workflow)
   - **CFG**: Classifier-Free Guidance scale (range varies by workflow)
   - **Denoise**: Denoising strength (shown only for workflows that include a denoise parameter, e.g. img2img)

6. **Set Image Dimensions**:
   - **Use comp size**: Automatically match active composition dimensions
   - **Manual**: Enter custom width/height
   - **Snap**: Snap dimensions to multiples (64 for SDXL/Flux, 8 for SD1.5)
   - **Max W/H**: Cap maximum dimensions

7. **Configure Seed**:
   - **Fixed**: Use a specific seed for reproducible results
   - **Random per run**: Generate a new random seed for each image
   - **Increment**: Start from the seed value and increment by 1 for each variation
   - **Variations**: Number of images to generate per prompt or text layer (available with Random and Increment modes)

8. **Set Output Folder**:
   - Click **Choose...** in the Output Folder panel to set where images are saved
   - Defaults to the project folder, or the system temp folder if no project is saved

9. **Click Generate**:
   - The panel submits the request to ComfyUI and polls for completion
   - Progress is shown in the status bar
   - Each generated image is automatically imported into your After Effects project and added to the active composition

10. **View Log**: Click **View Log** in the footer to open the log file for troubleshooting

### Workflow Caching

The panel caches workflow information for instant loading:

- **Cached Dropdown**: Select previously loaded workflows from the "Cached:" dropdown
- **Instant Loading**: Cached workflows load without API calls (0 seconds vs 2-3 seconds)
- **Auto-Invalidation**: Cache automatically refreshes if the workflow file is modified on disk
- **Clear Cache**: Remove all cached workflows with the "Clear Cache" button

### Advanced Features

#### API Introspection
The panel automatically:
- Fetches available samplers and schedulers from ComfyUI
- Extracts min/max ranges for steps, CFG, and other parameters
- Detects whether the workflow supports negative prompts
- Adapts UI controls to match workflow capabilities

#### Current Value Extraction
When loading a workflow, the panel:
- Reads current parameter values from the workflow JSON
- Pre-populates sliders and dropdowns with these values
- Ensures you start with the workflow's intended settings

#### Dimension Handling
- **Snap to Grid**: Ensures dimensions are multiples of 8 or 64 (important for latent space)
- **Max Caps**: Prevents VRAM overflow by capping dimensions
- **Comp Integration**: Automatically uses composition dimensions if enabled

#### Text Layer Batch Mode
When **Use all enabled text layers** is checked:
- Every enabled, unlocked text layer in the active comp is processed in order
- Each layer's text content becomes the positive prompt
- Generated images are matched to the layer's in/out timing and placed at the top of the comp
- Combine with **Variations** to generate multiple images per layer in one click

## Supported Node Types

The panel reads and writes specific node types. Everything else in the workflow is passed through untouched.

### Prompt nodes — panel injects your text here
| Node | Field(s) written | Used by |
|------|-----------------|---------|
| `CLIPTextEncode` | `text` | SD3, Flux.2, Qwen Image |
| `CLIPTextEncodeFlux` | `clip_l`, `t5xxl` | Flux.1 |

### Sampler nodes — panel reads ranges and writes parameters
| Node | Fields | Notes |
|------|--------|-------|
| `KSampler` | seed, steps, cfg, sampler_name, scheduler, denoise | Standard workflows |
| `KSamplerAdvanced` | same + add_noise, start/end_at_step | Advanced workflows |
| `KSamplerSelect` | sampler_name | Flux.2 custom-advanced pipeline |

### Seed node — Flux custom-advanced pipeline only
| Node | Field | Notes |
|------|-------|-------|
| `RandomNoise` | `noise_seed` | Used when the sampler node has no seed field |

### Latent / dimension nodes — panel writes width and height
| Node | Used by |
|------|---------|
| `EmptyLatentImage` | SD1.5, SDXL |
| `EmptySD3LatentImage` | SD3, Flux.1, Qwen Image |
| `EmptyFlux2LatentImage` | Flux.2 |
| `Flux2Scheduler` | Flux.2 (also carries steps) |
| `LatentUpscale` | upscale workflows |
| `LatentUpscaleBy` | upscale workflows |

> **Note:** Dimension injection only applies to nodes where `width`/`height` are plain numbers. Array-valued connections (e.g. a `GetImageSize` output wired in) are left untouched.

### Model nodes — read-only, used for display in AE
| Node | Field read |
|------|-----------|
| `CheckpointLoaderSimple` / `CheckpointLoader` | `ckpt_name` |
| `UNETLoader` | `unet_name` |

## Example Workflows

Ready-to-use API-format workflow JSONs are included in the [`API/`](API/) folder:

| File | Model Family | Sampler | Prompt Node | Latent Node |
|------|-------------|---------|-------------|-------------|
| [Flux1_LoRA.json](API/Flux1_LoRA.json) | Flux.1 + LoRA | `KSampler` | `CLIPTextEncodeFlux` | `EmptySD3LatentImage` |
| [Flux1_no_LoRA.json](API/Flux1_no_LoRA.json) | Flux.1 | `KSampler` | `CLIPTextEncodeFlux` | `EmptySD3LatentImage` |
| [Flux2_LoRA.json](API/Flux2_LoRA.json) | Flux.2 + LoRA | `SamplerCustomAdvanced` | `CLIPTextEncode` | `EmptyFlux2LatentImage` |
| [Flux2_NoLoRA.json](API/Flux2_NoLoRA.json) | Flux.2 | `SamplerCustomAdvanced` | `CLIPTextEncode` | `EmptyFlux2LatentImage` |
| [Flux2_Image_Reference.json](API/Flux2_Image_Reference.json) | Flux.2 image-reference | `SamplerCustomAdvanced` | `CLIPTextEncode` | `EmptyFlux2LatentImage` |
| [qwen_image_illustration_lora.json](API/qwen_image_illustration_lora.json) | Qwen Image + LoRA | `KSampler` | `CLIPTextEncode` (pos + neg) | `EmptySD3LatentImage` |

All files are exported in **API format** from ComfyUI (not the UI/graph format).

## Keyboard Shortcuts

- **Tab**: Navigate between fields
- **Enter**: In text fields applies changes
- **Slider + Drag**: Adjust values smoothly
- **Text Field Entry**: Type exact values for precise control

## Troubleshooting

### "Could not connect to 127.0.0.1:8188"
- Ensure ComfyUI is running
- Check host/port settings match your ComfyUI instance
- Verify firewall isn't blocking connections

### "No sampler node found in workflow"
- Workflow must contain a `KSampler`, `KSamplerAdvanced`, or `KSamplerSelect` node
- Export workflow as API format (not UI format)

### "Workflow file modified, invalidating cache"
- Normal behavior when workflow is edited
- Panel will reload fresh data from ComfyUI API

### Sliders show wrong ranges
- Click "Choose..." to reload workflow
- Cache will refresh automatically if the file was modified
- Use "Clear Cache" to force a complete refresh

### Negative prompt disabled
- Workflow must have a second `CLIPTextEncode` (or `CLIPTextEncodeFlux`) node connected as negative conditioning
- Panel auto-detects support when loading the workflow

### Denoise slider not visible
- Only shown for workflows where the sampler node includes a `denoise` parameter
- Typical for img2img workflows; hidden for pure text-to-image

## Cache File Locations

- **Settings**: `%AppData%\ComfyText2Image_Settings.json`
- **Workflow index**: `%AppData%\ComfyText2Image_CacheIndex.json`
- **Per-workflow cache**: `%AppData%\ComfyText2Image_Cache_<workflow-name>.json`
- **Log file**: `%TEMP%\Comfy_Text2Image_Panel.log`

## Tips

- Use **Fixed seed** for consistent results across generations
- **Random per run** is great for exploring variations; set **Variations** > 1 to batch them
- **Increment** seed steps through a sequence — useful for comparing nearby seeds
- **Text Layer Mode** + **Variations** lets you batch-generate multiple interpretations of every layer in one click
- **Workflow caching** makes switching between workflows instant
- **Snap to 64** for SDXL and Flux models, **snap to 8** for SD1.5
- Click **View Log** in the footer if something goes wrong
- The panel remembers your last used settings, workflow, and output folder

## License

MIT License - Free for personal and commercial use

## Related Panels

- [Image2Image Panel](../Image2Image/) - Transform existing images with AI
- [JSON Reader Panel](../JsonReader/) - Inspect ComfyUI generation metadata
