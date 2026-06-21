/* ComfyUI IdeogramGen Panel — Local image generation via ComfyUI + Ideogram 4.0
   Drives ComfyUI's native Ideogram 4.0 text-to-image graph from After Effects.

   The Ideogram prompt is a structured JSON caption assembled from panel fields:
     high_level_description, style_description{aesthetics,lighting,photo,medium,color_palette},
     compositional_deconstruction{ background, elements[] }
   Element bounding boxes are derived automatically from the comp positions of the
   currently SELECTED layers (shape layer -> "obj", text layer -> "text").

   Pure ExtendScript + Socket HTTP; no external dependencies.
   Based on the CloudGen panel architecture (shared socket/HTTP/poll/import infra).

   Injection points in the embedded workflow:
     98:24  CLIPTextEncode.text     <- assembled JSON caption
     98:18  RandomNoise.noise_seed  <- seed
     37     ResolutionSelector.aspect_ratio / megapixels
     98:156 CustomCombo.choice      <- quality tier (Quality / Default / Turbo)
*/

(function(thisObj) {

  // ============================================================
  // CONSTANTS
  // ============================================================
  var DEFAULT_HOST = "127.0.0.1";
  var DEFAULT_PORT = "8188";
  var POLL_MS = 1000;

  var SETTINGS_FILE = new File(Folder.userData.fsName + "/ComfyIdeogramGen_Settings.json");
  var LOG = new File(Folder.temp.fsName + "/Comfy_IdeogramGen_Panel.log");

  // ResolutionSelector lives in a node we inject into.
  var RESOLUTION_NODE = "37";
  var PROMPT_NODE     = "98:24";   // CLIPTextEncode (positive)
  var SEED_NODE       = "98:18";   // RandomNoise
  var QUALITY_NODE    = "98:156";  // CustomCombo
  var SAVE_NODE       = "158";     // SaveImage

  // Quality tier -> CustomCombo.choice
  var QUALITY_OPTIONS = [
    { label: "Quality (48 steps)", choice: "Quality" },
    { label: "Default (20 steps)", choice: "Default" },
    { label: "Turbo (12 steps)",   choice: "Turbo"   }
  ];

  var MEGAPIXEL_OPTIONS = ["0.5", "1.0", "1.5", "2.0"];

  // Used only until /object_info is reachable; live list overrides this.
  var ASPECT_FALLBACK = [
    "1:1 (Square)",
    "3:2 (Photo)",
    "4:3 (Standard)",
    "16:9 (Widescreen)",
    "21:9 (Ultrawide)",
    "2:3 (Portrait Photo)",
    "3:4 (Portrait Standard)",
    "9:16 (Portrait Widescreen)"
  ];

  var LAYER_NONE = "\u2014 none \u2014";   // "— none —"

  var MAX_PALETTE_IMAGE   = 16;
  var MAX_PALETTE_ELEMENT = 5;

  // ============================================================
  // NAMESPACE
  // ============================================================
  if (!$._comfyIdeogramPanel) { $._comfyIdeogramPanel = {}; }

  // ============================================================
  // LOGGING
  // ============================================================
  function log(s){
    try{
      if (!LOG) return;
      LOG.open("a");
      LOG.writeln(new Date().toISOString() + "  " + s);
      LOG.close();
    } catch(e) {}
  }
  log("=== IdeogramGen Panel initialized ===");

  // ============================================================
  // SETTINGS
  // ============================================================
  function loadSettings(){
    var defaults = {
      host: DEFAULT_HOST, port: DEFAULT_PORT, outputFolder: "",
      lastQuality: "Default", lastMegapixels: "1.0",
      lastAspect: "match_comp", lastVariations: 1,
      seedMode: "random", lastSeed: 0, lastSeedStep: 1,
      sessionCount: 0,
      genMode: "single", workAreaOnly: true,
      filenamePrefix: "Ideogram_AE", aeProjectFolder: ""
    };
    if (!SETTINGS_FILE.exists) return defaults;
    try {
      if (SETTINGS_FILE.open("r")){
        var json = SETTINGS_FILE.read(); SETTINGS_FILE.close();
        if (!json) return defaults;
        var s = JSON.parse(json);
        for (var k in defaults) if (defaults.hasOwnProperty(k) && s[k] === undefined) s[k] = defaults[k];
        return s;
      }
    } catch(e){ log("loadSettings error: " + e); }
    return defaults;
  }
  function saveSettings(s){
    try { if (SETTINGS_FILE.open("w")){ SETTINGS_FILE.write(JSON.stringify(s)); SETTINGS_FILE.close(); } }
    catch(e){ log("saveSettings error: " + e); }
  }

  // ============================================================
  // UTILITY HELPERS
  // ============================================================
  function die(msg, detail){ log("FAIL: " + msg + " :: " + (detail || "")); throw new Error(msg); }
  function sleep(ms){ $.sleep(ms); }
  function rand32(){ var n = Math.floor(Math.random() * 0xFFFFFFFF); if (n < 0) n += 0x100000000; return n; }
  function rand53(){ // larger seed range like the workflow's example
    return Math.floor(Math.random() * 9007199254740990) + 1;
  }
  function currentSeedMode(){
    var t = seedModeDrop.selection ? seedModeDrop.selection.text : "Random";
    if (t === "Fixed") return "fixed";
    if (t === "Increment") return "increment";
    return "random";
  }
  function nextSeed(seedMode, seedBase, index, step){
    if (seedMode === "fixed") return seedBase;
    if (seedMode === "increment") return seedBase + index * (step || 1);
    return rand53();
  }
  function updateSeedVarEnabled(){
    var mode = currentSeedMode();
    seedEdit.enabled = (mode === "fixed" || mode === "increment");
    stepEdit.enabled = (mode === "increment");
    varEdit.enabled = (mode === "random" || mode === "increment");
  }
  function pad(n, d){ var s = String(n); while(s.length < d) s = "0" + s; return s; }
  function basename(p){ return String(p).replace(/^[\\\/]+/,"").split(/[\\\/]/).pop(); }
  function deepCopy(o){ return JSON.parse(JSON.stringify(o)); }
  function trim(s){ return (s == null) ? "" : String(s).replace(/^\s+|\s+$/g, ""); }
  function isEmptyObj(o){ for (var k in o) if (o.hasOwnProperty(k)) return false; return true; }
  function arrIndexOf(arr, val){ for (var i = 0; i < arr.length; i++) if (arr[i] === val) return i; return -1; }
  function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }
  function toBytes(str){
    var out=[],c;
    for(var i=0;i<str.length;i++){ c=str.charCodeAt(i);
      if(c<=0x7F) out.push(c);
      else if(c<=0x7FF){ out.push(0xC0|(c>>6),0x80|(c&0x3F)); }
      else{ out.push(0xE0|(c>>12),0x80|((c>>6)&0x3F),0x80|(c&0x3F)); }
    } return out;
  }
  function readAll(sock){ var chunks=[]; while(!sock.eof){ var p=sock.read(8192); if(!p) break; chunks.push(p);} return chunks.join(""); }

  // ============================================================
  // HTTP LAYER (Socket-based, plain HTTP to local ComfyUI)
  // ============================================================
  function httpRequest(method, path, headers, bodyStr, wantBinary, allowErrors, host, port){
    var s = new Socket();
    if (!s.open(host + ":" + port, "BINARY")) die("Could not connect to "+host+":"+port);
    var CRLF="\r\n";
    var req = method+" "+path+" HTTP/1.1"+CRLF+"Host: "+host+":"+port+CRLF+"Connection: close"+CRLF;
    if (headers) for (var k in headers) if (headers.hasOwnProperty(k)) req += k+": "+headers[k]+CRLF;
    if (bodyStr!=null){
      var b=toBytes(bodyStr);
      req += "Content-Length: "+b.length+CRLF+CRLF; s.write(req);
      var bin=""; for (var i=0;i<b.length;i++) bin+=String.fromCharCode(b[i]); s.write(bin);
    } else { req += CRLF; s.write(req); }
    var raw = readAll(s); s.close();
    var idx = raw.indexOf("\r\n\r\n"); var sepLen = 4;
    if (idx < 0) { idx = raw.indexOf("\n\n"); sepLen = 2; }
    if (idx < 0) die("Malformed HTTP response.");
    var head = raw.substring(0, idx), body = raw.substring(idx + sepLen);
    var first = head.split("\r\n")[0];
    var m = first.match(/^HTTP\/\d\.\d\s+(\d+)/);
    var status = m?parseInt(m[1],10):0;
    if (!allowErrors && (status<200 || status>=300)) die("HTTP "+status+" for "+path, body);
    return { status: status, body: wantBinary ? body : body.toString() };
  }

  function httpPostPrompt(promptObj, host, port){
    var payload = JSON.stringify({ prompt: promptObj });
    var r = httpRequest("POST", "/prompt", {"Content-Type":"application/json"}, payload, false, true, host, port);
    if (r.status < 200 || r.status >= 300) {
      die("ComfyUI rejected workflow (HTTP "+r.status+"). Check that Ideogram 4.0 nodes/models are installed and ComfyUI is up to date.\n\nResponse: " + (r.body || "").substring(0, 600), r.body);
    }
    try { return JSON.parse(r.body); } catch(e){ die("JSON parse error from POST /prompt", r.body); }
  }
  function httpHistoryMaybe(promptId, host, port){
    var r = httpRequest("GET", "/history/" + promptId, {"Accept":"application/json"}, null, false, true, host, port);
    if (r.status !== 200 || !r.body) return null;
    try { return JSON.parse(r.body); } catch(e){ return null; }
  }
  function httpGetQueue(host, port){
    var r = httpRequest("GET", "/queue", {"Accept":"application/json"}, null, false, true, host, port);
    if (r.status !== 200 || !r.body) return null;
    try { return JSON.parse(r.body); } catch(e){ return null; }
  }
  function httpDownloadToFile(viewPath, outFile, host, port){
    var r = httpRequest("GET", viewPath, null, null, true, false, host, port);
    outFile.encoding="BINARY";
    if(!outFile.open("w")) die("Cannot write file:\n"+outFile.fsName);
    outFile.write(r.body); outFile.close();
    if(!outFile.exists) die("Download failed:\n"+outFile.fsName);
  }

  // ============================================================
  // QUALITY PRESET TABLE (embedded; fed to JsonExtractString node)
  // ============================================================
  var PRESET_TABLE = {
    "Quality": { "num_steps": 48, "mu": 0.0,  "std": 1.5,  "preset_id": "V4_QUALITY_48" },
    "Default": { "num_steps": 20, "mu": 0.0,  "std": 1.75, "preset_id": "V4_DEFAULT_20" },
    "Turbo":   { "num_steps": 12, "mu": 0.5,  "std": 1.75, "preset_id": "V4_TURBO_12"   }
  };

  // ============================================================
  // EMBEDDED IDEOGRAM 4.0 T2I WORKFLOW (generation graph only;
  // the magic-prompt builder subgraph and PreviewAny nodes are omitted)
  // ============================================================
  function freshWorkflow(){
    var wf = {
      "37":  { "inputs": { "aspect_ratio": "1:1 (Square)", "megapixels": 1 }, "class_type": "ResolutionSelector", "_meta": { "title": "Resolution Selector" } },
      "158": { "inputs": { "filename_prefix": "Ideogram_AE", "images": ["98:13", 0] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } },

      "98:9":  { "inputs": { "vae_name": "flux2-vae.safetensors" }, "class_type": "VAELoader", "_meta": { "title": "Load VAE" } },
      "98:10": { "inputs": { "conditioning": ["98:24", 0] }, "class_type": "ConditioningZeroOut", "_meta": { "title": "ConditioningZeroOut" } },
      "98:11": { "inputs": { "width": ["98:31", 1], "height": ["98:32", 1], "batch_size": 1 }, "class_type": "EmptyFlux2LatentImage", "_meta": { "title": "Empty Flux 2 Latent" } },
      "98:12": { "inputs": { "noise": ["98:18", 0], "guider": ["98:155", 0], "sampler": ["98:16", 0], "sigmas": ["98:17", 0], "latent_image": ["98:11", 0] }, "class_type": "SamplerCustomAdvanced", "_meta": { "title": "SamplerCustomAdvanced" } },
      "98:13": { "inputs": { "samples": ["98:12", 0], "vae": ["98:9", 0] }, "class_type": "VAEDecode", "_meta": { "title": "VAE Decode" } },
      "98:14": { "inputs": { "clip_name": "qwen3vl_8b_fp8_scaled.safetensors", "type": "ideogram4", "device": "default" }, "class_type": "CLIPLoader", "_meta": { "title": "Load CLIP" } },
      "98:16": { "inputs": { "sampler_name": "euler" }, "class_type": "KSamplerSelect", "_meta": { "title": "KSamplerSelect" } },
      "98:17": { "inputs": { "steps": ["98:151", 1], "width": ["98:31", 1], "height": ["98:32", 1], "mu": ["98:144", 0], "std": ["98:146", 0] }, "class_type": "Ideogram4Scheduler", "_meta": { "title": "Ideogram 4 Scheduler" } },
      "98:18": { "inputs": { "noise_seed": 885894517601261 }, "class_type": "RandomNoise", "_meta": { "title": "RandomNoise" } },
      "98:23": { "inputs": { "unet_name": "ideogram4_fp8_scaled.safetensors", "weight_dtype": "default" }, "class_type": "UNETLoader", "_meta": { "title": "Load Diffusion Model" } },
      "98:24": { "inputs": { "text": "__PROMPT__", "clip": ["98:14", 0] }, "class_type": "CLIPTextEncode", "_meta": { "title": "CLIP Text Encode (Positive Prompt)" } },
      "98:27": { "inputs": { "value": ["37", 0] }, "class_type": "PrimitiveInt", "_meta": { "title": "Int (Width)" } },
      "98:28": { "inputs": { "value": ["37", 1] }, "class_type": "PrimitiveInt", "_meta": { "title": "Int (Height)" } },
      "98:31": { "inputs": { "expression": "max(((a + 15) // 16) * 16, 256)", "values.a": ["98:27", 0] }, "class_type": "ComfyMathExpression", "_meta": { "title": "Math Expression" } },
      "98:32": { "inputs": { "expression": "max(((a + 15) // 16) * 16, 256)", "values.a": ["98:28", 0] }, "class_type": "ComfyMathExpression", "_meta": { "title": "Math Expression" } },
      "98:144": { "inputs": { "value": ["98:145", 0] }, "class_type": "ComfyNumberConvert", "_meta": { "title": "Number Convert" } },
      "98:145": { "inputs": { "json_string": ["98:148", 0], "key": "mu" }, "class_type": "JsonExtractString", "_meta": { "title": "Extract Text from JSON" } },
      "98:146": { "inputs": { "value": ["98:150", 0] }, "class_type": "ComfyNumberConvert", "_meta": { "title": "Number Convert" } },
      "98:147": { "inputs": { "json_string": "__PRESET__", "key": ["98:156", 0] }, "class_type": "JsonExtractString", "_meta": { "title": "Extract Text from JSON" } },
      "98:148": { "inputs": { "string": ["98:147", 0], "find": "'", "replace": "\"" }, "class_type": "StringReplace", "_meta": { "title": "Replace Text" } },
      "98:149": { "inputs": { "json_string": ["98:148", 0], "key": "num_steps" }, "class_type": "JsonExtractString", "_meta": { "title": "Extract Text from JSON" } },
      "98:150": { "inputs": { "json_string": ["98:148", 0], "key": "std" }, "class_type": "JsonExtractString", "_meta": { "title": "Extract Text from JSON" } },
      "98:151": { "inputs": { "value": ["98:149", 0] }, "class_type": "ComfyNumberConvert", "_meta": { "title": "Number Convert" } },
      "98:154": { "inputs": { "unet_name": "ideogram4_unconditional_fp8_scaled.safetensors", "weight_dtype": "default" }, "class_type": "UNETLoader", "_meta": { "title": "Load Diffusion Model" } },
      "98:155": { "inputs": { "cfg": 7, "model": ["98:157", 0], "positive": ["98:24", 0], "model_negative": ["98:154", 0], "negative": ["98:10", 0] }, "class_type": "DualModelGuider", "_meta": { "title": "Dual Model CFG Guider" } },
      "98:156": { "inputs": { "choice": "Default", "index": 1, "option1": "Quality", "option2": "Default", "option3": "Turbo", "option4": "" }, "class_type": "CustomCombo", "_meta": { "title": "Custom Combo" } },
      "98:157": { "inputs": { "cfg": 3, "start_percent": 0.7, "end_percent": 1, "model": ["98:23", 0] }, "class_type": "CFGOverride", "_meta": { "title": "CFG Override" } }
    };
    // The preset table is itself a JSON string consumed by JsonExtractString.
    wf["98:147"].inputs.json_string = JSON.stringify(PRESET_TABLE);
    return wf;
  }

  // ============================================================
  // WORKFLOW BUILDER
  // ============================================================
  function buildWorkflow(params){
    // params = { promptJSON, seed, aspect, megapixels, qualityChoice, filenamePrefix }
    var wf = freshWorkflow();
    wf[PROMPT_NODE].inputs.text = params.promptJSON;
    wf[SEED_NODE].inputs.noise_seed = params.seed;
    wf[RESOLUTION_NODE].inputs.aspect_ratio = params.aspect;
    wf[RESOLUTION_NODE].inputs.megapixels = params.megapixels;
    wf[QUALITY_NODE].inputs.choice = params.qualityChoice;
    wf[SAVE_NODE].inputs.filename_prefix = params.filenamePrefix || "Ideogram_AE";
    return wf;
  }

  // ============================================================
  // AE HELPERS
  // ============================================================
  function activeComp(){ return (app.project && app.project.activeItem instanceof CompItem) ? app.project.activeItem : null; }

  // Returns the slash-separated path of a FolderItem relative to project root.
  function getAEFolderPath(folderItem){
    var parts = [];
    var f = folderItem;
    while (f && f !== app.project.rootFolder){
      parts.unshift(f.name);
      f = f.parentFolder;
    }
    return parts.join("/");
  }

  // Finds or creates a folder by slash-separated path. Returns null for root (empty path).
  function findOrCreateAEProjectFolder(pathStr){
    if (!pathStr || pathStr.replace(/\s/g, "") === "") return null;
    var parts = pathStr.split(/[\/\\]/);
    var current = app.project.rootFolder;
    for (var i = 0; i < parts.length; i++){
      var part = parts[i].replace(/^\s+|\s+$/g, "");
      if (!part) continue;
      var found = null;
      for (var j = 1; j <= current.numItems; j++){
        var item = current.item(j);
        if (item instanceof FolderItem && item.name === part){ found = item; break; }
      }
      if (!found){
        found = app.project.items.addFolder(part);
        found.parentFolder = current;
      }
      current = found;
    }
    return (current === app.project.rootFolder) ? null : current;
  }

  function fitLayerToComp(layer, comp){
    if (!layer || !comp || layer.width<=0 || layer.height<=0) return;
    var sx=(comp.width/layer.width)*100, sy=(comp.height/layer.height)*100, s=Math.max(sx,sy);
    var tr=layer.property("ADBE Transform Group");
    if(tr){
      var sc=tr.property("ADBE Scale"), ps=tr.property("ADBE Position");
      if(sc) sc.setValue([s,s,100]);
      if(ps) ps.setValue([comp.width/2, comp.height/2]);
    }
  }

  function getTextLayers(comp){
    var out = [];
    if (!comp) return out;
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      if (!(L instanceof TextLayer)) continue;
      out.push(L);
    }
    return out;
  }
  function getTextLayerSourceText(layer){
    try {
      var doc = layer.property("ADBE Text Properties").property("ADBE Text Document").value;
      return doc.text || "";
    } catch(e){ return ""; }
  }
  function findTextLayerByName(comp, name){
    if (!comp) return null;
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      if ((L instanceof TextLayer) && L.name === name) return L;
    }
    return null;
  }
  function findTextLayerById(comp, id){
    if (!comp || id === null || id === undefined) return null;
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      if ((L instanceof TextLayer) && L.id === id) return L;
    }
    return null;
  }
  // ============================================================
  // COLOR HELPERS
  // ============================================================
  function pad2(s){ return (s.length < 2) ? ("0" + s) : s; }
  function rgb01ToHex(c){
    var r = pad2(Math.round(clamp(c[0],0,1)*255).toString(16));
    var g = pad2(Math.round(clamp(c[1],0,1)*255).toString(16));
    var b = pad2(Math.round(clamp(c[2],0,1)*255).toString(16));
    return ("#" + r + g + b).toUpperCase();
  }
  function hexToRgb01(hex){
    var h = String(hex).replace("#","");
    if (h.length === 3) h = h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
    var r = parseInt(h.substring(0,2),16)/255;
    var g = parseInt(h.substring(2,4),16)/255;
    var b = parseInt(h.substring(4,6),16)/255;
    if (isNaN(r)||isNaN(g)||isNaN(b)) return [0.5,0.5,0.5];
    return [r,g,b];
  }
  function hexToDec(hex){
    var h = String(hex).replace("#",""); var v = parseInt(h,16);
    return isNaN(v) ? 0x808080 : v;
  }
  function decToHex(v){
    var r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    return ("#" + pad2(r.toString(16)) + pad2(g.toString(16)) + pad2(b.toString(16))).toUpperCase();
  }
  // Opens AE's native color picker; returns a hex string or null if cancelled.
  function pickColor(currentHex){
    var start = hexToDec(currentHex || "#808080");
    var picked = $.colorPicker(start);   // returns 0xRRGGBB, or -1 on cancel
    if (picked == null || picked < 0) return null;
    return decToHex(picked);
  }

  // ============================================================
  // SHAPE LAYER RECT SCANNING
  // ============================================================

  // Walk a shape layer's Contents and return one entry per vector group that
  // contains a Rectangle Path.  Each entry: { name, rectSize, rectPos, grpPos, fillHex }
  function findRectGroups(layer, comp){
    var t = (comp) ? comp.time : 0;
    var results = [];
    try {
      var contents = layer.property("ADBE Root Vectors Group");
      if (!contents) return results;
      for (var i = 1; i <= contents.numProperties; i++){
        var grp = contents.property(i);
        if (!grp || grp.matchName !== "ADBE Vector Group") continue;
        var sub = grp.property("ADBE Vectors Group");
        if (!sub) continue;
        var rectProp = null, fillHex = null;
        for (var j = 1; j <= sub.numProperties; j++){
          var p = sub.property(j);
          if (!p) continue;
          if (p.matchName === "ADBE Vector Shape - Rect" && !rectProp) rectProp = p;
          if (p.matchName === "ADBE Vector Graphic - Fill" && !fillHex){
            try { fillHex = rgb01ToHex(p.property("ADBE Vector Fill Color").valueAtTime(t, false)); } catch(_){}
          }
        }
        if (!rectProp) continue;
        var rectSize = [0,0], rectPos = [0,0];
        try { rectSize = rectProp.property("ADBE Vector Rect Size").valueAtTime(t, false); } catch(_){}
        try { rectPos  = rectProp.property("ADBE Vector Rect Position").valueAtTime(t, false); } catch(_){}
        var grpPos = [0,0];
        try {
          var grpTr = grp.property("ADBE Vector Transform Group");
          if (grpTr) grpPos = grpTr.property("ADBE Vector Position").valueAtTime(t, false);
        } catch(_){}
        results.push({ name: grp.name, rectSize: rectSize, rectPos: rectPos, grpPos: grpPos, fillHex: fillHex });
      }
    } catch(e){ log("findRectGroups error: " + e); }
    return results;
  }

  // Like findRectGroups, but not restricted to rectangle shapes: returns every
  // vector group with a solid Fill. Used for the style palette's shape-layer color picker.
  function findFillGroups(layer, comp){
    var t = (comp) ? comp.time : 0;
    var results = [];
    try {
      var contents = layer.property("ADBE Root Vectors Group");
      if (!contents) return results;
      for (var i = 1; i <= contents.numProperties; i++){
        var grp = contents.property(i);
        if (!grp || grp.matchName !== "ADBE Vector Group") continue;
        var sub = grp.property("ADBE Vectors Group");
        if (!sub) continue;
        var fillHex = null;
        for (var j = 1; j <= sub.numProperties; j++){
          var p = sub.property(j);
          if (!p) continue;
          if (p.matchName === "ADBE Vector Graphic - Fill" && !fillHex){
            try { fillHex = rgb01ToHex(p.property("ADBE Vector Fill Color").valueAtTime(t, false)); } catch(_){}
          }
        }
        if (!fillHex) continue;
        results.push({ name: grp.name, fillHex: fillHex });
      }
    } catch(e){ log("findFillGroups error: " + e); }
    return results;
  }

  // ============================================================
  // BOUNDING-BOX TRANSLATION  (comp px -> Ideogram 0..1000, [y1,x1,y2,x2])
  // ============================================================

  // Compute bbox for a rect group inside a shape layer.
  // rectData = one entry from findRectGroups().
  function rectGroupBBox(rectData, layer, comp){
    try {
      var cx = rectData.grpPos[0] + rectData.rectPos[0];
      var cy = rectData.grpPos[1] + rectData.rectPos[1];
      var hw = rectData.rectSize[0] / 2, hh = rectData.rectSize[1] / 2;
      var corners = [
        [cx - hw, cy - hh], [cx + hw, cy - hh],
        [cx + hw, cy + hh], [cx - hw, cy + hh]
      ];
      var t = comp.time;
      var tr = layer.property("ADBE Transform Group");
      var anchor = tr.property("ADBE Anchor Point").valueAtTime(t, false);
      var pos    = tr.property("ADBE Position").valueAtTime(t, false);
      var scl    = tr.property("ADBE Scale").valueAtTime(t, false);
      var rot    = 0;
      try { rot = tr.property("ADBE Rotate Z").valueAtTime(t, false); } catch(_){}
      var sx = scl[0]/100, sy = scl[1]/100;
      var rad = rot * Math.PI / 180, cosr = Math.cos(rad), sinr = Math.sin(rad);
      var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
      for (var i = 0; i < corners.length; i++){
        var dx = (corners[i][0] - anchor[0]) * sx;
        var dy = (corners[i][1] - anchor[1]) * sy;
        var rx = dx*cosr - dy*sinr;
        var ry = dx*sinr + dy*cosr;
        var ex = pos[0] + rx, ey = pos[1] + ry;
        if (ex < minX) minX = ex; if (ex > maxX) maxX = ex;
        if (ey < minY) minY = ey; if (ey > maxY) maxY = ey;
      }
      var x1 = clamp(Math.round(minX / comp.width  * 1000), 0, 1000);
      var y1 = clamp(Math.round(minY / comp.height * 1000), 0, 1000);
      var x2 = clamp(Math.round(maxX / comp.width  * 1000), 0, 1000);
      var y2 = clamp(Math.round(maxY / comp.height * 1000), 0, 1000);
      return [y1, x1, y2, x2];
    } catch(e){ log("rectGroupBBox error: " + e); return null; }
  }

  // ============================================================
  // CAPTION ASSEMBLY
  // ============================================================

  // Resolves one stylePalette entry to a live hex. "layer" entries are re-sampled
  // from the comp every call -- never trust the entry's cached .hex for generation.
  function resolveLayerFillHex(entry, comp){
    if (!comp) return null;
    var layer = null;
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      if ((L instanceof ShapeLayer) && L.name === entry.shapeLayerName){ layer = L; break; }
    }
    if (!layer) return null;
    var groups = findFillGroups(layer, comp);
    for (var j = 0; j < groups.length; j++){
      if (groups[j].name === entry.groupName) return groups[j].fillHex;
    }
    return null;
  }
  function resolveStylePalette(comp){
    var out = [];
    for (var i = 0; i < stylePalette.length; i++){
      var entry = stylePalette[i];
      if (entry.kind === "layer"){
        var hex = resolveLayerFillHex(entry, comp);
        if (hex) out.push(hex);
        else log("Style palette: layer entry '" + entry.shapeLayerName + " / " + entry.groupName + "' not found -- omitting");
      } else {
        out.push(entry.hex);
      }
    }
    return out;
  }

  function buildElementsArray(comp){
    var out = [];
    for (var i = 0; i < elementRows.length; i++){
      var row = elementRows[i];
      if (!row.rectData || !row.layer) continue;
      var bbox = rectGroupBBox(row.rectData, row.layer, comp);
      var el = { type: (row.typeDrop.selection ? row.typeDrop.selection.text : "obj") };
      if (bbox) el.bbox = bbox;
      else log("Element '" + row.rectData.name + "' produced no bbox — omitting bbox key");

      // desc: "Group name" uses the rect group name; "Text box" uses the typed field
      var descMode = row.descDrop.selection ? row.descDrop.selection.text : "Group name";
      el.desc = (descMode === "Group name") ? row.rectData.name : (trim(row.descField.text) || row.rectData.name);

      // palette: "Auto fill" uses the detected rect fill; "Swatches" uses custom picks
      var palMode = row.palDrop.selection ? row.palDrop.selection.text : "Auto fill";
      var pal;
      if (palMode === "Auto fill"){
        pal = (row.autoFillSwatch && row.autoFillSwatch.hexVal) ? [row.autoFillSwatch.hexVal]
            : (row.rectData.fillHex ? [row.rectData.fillHex] : []);
      } else {
        pal = row.swatches.slice(0);
      }
      if (pal.length) el.color_palette = pal;

      out.push(el);
    }
    return out;
  }

  function assembleCaption(comp){
    var cap = {};

    var hld = partValue(P.hld);
    if (trim(hld)) cap.high_level_description = hld;

    if (styleInclude.value){
      var style = {};
      var a = partValue(P.aes); if (trim(a)) style.aesthetics = a;
      var l = partValue(P.lig); if (trim(l)) style.lighting   = l;
      var ph= partValue(P.pho); if (trim(ph)) style.photo      = ph;
      var md= partValue(P.med); if (trim(md)) style.medium     = md;
      var pal = resolveStylePalette(comp);
      if (pal.length) style.color_palette = pal;
      if (!isEmptyObj(style)) cap.style_description = style;
    }

    var cd = {};
    var bg = partValue(P.bg);
    if (trim(bg)) cd.background = bg;
    var els = buildElementsArray(comp);
    if (els.length) cd.elements = els;
    if (!isEmptyObj(cd)) cap.compositional_deconstruction = cd;

    return cap;
  }

  function buildElementsArrayFresh(comp){
    if (!currentShapeLyr) return buildElementsArray(comp);
    var freshRects = findRectGroups(currentShapeLyr, comp);
    var out = [];
    for (var i = 0; i < elementRows.length && i < freshRects.length; i++){
      var row = elementRows[i];
      var rd  = freshRects[i];
      var bbox = rectGroupBBox(rd, currentShapeLyr, comp);
      var el = { type: (row.typeDrop.selection ? row.typeDrop.selection.text : "obj") };
      if (bbox) el.bbox = bbox;
      var descMode = row.descDrop.selection ? row.descDrop.selection.text : "Group name";
      el.desc = (descMode === "Group name") ? rd.name : (trim(row.descField.text) || rd.name);
      var palMode = row.palDrop.selection ? row.palDrop.selection.text : "Auto fill";
      var pal;
      if (palMode === "Auto fill"){
        pal = rd.fillHex ? [rd.fillHex] : [];
      } else {
        pal = row.swatches.slice(0);
      }
      if (pal.length) el.color_palette = pal;
      out.push(el);
    }
    return out;
  }

  function assembleCaptionFresh(comp){
    var cap = {};
    var hld = partValue(P.hld);
    if (trim(hld)) cap.high_level_description = hld;
    if (styleInclude.value){
      var style = {};
      var a  = partValue(P.aes); if (trim(a))  style.aesthetics = a;
      var l  = partValue(P.lig); if (trim(l))  style.lighting   = l;
      var ph = partValue(P.pho); if (trim(ph)) style.photo      = ph;
      var md = partValue(P.med); if (trim(md)) style.medium     = md;
      var pal = resolveStylePalette(comp);
      if (pal.length) style.color_palette = pal;
      if (!isEmptyObj(style)) cap.style_description = style;
    }
    var cd = {};
    var bg = partValue(P.bg);
    if (trim(bg)) cd.background = bg;
    var els = buildElementsArrayFresh(comp);
    if (els.length) cd.elements = els;
    if (!isEmptyObj(cd)) cap.compositional_deconstruction = cd;
    return cap;
  }

  // Resolve a part block's value: a chosen text layer's source text, else the typed box.
  function partValue(block){
    var sel = block.layerDrop.selection ? block.layerDrop.selection.text : LAYER_NONE;
    if (sel && sel !== LAYER_NONE){
      var L = findTextLayerByName(activeComp(), sel);
      if (L) return getTextLayerSourceText(L);
    }
    return block.field.text;
  }

  // ============================================================
  // GLOBAL UI STATE
  // ============================================================
  var settings = loadSettings();
  var stopRequested = false;
  var generating = false;
  var lastCompId = null, lastCompName = null;
  var lastLayerFingerprint = null;  // shape + text layer names/types (for rect rebuild)
  var lastLayerCountFP     = null;  // shape + text layer COUNTS only (for dropdown rebuild)
  var lastShapeLayerFP     = null;  // rect group names + fill hexes in selected shape layer
  var lastTextContentFP    = null;  // text content of all text layers
  var stylePalette = [];             // top-level color_palette hexes
  var elementRows = [];              // element editor rows (one per rect group)
  var currentShapeLyr = null;        // shape layer currently driving the elements
  var _panelSessionId = new Date().getTime();
  $._comfyIdeogramPanel._sessionId = _panelSessionId;
  var _suppressShapeDropOnChange = false;
  var _pendingRectRebuild  = false;
  var _pendingLayerRefresh = false;
  var _pendingTextRefresh  = false;
  var _pendingBBoxRefresh  = false;
  var lastBBoxFP = null;
  var _pendingPaletteRefresh = false;
  var lastStylePaletteFP = null;
  var P = {};                        // part blocks: hld, aes, lig, pho, med, bg
  var styleInclude;                  // "Include style_description" checkbox
  var compStateCache = {};           // per-comp memory, keyed by comp.id -- runtime only, never saved to disk
  var _applyingState = false;        // guards save-during-restore feedback loops
  var _pendingShapeLayerName = null; // resolved by populateShapeLayerDrop() once the new comp's layers are listed

  // ============================================================
  // UI BUILD
  // ============================================================
  var win = (thisObj instanceof Panel) ? thisObj : new Window("palette", "Comfy IdeogramGen", undefined, {resizeable:true});
  win.orientation = "column"; win.alignChildren = ["fill","top"]; win.spacing = 6; win.margins = 8;

  var _lastTextRefreshTime = 0;
  win.addEventListener("mouseover", function(){
    if (generating) return;
    if (_pendingLayerRefresh && activeComp()){
      _pendingLayerRefresh = false;
      try { populateShapeLayerDrop(); } catch(_){}
      try { populateAllPartDropdowns(); } catch(_){}
    }
    if (_pendingRectRebuild){
      _pendingRectRebuild = false;
      _pendingBBoxRefresh = false;
      lastBBoxFP = null;
      try { scanAndBuildRectRows(); } catch(_){}
    }
    if (_pendingBBoxRefresh){
      _pendingBBoxRefresh = false;
      try { refreshBBoxTexts(); } catch(_){}
    }
    if (_pendingPaletteRefresh){
      _pendingPaletteRefresh = false;
      try { refreshStylePaletteSwatches(); } catch(_){}
    }
    var now = new Date().getTime();
    if (_pendingTextRefresh || now - _lastTextRefreshTime >= 2000){
      _pendingTextRefresh = false;
      _lastTextRefreshTime = now;
      try { refreshPartFieldTexts(); } catch(_){}
    }
  });

  // ---------- Connection ----------
  var connPanel = win.add("panel", undefined, "ComfyUI Connection");
  connPanel.orientation = "column"; connPanel.alignChildren = ["fill","top"];
  var connRow = connPanel.add("group"); connRow.orientation = "row";
  connRow.add("statictext", undefined, "Host:");
  var hostEdit = connRow.add("edittext", undefined, settings.host); hostEdit.characters = 12;
  connRow.add("statictext", undefined, "Port:");
  var portEdit = connRow.add("edittext", undefined, settings.port); portEdit.characters = 5;
  var pingBtn = connRow.add("button", undefined, "Ping");
  var connStatus = connPanel.add("statictext", undefined, "Status: unknown"); connStatus.alignment = ["fill","top"];

  // ---------- Model / settings ----------
  var setPanel = win.add("panel", undefined, "Ideogram 4.0 (Text \u2192 Image)");
  setPanel.orientation = "column"; setPanel.alignChildren = ["fill","top"];
  var qRow = setPanel.add("group"); qRow.orientation = "row";
  qRow.add("statictext", undefined, "Quality:");
  var qualityDrop = qRow.add("dropdownlist", undefined, []);
  for (var qi = 0; qi < QUALITY_OPTIONS.length; qi++) qualityDrop.add("item", QUALITY_OPTIONS[qi].label);
  qRow.add("statictext", undefined, "  MP:");
  var mpDrop = qRow.add("dropdownlist", undefined, MEGAPIXEL_OPTIONS);

  var aRow = setPanel.add("group"); aRow.orientation = "row";
  aRow.add("statictext", undefined, "Aspect:");
  var aspectDrop = aRow.add("dropdownlist", undefined, []);
  aspectDrop.preferredSize.width = 220;
  var matchCompChk = aRow.add("checkbox", undefined, "Match comp");

  // ---------- Prompt parts ----------
  var partsPanel = win.add("panel", undefined, "Prompt parts");
  partsPanel.orientation = "column"; partsPanel.alignChildren = ["fill","top"]; partsPanel.spacing = 4;

  P.hld = makePartBlock(partsPanel, "high_level_description", 56);

  // style_description group (gated by checkbox)
  styleInclude = partsPanel.add("checkbox", undefined, "Include style_description");
  var styleGroup = partsPanel.add("group"); styleGroup.orientation = "column"; styleGroup.alignChildren = ["fill","top"]; styleGroup.margins = [10,2,0,2];
  // top-level palette (shared across aesthetics/lighting/photo/medium -- Ideogram has one array here)
  var palRow = styleGroup.add("group"); palRow.orientation = "row"; palRow.alignChildren = ["left","center"];
  palRow.add("statictext", undefined, "color_palette:");
  var paletteContainer = palRow.add("group"); paletteContainer.orientation = "row"; paletteContainer.spacing = 3;
  var addSwatchBtn = palRow.add("button", undefined, "+"); addSwatchBtn.preferredSize = [24,22];
  var addLayerFillBtn = palRow.add("button", undefined, "+ fill"); addLayerFillBtn.preferredSize = [44,22];

  P.aes = makePartBlock(styleGroup, "aesthetics", 36);
  P.lig = makePartBlock(styleGroup, "lighting",   36);
  P.pho = makePartBlock(styleGroup, "photo",      36);
  P.med = makePartBlock(styleGroup, "medium",     36);

  P.bg = makePartBlock(partsPanel, "background", 56);

  // ---------- Elements ----------
  var elPanel = win.add("panel", undefined, "elements  (bbox from rectangle groups in shape layer)");
  elPanel.orientation = "column"; elPanel.alignChildren = ["fill","top"];
  var elTopRow = elPanel.add("group"); elTopRow.orientation = "row"; elTopRow.alignChildren = ["left","center"];
  elTopRow.add("statictext", undefined, "Shape layer:");
  var shapeLayerDrop = elTopRow.add("dropdownlist", undefined, []); shapeLayerDrop.preferredSize.width = 190;
  var elCount = elTopRow.add("statictext", undefined, "0 elements"); elCount.alignment = ["fill","center"];
  var elContainer = elPanel.add("group"); elContainer.orientation = "column"; elContainer.alignChildren = ["fill","top"]; elContainer.spacing = 4;

  // ---------- Generation ----------
  var genPanel = win.add("panel", undefined, "Generation");
  genPanel.orientation = "column"; genPanel.alignChildren = ["fill","top"];
  var modeRow = genPanel.add("group"); modeRow.orientation = "row";
  modeRow.add("statictext", undefined, "Mode:");
  var modeDrop = modeRow.add("dropdownlist", undefined, ["Single frame", "Every frame"]);
  modeDrop.selection = (settings.genMode === "everyframe") ? 1 : 0;
  var workAreaChk = modeRow.add("checkbox", undefined, "Work area only");
  workAreaChk.value = (settings.workAreaOnly !== false);
  workAreaChk.visible = (modeDrop.selection.index === 1);
  modeDrop.onChange = function(){
    var ef = (modeDrop.selection.index === 1);
    workAreaChk.visible = ef;
    updateSeedVarEnabled();
    saveCurrentCompState();
  };
  var seedRow = genPanel.add("group"); seedRow.orientation = "row";
  seedRow.add("statictext", undefined, "Seed:");
  var seedModeDrop = seedRow.add("dropdownlist", undefined, ["Random","Fixed","Increment"]);
  seedModeDrop.selection = (settings.seedMode === "fixed") ? 1 : (settings.seedMode === "increment") ? 2 : 0;
  var seedEdit = seedRow.add("edittext", undefined, String(settings.lastSeed || 0)); seedEdit.characters = 14;
  seedRow.add("statictext", undefined, "Step:");
  var stepEdit = seedRow.add("edittext", undefined, String(settings.lastSeedStep || 1)); stepEdit.characters = 4;
  seedRow.add("statictext", undefined, "Variations:");
  var varEdit = seedRow.add("edittext", undefined, String(settings.lastVariations || 1)); varEdit.characters = 3;

  var folderRow = genPanel.add("group"); folderRow.orientation = "row";
  folderRow.add("statictext", undefined, "Output:");
  var outputFolderEdit = folderRow.add("edittext", undefined, settings.outputFolder || ""); outputFolderEdit.preferredSize.width = 200;
  var chooseFolderBtn = folderRow.add("button", undefined, "Browse"); chooseFolderBtn.preferredSize.width = 64;

  var prefixRow = genPanel.add("group"); prefixRow.orientation = "row";
  prefixRow.add("statictext", undefined, "File prefix:");
  var filePrefixEdit = prefixRow.add("edittext", undefined, settings.filenamePrefix || "Ideogram_AE");
  filePrefixEdit.preferredSize.width = 140;

  var aeFolderRow = genPanel.add("group"); aeFolderRow.orientation = "row";
  aeFolderRow.add("statictext", undefined, "AE folder:");
  var aeFolderEdit = aeFolderRow.add("edittext", undefined, settings.aeProjectFolder || "");
  aeFolderEdit.preferredSize.width = 140;
  aeFolderEdit.helpTip = "Project panel folder for imported footage. Leave blank for root. Use / for subfolders, e.g. Ideogram/Renders";
  var pickAEFolderBtn = aeFolderRow.add("button", undefined, "Pick");
  pickAEFolderBtn.preferredSize.width = 50;
  pickAEFolderBtn.helpTip = "Use the folder currently selected in the Project panel";

  var genRow = genPanel.add("group"); genRow.orientation = "row"; genRow.alignment = ["fill","top"];
  var genBtn = genRow.add("button", undefined, "Generate"); genBtn.preferredSize.height = 30; genBtn.alignment = ["fill","top"];
  var stopBtn = genRow.add("button", undefined, "Stop"); stopBtn.enabled = false;
  var viewLogBtn = genRow.add("button", undefined, "View Log");
  var resetBtn = genRow.add("button", undefined, "Reset");
  resetBtn.helpTip = "Clear all prompt text, layer bindings, style palette and elements for this composition";

  var statusTxt = win.add("statictext", undefined, "Status: idle"); statusTxt.alignment = ["fill","top"];

  // ============================================================
  // PART BLOCK BUILDER
  // ============================================================
  function makePartBlock(parent, labelText, boxHeight){
    var grp = parent.add("group"); grp.orientation = "column"; grp.alignChildren = ["fill","top"]; grp.spacing = 2;
    var head = grp.add("group"); head.orientation = "row"; head.alignChildren = ["left","center"];
    var lbl = head.add("statictext", undefined, labelText); lbl.alignment = ["fill","center"];
    head.add("statictext", undefined, "Layer:");
    var ld = head.add("dropdownlist", undefined, []); ld.preferredSize.width = 150;
    var field = grp.add("edittext", undefined, "", {multiline:true, wantReturn:true});
    field.preferredSize.height = boxHeight;

    var block = { group: grp, label: lbl, layerDrop: ld, field: field, linkedLayerId: null, _pendingLayerName: null };
    ld.onChange = function(){
      var sel = ld.selection ? ld.selection.text : LAYER_NONE;
      if (sel && sel !== LAYER_NONE){
        var L = findTextLayerByName(activeComp(), sel);
        block.linkedLayerId = L ? L.id : null;
      } else {
        block.linkedLayerId = null;
      }
      updatePartFieldState(block);
      saveCurrentCompState();
    };
    field.onChange = function(){ saveCurrentCompState(); };
    return block;
  }
  function updatePartFieldState(block){
    var sel = block.layerDrop.selection ? block.layerDrop.selection.text : LAYER_NONE;
    if (sel && sel !== LAYER_NONE){
      block.field.enabled = false;
      var L = (block.linkedLayerId !== null && block.linkedLayerId !== undefined)
        ? findTextLayerById(activeComp(), block.linkedLayerId)
        : findTextLayerByName(activeComp(), sel);
      block.field.text = L ? getTextLayerSourceText(L) : "";
    } else {
      block.field.enabled = true;
      if (block.field.text.indexOf("(from layer") === 0) block.field.text = "";
    }
  }
  function populatePartLayerDropdown(block, comp){
    var c = comp || activeComp();
    if (!c) return;
    var prev = block.layerDrop.selection ? block.layerDrop.selection.text : LAYER_NONE;
    var target = (block._pendingLayerName !== null && block._pendingLayerName !== undefined) ? block._pendingLayerName : prev;
    block.layerDrop.removeAll();
    block.layerDrop.add("item", LAYER_NONE);
    var tls = getTextLayers(c);
    for (var i = 0; i < tls.length; i++) block.layerDrop.add("item", tls[i].name);
    var idx = 0;
    for (var j = 0; j < block.layerDrop.items.length; j++){ if (block.layerDrop.items[j].text === target){ idx = j; break; } }
    block.layerDrop.selection = idx;
    block._pendingLayerName = null;
    var selText = block.layerDrop.selection ? block.layerDrop.selection.text : LAYER_NONE;
    if (selText && selText !== LAYER_NONE){
      var LL = findTextLayerByName(c, selText);
      block.linkedLayerId = LL ? LL.id : null;
    } else {
      block.linkedLayerId = null;
    }
    updatePartFieldState(block);
  }
  function populateAllPartDropdowns(comp){
    populatePartLayerDropdown(P.hld, comp);
    populatePartLayerDropdown(P.aes, comp);
    populatePartLayerDropdown(P.lig, comp);
    populatePartLayerDropdown(P.pho, comp);
    populatePartLayerDropdown(P.med, comp);
    populatePartLayerDropdown(P.bg, comp);
  }

  // ============================================================
  // SWATCH WIDGET
  // ============================================================
  function makeSwatch(parent, hex, onChange, onRemove, onEditLayer){
    var sw = parent.add("iconbutton", undefined, undefined, {style:"button"});
    sw.preferredSize = [22,22];
    sw.hexVal = hex;
    sw.onDraw = function(){
      var g = this.graphics;
      var c = hexToRgb01(this.hexVal);
      try {
        var b = g.newBrush(g.BrushType.SOLID_COLOR, [c[0], c[1], c[2], 1]);
        g.newPath(); g.rectPath(0, 0, this.size[0], this.size[1]); g.fillPath(b);
        var pen = g.newPen(g.PenType.SOLID_COLOR, [0,0,0,1], 1);
        g.newPath(); g.rectPath(0, 0, this.size[0]-1, this.size[1]-1); g.strokePath(pen);
      } catch(e){}
    };
    sw.onClick = function(){
      // left-click edits, but ScriptUI has no native right-click here:
      // hold Alt to remove a swatch.
      if (ScriptUI.environment.keyboardState.altKey && onRemove){ onRemove(sw); return; }
      if (onEditLayer){ onEditLayer(); return; }
      var picked = pickColor(sw.hexVal);
      if (picked){ sw.hexVal = picked; sw.notify("onDraw"); if (onChange) onChange(); }
    };
    return sw;
  }

  // Modal picker: choose a shape layer in the active comp, then a fill group inside
  // it. Returns { kind:"layer", shapeLayerName, groupName, hex } or null if cancelled.
  function pickLayerFillEntry(){
    var comp = activeComp();
    if (!comp) { alert("No active composition."); return null; }

    var shapeLayers = [];
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      if (L instanceof ShapeLayer) shapeLayers.push(L);
    }
    if (!shapeLayers.length) { alert("No shape layers in the active comp."); return null; }

    var dlg = new Window("dialog", "Add Fill From Shape Layer");
    dlg.orientation = "column"; dlg.alignChildren = ["fill","top"]; dlg.margins = 12; dlg.spacing = 8;

    var r1 = dlg.add("group"); r1.orientation = "row"; r1.alignChildren = ["left","center"];
    r1.add("statictext", undefined, "Shape layer:");
    var layerDrop = r1.add("dropdownlist", undefined, []); layerDrop.preferredSize.width = 200;
    for (var s = 0; s < shapeLayers.length; s++) layerDrop.add("item", shapeLayers[s].name);

    var r2 = dlg.add("group"); r2.orientation = "row"; r2.alignChildren = ["left","center"];
    r2.add("statictext", undefined, "Fill group:");
    var groupDrop = r2.add("dropdownlist", undefined, []); groupDrop.preferredSize.width = 200;

    var r3 = dlg.add("group"); r3.orientation = "row"; r3.alignChildren = ["left","center"];
    r3.add("statictext", undefined, "Preview:");
    var previewSwatch = makeSwatch(r3, "#808080", null, null);
    previewSwatch.enabled = false;

    var btnRow = dlg.add("group"); btnRow.orientation = "row"; btnRow.alignment = ["right","bottom"];
    var cancelBtn = btnRow.add("button", undefined, "Cancel", {name:"cancel"});
    var addBtn    = btnRow.add("button", undefined, "Add",    {name:"ok"});

    function refreshGroups(){
      groupDrop.removeAll();
      var sel = layerDrop.selection;
      var groups = sel ? findFillGroups(shapeLayers[sel.index], comp) : [];
      for (var g = 0; g < groups.length; g++) groupDrop.add("item", groups[g].name);
      if (groups.length){
        groupDrop.selection = 0;
        previewSwatch.hexVal = groups[0].fillHex;
      } else {
        previewSwatch.hexVal = "#808080";
      }
      previewSwatch.notify("onDraw");
      addBtn.enabled = (groups.length > 0);
    }
    groupDrop.onChange = function(){
      var sel = layerDrop.selection, gsel = groupDrop.selection;
      if (!sel || !gsel) return;
      var groups = findFillGroups(shapeLayers[sel.index], comp);
      if (groups[gsel.index]){ previewSwatch.hexVal = groups[gsel.index].fillHex; previewSwatch.notify("onDraw"); }
    };
    layerDrop.onChange = refreshGroups;
    layerDrop.selection = 0;
    refreshGroups();

    var resultEntry = null;
    addBtn.onClick = function(){
      var sel = layerDrop.selection, gsel = groupDrop.selection;
      if (!sel || !gsel) { dlg.close(); return; }
      var groups = findFillGroups(shapeLayers[sel.index], comp);
      var g = groups[gsel.index];
      resultEntry = { kind: "layer", shapeLayerName: shapeLayers[sel.index].name, groupName: g.name, hex: g.fillHex };
      dlg.close();
    };
    cancelBtn.onClick = function(){ dlg.close(); };

    dlg.show();
    return resultEntry;
  }

  function rebuildStylePalette(){
    // clear container
    while (paletteContainer.children.length > 0){ try { paletteContainer.remove(paletteContainer.children[0]); } catch(_){ break; } }
    for (var i = 0; i < stylePalette.length; i++){
      (function(idx){
        var entry = stylePalette[idx];
        if (entry.kind === "layer"){
          makeSwatch(paletteContainer, entry.hex,
            null,
            function(){ stylePalette.splice(idx,1); rebuildStylePalette(); win.layout.layout(true); saveCurrentCompState(); },
            function(){
              var updated = pickLayerFillEntry();
              if (updated){ stylePalette[idx] = updated; rebuildStylePalette(); win.layout.layout(true); saveCurrentCompState(); }
            }
          );
        } else {
          makeSwatch(paletteContainer, entry.hex,
            function(){ stylePalette[idx].hex = paletteContainer.children[idx].hexVal; saveCurrentCompState(); },
            function(){ stylePalette.splice(idx,1); rebuildStylePalette(); win.layout.layout(true); saveCurrentCompState(); }
          );
        }
      })(i);
    }
    addSwatchBtn.enabled = (stylePalette.length < MAX_PALETTE_IMAGE);
    addLayerFillBtn.enabled = (stylePalette.length < MAX_PALETTE_IMAGE);
  }

  addSwatchBtn.onClick = function(){
    if (stylePalette.length >= MAX_PALETTE_IMAGE) return;
    var picked = pickColor("#808080");
    if (picked){ stylePalette.push({ kind: "swatch", hex: picked }); rebuildStylePalette(); win.layout.layout(true); saveCurrentCompState(); }
  };
  addLayerFillBtn.onClick = function(){
    if (stylePalette.length >= MAX_PALETTE_IMAGE) return;
    var entry = pickLayerFillEntry();
    if (entry){ stylePalette.push(entry); rebuildStylePalette(); win.layout.layout(true); saveCurrentCompState(); }
  };

  // ============================================================
  // ELEMENT ROW BUILDER  (one row per rectangle group in the shape layer)
  // ============================================================
  function buildRectRow(rectData, layer){
    var comp = activeComp();
    var bbox = comp ? rectGroupBBox(rectData, layer, comp) : null;

    var row = elContainer.add("panel"); row.orientation = "column"; row.alignChildren = ["fill","top"];
    row.margins = 6; row.spacing = 3;

    var head = row.add("group"); head.orientation = "row"; head.alignChildren = ["left","center"];
    var nameTxt = head.add("statictext", undefined, rectData.name); nameTxt.preferredSize.width = 130;
    var bboxTxt = head.add("statictext", undefined, bbox ? ("[" + bbox.join(",") + "]") : "[bbox n/a]");
    bboxTxt.alignment = ["fill","center"];

    var r1 = row.add("group"); r1.orientation = "row"; r1.alignChildren = ["left","center"];
    r1.add("statictext", undefined, "type");
    var typeDrop = r1.add("dropdownlist", undefined, ["obj","text"]);
    typeDrop.selection = 0;
    r1.add("statictext", undefined, "  desc");
    var descDrop = r1.add("dropdownlist", undefined, ["Group name","Text box"]);
    descDrop.selection = 0;

    var descField = row.add("edittext", undefined, rectData.name, {multiline:true, wantReturn:true});
    descField.preferredSize.height = 34; descField.enabled = false;

    var r2 = row.add("group"); r2.orientation = "row"; r2.alignChildren = ["left","center"];
    r2.add("statictext", undefined, "palette");
    var palDrop = r2.add("dropdownlist", undefined, ["Auto fill","Swatches"]);
    palDrop.selection = 0;
    var palBox = r2.add("group"); palBox.orientation = "row"; palBox.spacing = 3;
    var palAddBtn = r2.add("button", undefined, "+"); palAddBtn.preferredSize = [24,22]; palAddBtn.visible = false;

    var rowObj = {
      rectData: rectData, layer: layer, panel: row,
      bboxTxt: bboxTxt,
      typeDrop: typeDrop, descDrop: descDrop, descField: descField,
      palDrop: palDrop, palBox: palBox, palAddBtn: palAddBtn,
      swatches: [], autoFillSwatch: null
    };

    descDrop.onChange = function(){
      var isTextBox = descDrop.selection && descDrop.selection.text === "Text box";
      if (isTextBox){
        if (descField.text === rectData.name) descField.text = "";
        descField.enabled = true;
      } else {
        descField.text = rectData.name;
        descField.enabled = false;
      }
    };

    function renderRowPalette(){
      while (palBox.children.length > 0){ try { palBox.remove(palBox.children[0]); } catch(_){ break; } }
      rowObj.autoFillSwatch = null;
      if (palDrop.selection && palDrop.selection.text === "Auto fill"){
        palAddBtn.visible = false;
        if (rectData.fillHex){
          // Show detected fill as a clickable swatch so the user can override it
          rowObj.autoFillSwatch = makeSwatch(palBox, rectData.fillHex, null, null);
        } else {
          palBox.add("statictext", undefined, "(no fill)");
        }
      } else {
        palAddBtn.visible = true;
        for (var i = 0; i < rowObj.swatches.length; i++){
          (function(idx){
            makeSwatch(palBox, rowObj.swatches[idx],
              function(){ rowObj.swatches[idx] = palBox.children[idx].hexVal; },
              function(){ rowObj.swatches.splice(idx,1); renderRowPalette(); win.layout.layout(true); });
          })(i);
        }
      }
      palAddBtn.enabled = (rowObj.swatches.length < MAX_PALETTE_ELEMENT);
      try { win.layout.layout(true); } catch(_){}
    }
    palDrop.onChange = renderRowPalette;
    palAddBtn.onClick = function(){
      if (rowObj.swatches.length >= MAX_PALETTE_ELEMENT) return;
      var picked = pickColor("#808080");
      if (picked){ rowObj.swatches.push(picked); renderRowPalette(); }
    };
    renderRowPalette();

    return rowObj;
  }

  // ============================================================
  // SHAPE LAYER PICKER  (populates and reacts to the dropdown)
  // ============================================================
  function clearRectRows(){
    for (var i = 0; i < elementRows.length; i++){ try { elContainer.remove(elementRows[i].panel); } catch(_){} }
    elementRows = [];
    elCount.text = "0 elements";
    try { win.layout.layout(true); } catch(_){}
  }

  function populateShapeLayerDrop(compArg){
    var comp = compArg || activeComp();
    if (!comp) return;
    var prev = shapeLayerDrop.selection ? shapeLayerDrop.selection.text : LAYER_NONE;
    var target = (_pendingShapeLayerName !== null && _pendingShapeLayerName !== undefined) ? _pendingShapeLayerName : prev;
    shapeLayerDrop.removeAll();
    shapeLayerDrop.add("item", LAYER_NONE);
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      if (L instanceof ShapeLayer) shapeLayerDrop.add("item", L.name);
    }
    var idx = 0;
    for (var j = 0; j < shapeLayerDrop.items.length; j++){
      if (shapeLayerDrop.items[j].text === target){ idx = j; break; }
    }
    _suppressShapeDropOnChange = true;
    shapeLayerDrop.selection = idx;
    _suppressShapeDropOnChange = false;
    _pendingShapeLayerName = null;
  }

  function scanAndBuildRectRows(){
    clearRectRows();
    var sel = shapeLayerDrop.selection;
    if (!sel || sel.text === LAYER_NONE){ currentShapeLyr = null; return; }
    var comp = activeComp();
    if (!comp){ return; }
    currentShapeLyr = null;
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      if ((L instanceof ShapeLayer) && L.name === sel.text){ currentShapeLyr = L; break; }
    }
    if (!currentShapeLyr){ log("Shape layer not found: " + sel.text); return; }
    var rects = findRectGroups(currentShapeLyr, comp);
    for (var j = 0; j < rects.length; j++){
      elementRows.push(buildRectRow(rects[j], currentShapeLyr));
    }
    elCount.text = elementRows.length + " element" + (elementRows.length === 1 ? "" : "s");
    log("Scanned " + elementRows.length + " rect group(s) from layer: " + currentShapeLyr.name);
    try { win.layout.layout(true); } catch(_){}
    lastShapeLayerFP = buildShapeLayerFP(currentShapeLyr, comp);
  }

  // ============================================================
  // ASPECT DROPDOWN
  // ============================================================
  function ratioOf(label){
    var m = String(label).match(/(\d+)\s*:\s*(\d+)/);
    if (!m) return null;
    return parseFloat(m[1]) / parseFloat(m[2]);
  }
  function aspectList(){ return ASPECT_FALLBACK; }
  function populateAspectDropdown(){
    var prev = aspectDrop.selection ? aspectDrop.selection.text : null;
    aspectDrop.removeAll();
    var list = aspectList();
    for (var i = 0; i < list.length; i++) aspectDrop.add("item", list[i]);
    var idx = -1;
    if (prev){ for (var j = 0; j < aspectDrop.items.length; j++){ if (aspectDrop.items[j].text === prev){ idx = j; break; } } }
    if (idx < 0 && settings.lastAspect && settings.lastAspect !== "match_comp"){
      for (var k = 0; k < aspectDrop.items.length; k++){ if (aspectDrop.items[k].text === settings.lastAspect){ idx = k; break; } }
    }
    aspectDrop.selection = (idx >= 0) ? idx : 0;
  }
  function resolveAspect(comp){
    if (matchCompChk.value && comp){
      var target = comp.width / comp.height;
      var list = aspectList(), best = null, bestD = 1e9;
      for (var i = 0; i < list.length; i++){
        var r = ratioOf(list[i]);
        if (r == null) continue;
        var d = Math.abs(r - target);
        if (d < bestD){ bestD = d; best = list[i]; }
      }
      if (best){ log("Match comp ratio " + target.toFixed(3) + " -> " + best); return best; }
    }
    return aspectDrop.selection ? aspectDrop.selection.text : aspectList()[0];
  }

  // ============================================================
  // EVENT HANDLERS
  // ============================================================
  pingBtn.onClick = function(){
    var host = hostEdit.text, port = portEdit.text;
    try {
      var q = httpGetQueue(host, port);
      connStatus.text = q ? "Status: connected" : "Status: HTTP error";
    } catch(e){ connStatus.text = "Status: not reachable"; }
  };

  matchCompChk.onClick = function(){ aspectDrop.enabled = !matchCompChk.value; saveCurrentCompState(); };
  shapeLayerDrop.onChange = function(){
    if (_suppressShapeDropOnChange) return;
    try { scanAndBuildRectRows(); } catch(e){ log("scanAndBuildRectRows error: " + e); }
    saveCurrentCompState();
  };
  chooseFolderBtn.onClick = function(){ var f = Folder.selectDialog("Choose output folder"); if (f){ outputFolderEdit.text = f.fsName; saveCurrentCompState(); } };
  pickAEFolderBtn.onClick = function(){
    var sel = app.project.selection;
    if (!sel || sel.length === 0){ alert("Select a folder in the Project panel first."); return; }
    var item = sel[0];
    if (!(item instanceof FolderItem)){ alert("Selected item is not a folder."); return; }
    aeFolderEdit.text = getAEFolderPath(item);
    saveCurrentCompState();
  };
  viewLogBtn.onClick = function(){ if (LOG.exists) LOG.execute(); else alert("No log yet at: " + LOG.fsName); };
  resetBtn.onClick = function(){
    if (!confirm("Clear all prompt text, layer bindings, palette and elements for this composition?")) return;
    resetPanelContent();
  };
  stopBtn.onClick = function(){ stopRequested = true; statusTxt.text = "Stopping after current image\u2026"; };
  seedModeDrop.onChange = function(){ updateSeedVarEnabled(); saveCurrentCompState(); };
  styleInclude.onClick = function(){ styleGroup.enabled = styleInclude.value; saveCurrentCompState(); };
  qualityDrop.onChange = function(){ saveCurrentCompState(); };
  mpDrop.onChange = function(){ saveCurrentCompState(); };
  aspectDrop.onChange = function(){ saveCurrentCompState(); };
  workAreaChk.onClick = function(){ saveCurrentCompState(); };
  seedEdit.onChange = function(){ saveCurrentCompState(); };
  stepEdit.onChange = function(){ saveCurrentCompState(); };
  varEdit.onChange = function(){ saveCurrentCompState(); };
  outputFolderEdit.onChange = function(){ saveCurrentCompState(); };
  filePrefixEdit.onChange = function(){ saveCurrentCompState(); };
  aeFolderEdit.onChange = function(){ saveCurrentCompState(); };

  // ============================================================
  // CHANGE-DETECTION FINGERPRINTS
  // ============================================================
  function buildLayerFP(comp){
    if (!comp) return "";
    try {
      var parts = [];
      for (var i = 1; i <= comp.numLayers; i++){
        var L = comp.layer(i);
        var t = (L instanceof ShapeLayer) ? "S" : (L instanceof TextLayer) ? "T" : "O";
        parts.push(t + ":" + L.name);
      }
      return parts.join("|");
    } catch(e){ return ""; }
  }

  function buildShapeLayerFP(layer, comp){
    if (!layer) return "";
    var t = (comp) ? comp.time : 0;
    try {
      var contents = layer.property("ADBE Root Vectors Group");
      if (!contents) return "";
      var parts = [layer.name];   // catches a rename of the selected layer itself
      for (var i = 1; i <= contents.numProperties; i++){
        var grp = contents.property(i);
        if (!grp || grp.matchName !== "ADBE Vector Group") continue;
        var sub = grp.property("ADBE Vectors Group");
        if (!sub) continue;
        var hasRect = false, fillHex = "";
        for (var j = 1; j <= sub.numProperties; j++){
          var p = sub.property(j);
          if (!p) continue;
          if (p.matchName === "ADBE Vector Shape - Rect") hasRect = true;
          if (p.matchName === "ADBE Vector Graphic - Fill"){
            try { fillHex = rgb01ToHex(p.property("ADBE Vector Fill Color").valueAtTime(t, false)); } catch(_){}
          }
        }
        if (hasRect) parts.push(grp.name + ":" + fillHex);
      }
      return parts.join("|");
    } catch(e){ return ""; }
  }

  function buildLayerCountFP(comp){
    if (!comp) return "";
    var s = 0, t = 0;
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      if (L instanceof ShapeLayer) s++;
      else if (L instanceof TextLayer) t++;
    }
    return s + ":" + t;
  }

  function buildTextContentFP(comp){
    if (!comp) return "";
    var parts = [];
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      if (!(L instanceof TextLayer)) continue;
      if (L.selected) continue;  // skip — may be actively editing
      try { parts.push(L.name + ":" + getTextLayerSourceText(L)); } catch(_){}
    }
    return parts.join("|");
  }

  function buildBBoxFP(comp, layer){
    if (!comp || !layer) return "";
    try {
      var rects = findRectGroups(layer, comp);
      var parts = [];
      for (var i = 0; i < rects.length; i++){
        var bb = rectGroupBBox(rects[i], layer, comp);
        parts.push(rects[i].name + ":" + (bb ? bb.join(",") : "?"));
      }
      return parts.join("|");
    } catch(e){ return ""; }
  }

  function refreshBBoxTexts(){
    var comp = activeComp();
    if (!comp || !currentShapeLyr || !elementRows.length) return;
    var freshRects = findRectGroups(currentShapeLyr, comp);
    for (var i = 0; i < elementRows.length && i < freshRects.length; i++){
      var bb = rectGroupBBox(freshRects[i], currentShapeLyr, comp);
      elementRows[i].bboxTxt.text = bb ? "[" + bb.join(",") + "]" : "[bbox n/a]";
      elementRows[i].rectData = freshRects[i];  // keep generation-time geometry in sync with the displayed bbox
    }
  }

  function refreshPartFieldTexts(){
    var blocks = [P.hld, P.aes, P.lig, P.pho, P.med, P.bg];
    for (var i = 0; i < blocks.length; i++) updatePartFieldState(blocks[i]);
  }

  // Display-only: this is purely so swatches don't look stale in the UI.
  // resolveStylePalette() always re-resolves "layer" entries live at generation
  // time regardless of whether this has run, so it can never cause a stale color
  // in the actual prompt -- worst case the swatch just looks outdated until the
  // next mouseover.
  function buildStylePaletteFP(comp){
    if (!comp) return "";
    var parts = [];
    for (var i = 0; i < stylePalette.length; i++){
      var entry = stylePalette[i];
      if (entry.kind !== "layer") continue;
      var hex = resolveLayerFillHex(entry, comp);
      parts.push(entry.shapeLayerName + "/" + entry.groupName + ":" + (hex || "?"));
    }
    return parts.join("|");
  }
  function refreshStylePaletteSwatches(){
    var comp = activeComp();
    if (!comp) return;
    // Update swatches in place rather than rebuildStylePalette(): tearing down and
    // re-adding the iconbuttons from this passive background refresh could leave the
    // row blank until something else forces a relayout. Entry count never changes here
    // (add/remove always go through rebuildStylePalette + win.layout.layout(true)
    // explicitly), so paletteContainer.children[i] reliably maps to stylePalette[i].
    for (var i = 0; i < stylePalette.length; i++){
      var entry = stylePalette[i];
      if (entry.kind !== "layer") continue;
      var hex = resolveLayerFillHex(entry, comp);
      if (hex && hex !== entry.hex){
        entry.hex = hex;
        var sw = paletteContainer.children[i];
        if (sw){ sw.hexVal = hex; sw.notify("onDraw"); }
      }
    }
  }

  // ============================================================
  // PER-COMP SETTINGS MEMORY  (runtime-only; not persisted to SETTINGS_FILE)
  // ============================================================
  function partLayerNameForSave(block){
    var sel = block.layerDrop.selection ? block.layerDrop.selection.text : LAYER_NONE;
    return (sel && sel !== LAYER_NONE) ? sel : null;
  }

  function saveCompState(compId){
    if (!compId) return;
    var parts = {};
    var keys = ["hld","aes","lig","pho","med","bg"];
    for (var i = 0; i < keys.length; i++){
      var k = keys[i], block = P[k];
      parts[k] = { layerName: partLayerNameForSave(block), text: block.field.text };
    }
    var shapeSel = shapeLayerDrop.selection ? shapeLayerDrop.selection.text : LAYER_NONE;
    compStateCache[compId] = {
      parts: parts,
      styleInclude: styleInclude.value,
      stylePalette: deepCopy(stylePalette),
      shapeLayerName: (shapeSel && shapeSel !== LAYER_NONE) ? shapeSel : null,
      quality: qualityDrop.selection ? qualityDrop.selection.index : null,
      megapixels: mpDrop.selection ? mpDrop.selection.text : null,
      matchComp: matchCompChk.value,
      aspect: aspectDrop.selection ? aspectDrop.selection.text : null,
      genMode: modeDrop.selection ? modeDrop.selection.index : 0,
      workAreaOnly: workAreaChk.value,
      seedModeIdx: seedModeDrop.selection ? seedModeDrop.selection.index : 0,
      seed: seedEdit.text, step: stepEdit.text, variations: varEdit.text,
      outputFolder: outputFolderEdit.text, filePrefix: filePrefixEdit.text, aeFolder: aeFolderEdit.text
    };
  }

  function saveCurrentCompState(){
    if (_applyingState) return;
    if (lastCompId !== null) saveCompState(lastCompId);
  }

  function applyCompState(compId){
    var state = compStateCache[compId];
    if (!state){
      // First visit to this comp: a never-before-seen comp starts from a clean slate --
      // both the layer bindings AND the typed text reset together (style palette's
      // layer-bound entries are still dropped below; swatch entries still carry over).
      var keys = ["hld","aes","lig","pho","med","bg"];
      for (var i = 0; i < keys.length; i++){
        var block = P[keys[i]];
        block._pendingLayerName = LAYER_NONE;
        block.linkedLayerId = null;
        block.field.text = "";
      }
      _pendingShapeLayerName = LAYER_NONE;
      var kept = [];
      for (var j = 0; j < stylePalette.length; j++){
        if (stylePalette[j].kind !== "layer") kept.push(stylePalette[j]);
      }
      stylePalette = kept;
      return;
    }
    // Saved state exists: restore everything.
    var keys2 = ["hld","aes","lig","pho","med","bg"];
    for (var k = 0; k < keys2.length; k++){
      var kk = keys2[k], block2 = P[kk], sd = state.parts ? state.parts[kk] : null;
      if (!sd) continue;
      block2._pendingLayerName = sd.layerName ? sd.layerName : LAYER_NONE;
      block2.linkedLayerId = null;
      if (typeof sd.text === "string") block2.field.text = sd.text;
    }
    _pendingShapeLayerName = state.shapeLayerName ? state.shapeLayerName : LAYER_NONE;
    stylePalette = deepCopy(state.stylePalette || []);

    _applyingState = true;
    try {
      if (typeof state.styleInclude === "boolean"){ styleInclude.value = state.styleInclude; styleGroup.enabled = state.styleInclude; }
      if (state.quality !== null && state.quality !== undefined && state.quality >= 0 && state.quality < QUALITY_OPTIONS.length){
        qualityDrop.selection = state.quality;
      }
      if (state.megapixels){
        var mIdx = arrIndexOf(MEGAPIXEL_OPTIONS, state.megapixels);
        if (mIdx >= 0) mpDrop.selection = mIdx;
      }
      if (typeof state.matchComp === "boolean"){
        matchCompChk.value = state.matchComp;
        aspectDrop.enabled = !state.matchComp;
      }
      if (state.aspect){
        for (var a = 0; a < aspectDrop.items.length; a++){
          if (aspectDrop.items[a].text === state.aspect){ aspectDrop.selection = a; break; }
        }
      }
      if (state.genMode === 0 || state.genMode === 1){
        modeDrop.selection = state.genMode;
        workAreaChk.visible = (state.genMode === 1);
      }
      if (typeof state.workAreaOnly === "boolean") workAreaChk.value = state.workAreaOnly;
      if (state.seedModeIdx === 0 || state.seedModeIdx === 1 || state.seedModeIdx === 2){
        seedModeDrop.selection = state.seedModeIdx;
      }
      if (typeof state.seed === "string") seedEdit.text = state.seed;
      if (typeof state.step === "string") stepEdit.text = state.step;
      if (typeof state.variations === "string") varEdit.text = state.variations;
      if (typeof state.outputFolder === "string") outputFolderEdit.text = state.outputFolder;
      if (typeof state.filePrefix === "string") filePrefixEdit.text = state.filePrefix;
      if (typeof state.aeFolder === "string") aeFolderEdit.text = state.aeFolder;
      updateSeedVarEnabled();
    } finally { _applyingState = false; }
  }

  // Manual "Reset" button: clears prompt content (text, layer bindings, palette,
  // elements) for the current comp, and drops its cached state so a later switch
  // away and back doesn't resurrect the pre-reset content. Generation preferences
  // (quality/aspect/seed/folders/etc.) are deliberately left untouched.
  function resetPanelContent(){
    _applyingState = true;
    try {
      var keys = ["hld","aes","lig","pho","med","bg"];
      for (var i = 0; i < keys.length; i++){
        var block = P[keys[i]];
        block.layerDrop.selection = 0;   // LAYER_NONE is always index 0
        block.linkedLayerId = null;
        block.field.text = "";
        block.field.enabled = true;
      }
      stylePalette = [];
      if (shapeLayerDrop.items.length){
        _suppressShapeDropOnChange = true;
        shapeLayerDrop.selection = 0;    // LAYER_NONE
        _suppressShapeDropOnChange = false;
      }
      currentShapeLyr = null;
    } finally {
      _applyingState = false;
    }
    clearRectRows();
    rebuildStylePalette();
    if (lastCompId !== null) delete compStateCache[lastCompId];
    win.layout.layout(true);
  }

  // ============================================================
  // COMPOSITION MONITORING
  // ============================================================
  function refreshForComp(){
    if (generating) return;
    var c = activeComp();
    var cid = c ? c.id : null, cname = c ? c.name : null;

    // --- Comp switch ---
    var compChanged = (cid !== lastCompId || cname !== lastCompName);
    if (compChanged){
      var prevId = lastCompId;
      lastCompId = cid; lastCompName = cname;
      lastLayerFingerprint = null; lastLayerCountFP = null;
      lastShapeLayerFP = null; lastTextContentFP = null; lastBBoxFP = null;
      lastStylePaletteFP = null;
      currentShapeLyr = null;
      if (c){
        saveCompState(prevId);
        applyCompState(cid);
        try { populateAllPartDropdowns(c); } catch(_){}
        try { populateShapeLayerDrop(c); } catch(_){}
        try { scanAndBuildRectRows(); } catch(_){}
        try { rebuildStylePalette(); } catch(_){}
        _pendingLayerRefresh = false;
        _pendingRectRebuild  = false;
        _pendingTextRefresh  = true;
        try { win.layout.layout(true); } catch(_){}
      } else {
        _pendingLayerRefresh = true;
        _pendingRectRebuild  = true;
        _pendingTextRefresh  = true;
      }
      return;
    }

    if (!c) return;

    // --- Layer name/structure changes anywhere → dropdown choices need refreshing ---
    var layerFP = buildLayerFP(c);
    if (layerFP !== lastLayerFingerprint){
      lastLayerFingerprint = layerFP;
      _pendingLayerRefresh = true;
    }

    // --- Layer count changes (add/remove) → dropdown rebuild (rename-immune) ---
    var countFP = buildLayerCountFP(c);
    if (countFP !== lastLayerCountFP){
      lastLayerCountFP = countFP;
      _pendingLayerRefresh = true;
    }

    // --- Shape layer content changes (rect groups added/deleted/renamed/recolored) ---
    var shapeFP = buildShapeLayerFP(currentShapeLyr, c);
    if (shapeFP !== lastShapeLayerFP){
      lastShapeLayerFP = shapeFP;
      _pendingRectRebuild = true;
    }

    // --- Bbox changes (rect moved/resized, layer transform or bbox keyframe) ---
    var bboxFP = buildBBoxFP(c, currentShapeLyr);
    if (bboxFP !== lastBBoxFP){
      lastBBoxFP = bboxFP;
      _pendingBBoxRefresh = true;
    }

    // --- Style palette layer-bound fills changed (recolored elsewhere in the comp) ---
    var paletteFP = buildStylePaletteFP(c);
    if (paletteFP !== lastStylePaletteFP){
      lastStylePaletteFP = paletteFP;
      _pendingPaletteRefresh = true;
    }

  }
  function scheduleMonitor(){
    try { app.scheduleTask("$._comfyIdeogramPanel.tick && $._comfyIdeogramPanel.tick()", POLL_MS, false); } catch(_){}
  }
  $._comfyIdeogramPanel.tick = function(){
    if ($._comfyIdeogramPanel._sessionId !== _panelSessionId) return;
    try { refreshForComp(); } catch(e){ log("tick error: " + e); }
    scheduleMonitor();
  };

  // ============================================================
  // SETTINGS PERSISTENCE
  // ============================================================
  function persistAllSettings(){
    settings.host = hostEdit.text; settings.port = portEdit.text;
    settings.outputFolder = outputFolderEdit.text;
    settings.lastQuality = QUALITY_OPTIONS[qualityDrop.selection.index].choice;
    settings.lastMegapixels = mpDrop.selection ? mpDrop.selection.text : "1.0";
    settings.lastAspect = matchCompChk.value ? "match_comp" : (aspectDrop.selection ? aspectDrop.selection.text : "match_comp");
    settings.lastVariations = Math.max(1, parseInt(varEdit.text,10) || 1);
    settings.seedMode = currentSeedMode();
    settings.lastSeed = parseInt(seedEdit.text,10) || 0;
    settings.lastSeedStep = parseInt(stepEdit.text,10) || 1;
    settings.genMode      = (modeDrop.selection.index === 1) ? "everyframe" : "single";
    settings.workAreaOnly = workAreaChk.value;
    settings.filenamePrefix = filePrefixEdit.text || "Ideogram_AE";
    settings.aeProjectFolder = aeFolderEdit.text || "";
    saveSettings(settings);
  }
  function resolveOutputFolder(){
    var path = outputFolderEdit.text;
    if (!path || path.length === 0){
      var pf = app.project ? app.project.file : null;
      path = (pf && pf.exists) ? pf.parent.fsName : Folder.temp.fsName;
      outputFolderEdit.text = path;
    }
    var f = new Folder(path); if (!f.exists) f.create(); return f;
  }

  // ============================================================
  // POLL + OUTPUT
  // ============================================================
  function pollUntilDone(promptId, host, port, timeoutMs){
    var t0 = new Date().getTime();
    while (true){
      if (stopRequested) return null;
      var hist = httpHistoryMaybe(promptId, host, port);
      if (hist && hist[promptId]) return hist[promptId];
      if ((new Date().getTime() - t0) > timeoutMs) die("Timeout waiting for generation (prompt " + promptId + ")");
      sleep(POLL_MS);
    }
  }
  function findOutputs(histEntry, saveNodeId){
    var out = [];
    if (!histEntry || !histEntry.outputs) return out;
    var n = histEntry.outputs[saveNodeId];
    if (n && n.images){ for (var i=0;i<n.images.length;i++) out.push(n.images[i]); return out; }
    for (var k in histEntry.outputs){ if (!histEntry.outputs.hasOwnProperty(k)) continue;
      var nn = histEntry.outputs[k]; if (nn && nn.images){ for (var j=0;j<nn.images.length;j++) out.push(nn.images[j]); } }
    return out;
  }

  // ============================================================
  // GENERATE
  // ============================================================
  genBtn.onClick = function(){
    try { runGenerate(); }
    catch(e){ statusTxt.text = "Error"; log("Generate error: " + e); alert("Error: " + e.message + "\n\nLog: " + LOG.fsName); }
    finally { generating = false; stopRequested = false; genBtn.enabled = true; stopBtn.enabled = false; }
  };

  function runGenerate(){
    if (generating){ alert("Generation already in progress."); return; }
    persistAllSettings();
    var comp = activeComp();
    if (!comp){ alert("No active composition."); return; }

    var qualityChoice = QUALITY_OPTIONS[qualityDrop.selection.index].choice;
    var megapixels = parseFloat(mpDrop.selection ? mpDrop.selection.text : "1.0");
    var aspect = resolveAspect(comp);
    var seedMode = currentSeedMode();
    var seedBase = parseInt(seedEdit.text,10) || 0;
    var step = parseInt(stepEdit.text,10) || 1;
    var outFolder = resolveOutputFolder();
    var host = hostEdit.text, port = portEdit.text;
    var everyFrame = (modeDrop.selection.index === 1);

    if (everyFrame){
      var variations = (seedMode === "fixed") ? 1 : Math.max(1, parseInt(varEdit.text,10) || 1);
      var savedTime = comp.time;
      generating = true; stopRequested = false; genBtn.enabled = false; stopBtn.enabled = true;
      var doneTotal = 0, failTotal = 0;

      app.beginUndoGroup("IdeogramGen (every frame x" + variations + ")");
      try {
        for (var v = 0; v < variations; v++){
          if (stopRequested){ log("Stopped before variation " + (v+1)); break; }
          var seed = nextSeed(seedMode, seedBase, v, step);
          var result = runAllFrames(comp, host, port, outFolder, qualityChoice, megapixels, aspect,
                                    seed, workAreaChk.value, v, variations);
          doneTotal += result.done; failTotal += result.fail;
        }
      } finally {
        app.endUndoGroup();
        generating = false; stopRequested = false; genBtn.enabled = true; stopBtn.enabled = false;
        try { comp.time = savedTime; } catch(_){}
      }

      statusTxt.text = "Done";
      var msg = "Generated " + doneTotal + " frame(s)" + (variations > 1 ? " across " + variations + " variation(s)" : "");
      if (failTotal > 0) msg += "\n" + failTotal + " failed (see log)";
      if (stopRequested) msg += "\nStopped early";
      alert(msg);
      return;
    }

    var caption = assembleCaption(comp);
    if (isEmptyObj(caption)){ alert("Nothing to send — fill at least one prompt part."); return; }
    var promptJSON = JSON.stringify(caption);
    log("Caption: " + promptJSON.substring(0, 400));

    var variations = (seedMode === "fixed") ? 1 : Math.max(1, parseInt(varEdit.text,10) || 1);

    generating = true; stopRequested = false; genBtn.enabled = false; stopBtn.enabled = true;
    var success = 0, fail = 0;

    app.beginUndoGroup("IdeogramGen (" + variations + ")");
    try {
      for (var v = 0; v < variations; v++){
        if (stopRequested){ log("Stopped after " + v); break; }
        statusTxt.text = "Generating " + (v+1) + " of " + variations + "\u2026";
        var seed = nextSeed(seedMode, seedBase, v, step);
        try {
          runSingle(promptJSON, seed, aspect, megapixels, qualityChoice, outFolder, comp, host, port, v);
          success++;
          settings.sessionCount = (settings.sessionCount||0) + 1;
          try { app.project.save(); } catch(se){ log("save failed: " + se); }
        } catch(itemErr){ fail++; log("Variation " + (v+1) + " failed: " + itemErr.message); }
      }
    } finally { app.endUndoGroup(); }

    statusTxt.text = "Done";
    var msg = "Generated " + success + " image(s)";
    if (fail > 0) msg += "\n" + fail + " failed (see log)";
    if (stopRequested) msg += "\nStopped early";
    alert(msg);
  }

  function runSingle(promptJSON, seed, aspect, megapixels, qualityChoice, outFolder, comp, host, port, vIndex){
    var wf = buildWorkflow({ promptJSON: promptJSON, seed: seed, aspect: aspect, megapixels: megapixels, qualityChoice: qualityChoice, filenamePrefix: filePrefixEdit.text });
    var resp = httpPostPrompt(wf, host, port);
    if (!resp || !resp.prompt_id) die("ComfyUI did not return a prompt_id");
    var promptId = resp.prompt_id;
    log("Submitted prompt_id=" + promptId + " seed=" + seed + " aspect=" + aspect + " q=" + qualityChoice);

    var hist = pollUntilDone(promptId, host, port, 10 * 60 * 1000); // Ideogram 4 is heavy; 10 min
    if (!hist){ log("Cancelled mid-poll for " + promptId); return; }

    var images = findOutputs(hist, SAVE_NODE);
    if (images.length === 0) die("No image output in history for " + promptId);

    for (var im = 0; im < images.length; im++){
      var info = images[im];
      var viewPath = "/view?filename=" + encodeURIComponent(info.filename)
                   + "&subfolder=" + encodeURIComponent(info.subfolder || "")
                   + "&type=" + encodeURIComponent(info.type || "output");
      var localFile = new File(outFolder.fsName + "/" + info.filename);
      httpDownloadToFile(viewPath, localFile, host, port);

      var io = new ImportOptions(localFile);
      var footage = app.project.importFile(io);
      var aeFolder = findOrCreateAEProjectFolder(aeFolderEdit.text || "");
      if (aeFolder) try { footage.parentFolder = aeFolder; } catch(_){}
      var L = comp.layers.add(footage);
      fitLayerToComp(L, comp);
      try { L.name = "Ideogram | var" + (vIndex+1); } catch(_){}
    }
  }

  function runSingleFrame(promptJSON, seed, aspect, megapixels, qualityChoice,
                          outFolder, comp, host, port, frameNum, frameTime, vIndex){
    var dt = comp.frameDuration;
    var wf = buildWorkflow({ promptJSON: promptJSON, seed: seed, aspect: aspect,
                             megapixels: megapixels, qualityChoice: qualityChoice, filenamePrefix: filePrefixEdit.text });
    var resp = httpPostPrompt(wf, host, port);
    if (!resp || !resp.prompt_id) die("ComfyUI did not return a prompt_id");
    var promptId = resp.prompt_id;
    log("Frame " + frameNum + " var" + (vIndex+1) + " prompt_id=" + promptId + " seed=" + seed);

    var hist = pollUntilDone(promptId, host, port, 10 * 60 * 1000);
    if (!hist){ log("Cancelled mid-poll for frame " + frameNum); return; }

    var images = findOutputs(hist, SAVE_NODE);
    if (images.length === 0) die("No image output for frame " + frameNum);

    for (var im = 0; im < images.length; im++){
      var info = images[im];
      var viewPath = "/view?filename=" + encodeURIComponent(info.filename)
                   + "&subfolder=" + encodeURIComponent(info.subfolder || "")
                   + "&type="      + encodeURIComponent(info.type || "output");
      var outName   = "var" + pad(vIndex+1, 2) + "_frame_" + pad(frameNum, 5) + "_" + info.filename;
      var localFile = new File(outFolder.fsName + "/" + outName);
      httpDownloadToFile(viewPath, localFile, host, port);

      var io = new ImportOptions(localFile);
      var footage = app.project.importFile(io);
      var aeFolder = findOrCreateAEProjectFolder(aeFolderEdit.text || "");
      if (aeFolder) try { footage.parentFolder = aeFolder; } catch(_){}
      var L = comp.layers.add(footage);
      fitLayerToComp(L, comp);
      L.startTime = frameTime;
      L.outPoint  = frameTime + dt;
      try { L.name = "Ideogram | var" + (vIndex+1) + " fr" + pad(frameNum, 5); } catch(_){}
    }
  }

  function runAllFrames(comp, host, port, outFolder, qualityChoice, megapixels, aspect,
                        seed, useWorkArea, vIndex, vCount){
    var startT = useWorkArea ? comp.workAreaStart : 0;
    var endT   = useWorkArea ? (comp.workAreaStart + comp.workAreaDuration) : comp.duration;
    var dt     = comp.frameDuration;
    var totalFrames = Math.max(1, Math.round((endT - startT) / dt));
    var done = 0, fail = 0;
    var vLabel = (vCount > 1) ? ("Var " + (vIndex+1) + "/" + vCount + " — ") : "";

    for (var t = startT; t < endT - dt * 0.5 && !stopRequested; t += dt){
      var frameNum = Math.round((t - startT) / dt);
      statusTxt.text = vLabel + "Frame " + (frameNum + 1) + " / " + totalFrames + "…";
      comp.time = t;
      var caption = assembleCaptionFresh(comp);
      if (isEmptyObj(caption)){
        log("Frame " + frameNum + ": empty caption, skipping"); done++; continue;
      }
      var promptJSON = JSON.stringify(caption);
      try {
        runSingleFrame(promptJSON, seed, aspect, megapixels, qualityChoice,
                       outFolder, comp, host, port, frameNum, t, vIndex);
        done++;
        settings.sessionCount = (settings.sessionCount || 0) + 1;
        try { app.project.save(); } catch(_){}
      } catch(e){ fail++; log("Frame " + frameNum + " (var " + (vIndex+1) + ") failed: " + e.message); }
    }
    return { done: done, fail: fail };
  }

  // ============================================================
  // INITIAL POPULATION
  // ============================================================
  (function initSelections(){
    // quality
    var qIdx = 1;
    for (var i = 0; i < QUALITY_OPTIONS.length; i++) if (QUALITY_OPTIONS[i].choice === settings.lastQuality) qIdx = i;
    qualityDrop.selection = qIdx;
    // megapixels
    var mIdx = arrIndexOf(MEGAPIXEL_OPTIONS, settings.lastMegapixels); mpDrop.selection = (mIdx>=0)?mIdx:1;
    // match comp
    matchCompChk.value = (settings.lastAspect === "match_comp");
    aspectDrop.enabled = !matchCompChk.value;
    styleGroup.enabled = styleInclude.value;
    modeDrop.selection  = (settings.genMode === "everyframe") ? 1 : 0;
    workAreaChk.value   = (settings.workAreaOnly !== false);
    workAreaChk.visible = (modeDrop.selection.index === 1);
    updateSeedVarEnabled();
  })();

  populateAspectDropdown();
  populateAllPartDropdowns();
  populateShapeLayerDrop();
  scanAndBuildRectRows();
  rebuildStylePalette();

  // Initial connectivity check
  try {
    var q0 = httpGetQueue(hostEdit.text, portEdit.text);
    connStatus.text = q0 ? "Status: connected" : "Status: HTTP error";
  } catch(e){ connStatus.text = "Status: not reachable"; }

  lastCompId = activeComp() ? activeComp().id : null;
  lastCompName = activeComp() ? activeComp().name : null;
  scheduleMonitor();

  win.onResizing = win.onResize = function(){ this.layout.resize(); };
  if (win instanceof Window){ win.center(); win.show(); }
  else { win.layout.layout(true); win.layout.resize(); }

})(this);
