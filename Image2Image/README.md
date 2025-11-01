
A powerful After Effects panel that enables AI-powered image-to-image generation using ComfyUI directly within your AE workflow. Transform your compositions with AI without leaving After Effects!

![Image2ImagePanel](https://github.com/user-attachments/assets/e6b77c8d-904a-48c6-9512-8705dc3a206c)


## 🌟 Features

- **Direct ComfyUI Integration**: Connect to your local ComfyUI instance via HTTP API
- **No External Dependencies**: Pure ExtendScript implementation - no additional tools required
- **Smart Source Selection**: Choose from image layers in your composition or render with effects/transforms
- **Workflow Support**: Load your custom ComfyUI workflows (API format required)
- **Batch Generation**: Create multiple variations with intelligent seed and denoise progression
- **Automatic Import**: Generated images are automatically added to your composition
- **Settings Persistence**: Connection settings and preferences are saved between sessions
- **Comprehensive Logging**: Detailed logs help troubleshoot any issues

## 🚀 Installation

1. **Download** ComfyUI_Image2Image.jsx
2. **Copy** the file to your After Effects Scripts folder:
   - **Windows**: `C:\Program Files\Adobe\Adobe After Effects [version]\Support Files\Scripts\ScriptUI Panels\`
   - **macOS**: `/Applications/Adobe After Effects [version]/Scripts/ScriptUI Panels/`
3. **Restart** After Effects
4. **Open** the panel via `Window > ComfyUI_Image2Image.jsx`

## 📋 Prerequisites

- **After Effects** CC 2018 or later
- **ComfyUI** running locally (default: `127.0.0.1:8188`)
- **Workflow File** exported from ComfyUI in API format

## 🎯 Quick Start

1. **Start ComfyUI** on your local machine
2. **Open the panel** in After Effects
3. **Choose a workflow** JSON file (must be API format from ComfyUI)
4. **Select a source layer** containing an image
5. **Enter your prompt** and adjust generation settings
6. **Click Generate** to create AI variations

## ⚙️ Panel Sections

### Connection Settings
- **Host/Port**: ComfyUI server connection (default: 127.0.0.1:8188)
- **Workflow**: Path to your ComfyUI API workflow JSON file

### Prompt & Generation
- **Positive Prompt**: Describe what you want to generate
- **Negative Prompt**: Automatically enabled if workflow supports it
- **Denoise**: Control how much the AI modifies the source (0.0-1.0)

### Sampling Parameters
- **Sampler**: Choose generation algorithm (euler, euler_a, dpmpp_2m, etc.)
- **Scheduler**: Noise scheduling method
- **Steps**: Number of denoising steps (1-80)
- **CFG**: Classifier-free guidance strength (1.0-20.0)

### Size Controls
- **Use Comp Size**: Automatically match composition dimensions
- **Manual Size**: Set custom width/height
- **Snap**: Force dimensions to multiples (8, 64 for SDXL compatibility)
- **Max Dimensions**: Cap maximum output size

### Seed & Variations
- **Fixed Seed**: Use consistent seed for reproducible results
- **Random Seed**: Generate unique results each time
- **Variations**: Create multiple versions in one batch
- **Denoise Increment**: Progressively adjust denoise for variations

### Source Image
- **Layer Selection**: Choose from available image layers
- **Render with Effects**: Render comp as-is vs. use raw source file
- **Auto-Refresh**: Layer list updates when composition changes

### Output
- **Output Folder**: Choose where generated images are saved
- **Add to Comp**: Automatically import results as new layers

## 🔧 Workflow Setup

1. **Create your workflow** in ComfyUI interface
2. **Include required nodes**:
   - `LoadImage` node for source image input
   - `CLIPTextEncode` for positive prompt
   - Optional: Second `CLIPTextEncode` for negative prompt
   - Sampler nodes with standard parameters
3. **Export as API format**:
   - Enable "Dev mode" in ComfyUI settings
   - Click "Save (API Format)" button
4. **Load the exported JSON** in the After Effects panel

### Required Workflow Nodes
Your workflow must contain:
- **LoadImage**: Panel automatically uploads and sets image filename
- **CLIPTextEncode**: Panel injects your prompt text
- **Sampler nodes**: Panel sets seed, steps, CFG, denoise parameters
- **Output nodes**: Panel downloads generated results

## 💡 Usage Tips

- **Project Organization**: Generated images save to your project folder by default
- **Batch Processing**: Use variations with denoise increment for creative exploration
- **Effect Rendering**: Enable "Render with effects" to use masked/transformed layers
- **Template Creation**: Save output module template "PNG After 2 Comfy" for optimal rendering
- **Memory Management**: Large batches are processed sequentially to avoid memory issues

## 🐛 Troubleshooting

### Common Issues

**"Could not connect to 127.0.0.1:8188"**
- Ensure ComfyUI is running and accessible
- Check firewall settings
- Verify host/port settings

**"No LoadImage node found"**
- Workflow must include a LoadImage node
- Export workflow in API format, not regular format

**"Template 'PNG After 2 Comfy' not found"**
- Create a PNG output module template with this exact name
- Or panel will use default PNG settings

**Generated images not importing**
- Check After Effects permissions
- Verify output folder is writable
- Check log file for detailed error messages

### Log Files
- **Panel Log**: `%TEMP%/Comfy_I2I_Panel.log` (Windows) or `/tmp/Comfy_I2I_Panel.log` (macOS)
- **Settings**: `%USERPROFILE%/ComfyI2I_Settings.json` (Windows) or `~/ComfyI2I_Settings.json` (macOS)

## 🤝 Contributing

Contributions are welcome! Please feel free to:
- Report bugs via GitHub Issues
- Suggest new features
- Submit pull requests
- Share workflow examples

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- **ComfyUI** team for the excellent node-based AI interface
- **Adobe** for the ExtendScript scripting environment
- **Stability AI** for Stable Diffusion and SDXL models

---

**Made with ❤️ for the After Effects and AI art community**

For support and updates, visit the [GitHub repository](https://github.com/your-username/ComfyUI-Image2Image-AE-Panel).
