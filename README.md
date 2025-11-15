AE-ComfyUI-Panels
Connect Adobe After Effects with ComfyUI for AI-powered image generation

This repository contains a set of After Effects ScriptUI Panels designed to send prompts or images from AE directly to ComfyUI and automatically import the generated results back into your project.
A streamlined workflow for artists who want AI generation inside their motion-graphics pipeline.

🔧 What This Project Does

Adds custom ScriptUI panels to After Effects.

Lets you trigger ComfyUI workflows from inside AE.

Supports Text-to-Image and Image-to-Image generation.

Automatically imports the generated output (PNG/JPG/Sequences).

Includes tools for reading ComfyUI JSON metadata such as seeds, CFG, resolution, etc.

✨ Features

Text2Image Panel
Generate AI images using text prompts directly inside AE.

Image2Image Panel
Select a layer in your comp → send it to ComfyUI → get a styled or modified result.

JSON Metadata Reader
Extract parameters such as seed / steps / model used — useful for documentation or expressions.

Screenshots Folder
Preview of UI layouts and workflow steps.

MIT License
Free for personal and commercial use.

📁 Folder Structure
AE-ComfyUI-Panels/
├── Text2Image/        # Text-to-image panel code
├── Image2Image/       # Image-to-image panel code
├── JsonReader/        # Metadata tools for AE
├── Screenshots/       # UI and workflow visuals
├── .gitignore
└── LICENSE

🖥️ Requirements

Adobe After Effects (2022 or later recommended)

ComfyUI running locally (default: http://127.0.0.1:8000
)

A compatible ComfyUI workflow for T2I or I2I generation

⚙️ Installation

Download or clone the repo:

git clone https://github.com/ckonteos80/AE-ComfyUI-Panels.git


Copy the panel scripts into:

Adobe After Effects / Support Files / Scripts / ScriptUI Panels/


Restart After Effects.

Open the panel from:

Window → AE-ComfyUI Panel

▶️ How It Works
Text-to-Image

Open the T2I panel.

Enter your prompt & settings (seed, size, steps).

Click Generate.

ComfyUI renders the image → panel imports it into your project.

Image-to-Image

Select a layer in AE.

Open the I2I panel.

Configure denoise/strength settings.

Generate variations → results appear in AE as new layers.

JSON Reading

Use the tools inside JsonReader/ to import metadata (seed, model, steps, etc.) into comments or expressions.

🛣️ Roadmap

Batch generation for multiple prompts

Live preview inside AE panel

Progress indicator during ComfyUI generation

Multi-image return support

Optional starter AE project template

📸 Screenshots

(Add your images from /Screenshots here)

📜 License

This project is under the MIT License.
See the LICENSE file for details.
