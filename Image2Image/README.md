# ComfyUI Image2Image Panel for After Effects

> **Work in Progress** — This panel is functional but still under active development. Features and workflows may change.

A ScriptUI panel that enables AI-powered image-to-image generation using ComfyUI directly inside After Effects. Transform image layers in your composition without leaving AE.

![Image2Image Panel](https://github.com/user-attachments/assets/e6b77c8d-904a-48c6-9512-8705dc3a206c)

## Features

- **Smart Source Selection**: Choose any image layer from your composition, with optional render-with-effects support
- **Full Parameter Control**: Adjust denoise, steps, CFG, sampler, scheduler, seed, and resolution
- **Positive & Negative Prompts**: Negative prompt field appears automatically when the workflow supports it
- **Batch Variations**: Generate multiple variations with seed increment and denoise progression
- **Automatic Import**: Generated images are imported into your AE project and added to the active composition
- **Persistent Settings**: Host, port, workflow, and output folder saved between sessions
- **No External Dependencies**: Pure ExtendScript — no Python, no plugins

## Installation

1. In After Effects, go to **File → Scripts → Install ScriptUI Panel...**
2. Select `ComfyUI_Image2Image.jsx` and click Open
3. Restart After Effects
4. Open the panel via **Window → ComfyUI_Image2Image.jsx**

> **Note:** Enable script access if prompted:  
> **Edit → Preferences → Scripting & Expressions → Allow Scripts To Write Files And Access Network**

## Requirements

- Adobe After Effects CC 2018+
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) running locally or on the network
- A ComfyUI API-format workflow JSON with a `LoadImage` node

## Usage

1. **Start ComfyUI** with your desired model loaded
2. **Open the panel** via **Window → ComfyUI_Image2Image.jsx**
3. **Set host/port** to match your ComfyUI instance (default: `127.0.0.1:8188`)
4. **Choose a workflow** JSON file (API format — use File → Export → API Format in ComfyUI)
5. **Select a source layer** from the layer dropdown
6. **Enter your prompt** and adjust settings
7. **Click Generate** — results are imported directly into your project

## Workflow Requirements

Your ComfyUI workflow must contain:

- **`LoadImage`** — the panel uploads the source image and sets this node automatically
- **`CLIPTextEncode`** — the panel injects your prompt here
- **Sampler node** (`KSampler` or `KSamplerAdvanced`) — the panel sets seed, steps, CFG, denoise

Export from ComfyUI via **Settings → Enable Dev Mode**, then **Save (API Format)**.

## Troubleshooting

### "Could not connect to 127.0.0.1:8188"
- Ensure ComfyUI is running
- Check host/port settings match your ComfyUI instance
- Verify firewall is not blocking connections

### "No LoadImage node found"
- Workflow must include a `LoadImage` node
- Make sure you exported in API format, not UI/graph format

### Generated images not importing
- Check that After Effects has script file access enabled (see Installation note above)
- Verify the output folder is writable
- Check the log at `%TEMP%\Comfy_I2I_Panel.log`

## License

MIT License — Free for personal and commercial use

## Related Panels

- [Text2Image Panel](../Text2Image/) — Generate images from text prompts or AE text layers
- [JSON Reader Panel](../JsonReader/) — Inspect ComfyUI generation metadata from PNG files