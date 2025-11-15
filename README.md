# **AE-ComfyUI-Panels**

Real-time AE → ComfyUI generative workflow

A set of After Effects ScriptUI panels that connect directly with ComfyUI.
Send prompts or selected layers from AE, generate images through your ComfyUI workflow, and automatically import the results back into your composition.
A streamlined AI-enhanced pipeline for motion graphics and design.

---

## 📦 **Download**

*(Add a ZIP or release build here if you want, matching your other repo format)*

---

## 🧠 **Concept**

These panels bridge **Adobe After Effects** and **ComfyUI**, enabling a smooth AI-generation workflow without leaving AE.
Depending on the panel, AE can:

1. Send a **text prompt** to ComfyUI (Text2Image),
2. Or send a **selected image layer** (Image2Image),
3. Process it using your ComfyUI workflow,
4. Retrieve the generated output into the AE project,
5. Optionally read JSON metadata (seed, settings, etc.) for reproducible generation.

This lets you build hybrid pipelines combining AE animation with AI-driven visuals.

---

## ✨ **Features**

* **Text2Image Panel**
  Generate images inside AE using prompt text.

* **Image2Image Panel**
  Select any image layer and generate variations through ComfyUI.

* **JSON Metadata Reader**
  Extract seed, CFG, steps, model info, etc., from ComfyUI’s JSON outputs.

* **Screenshots Folder**
  Visual reference for UI layout and workflow.

* **MIT License**
  Fully open for personal + commercial use.

---

## 📁 **Folder Structure**

```
AE-ComfyUI-Panels/
├── Text2Image/        # Text-to-image panel code
├── Image2Image/       # Image-to-image panel code
├── JsonReader/        # Metadata tools for AE
├── Screenshots/       # UI & workflow reference images
├── .gitignore
└── LICENSE
```

---

## 🖥️ **Requirements**

* Adobe After Effects (2022 or newer recommended)
* ComfyUI running locally (default: [http://127.0.0.1:8000](http://127.0.0.1:8000) )
* A compatible workflow for Image2Image or Text2Image

---

## ⚙️ **Installation**

1. Download or clone the repo:

   ```
   git clone https://github.com/ckonteos80/AE-ComfyUI-Panels.git
   ```
2. Copy the panel scripts into:

   ```
   Adobe After Effects / Support Files / Scripts / ScriptUI Panels/
   ```
3. Restart AE.
4. Access the panel from:

   ```
   Window → AE-ComfyUI Panel
   ```

---

## ▶️ **Usage**

### **Text-to-Image**

1. Open the Text2Image panel
2. Enter prompt + settings
3. Click **Generate**
4. The result imports directly into your AE project

### **Image-to-Image**

1. Select an image layer in AE
2. Open the Image2Image panel
3. Adjust parameters (denoise, strength, etc.)
4. Generate → result appears as a new imported layer

### **Metadata Reading**

Use the JsonReader tools to read ComfyUI’s JSON output into AE (seed, params, etc.).

---

## 🚧 **Roadmap**

* Batch prompt generation
* Live preview inside panel
* Progress indicator during ComfyUI rendering
* Multi-image return support
* Optional AE project template

---

## 📸 **Screenshots**

*(Insert images from `/Screenshots` here)*

---

## 📜 **License**

MIT License — free for commercial and non-commercial use.

---

## 👤 **Author**

Created by **@ckonteos80**
Contributions and pull requests welcome.
