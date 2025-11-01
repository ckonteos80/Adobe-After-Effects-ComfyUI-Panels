/* Comfy I2I Panel — Prompt, Denoise, Sampler/Steps/CFG, Size, Seed, Source, Add-to-Comp
   Pure ExtendScript (AE) + Socket HTTP; no external tools required.
   Uses ComfyUI /upload/image API - no local folder configuration needed! */

(function (thisObj) {
  // ================= USER SETTINGS =================
  var DEFAULT_HOST = "127.0.0.1";    // default ComfyUI host
  var DEFAULT_PORT = "8188";         // default ComfyUI port (8188 is standard)

  // Polling/timeouts
  var POLL_MS    = 1000;
  var TIMEOUT_MS = 180000;

  // Size behavior
  var DEFAULT_SNAP = 64;   // 64 for SDXL; use 8 if you want exact 1080x1920
  var DEFAULT_MAXW = 2048; // set to null to disable caps
  var DEFAULT_MAXH = 2048;
  
  // UI Size Constants
  var UI_SIZES = {
    PROMPT_HEIGHT: 60,
    NEG_PROMPT_HEIGHT: 40,
    SLIDER_WIDTH: 200,
    EDITTEXT_SMALL: 50,
    EDITTEXT_MEDIUM: 100,
    LAYER_DROPDOWN_WIDTH: 250
  };

  // Settings file for persistence
  var SETTINGS_FILE = new File(Folder.userData.fsName + "/ComfyI2I_Settings.json");
  
  // Initialize unique namespace for this panel
  if (!$._comfyI2IPanel) {
    $._comfyI2IPanel = {};
  }

  // =================================================
  var LOG = new File(Folder.temp.fsName + "/Comfy_I2I_Panel.log");
  // Don't delete existing log - keep history
  function log(s){ 
    try{ 
      LOG.open("a"); 
      LOG.writeln(new Date().toISOString() + "  " + s); 
      LOG.close(); 
    } catch(e) { 
      // Silently fail if can't write log
    } 
  }
  
  // Write initial log entry
  log("=== Panel initialized ===");

  // ====== Settings persistence ======
  function loadSettings(){
    var defaults = {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      workflow: "",
      outputFolder: ""
    };
    
    if (!SETTINGS_FILE.exists) return defaults;
    
    try {
      if (SETTINGS_FILE.open("r")) {
        var json = SETTINGS_FILE.read();
        var settings = JSON.parse(json);
        return settings || defaults;
      }
      return defaults;
    } catch(e) {
      log("Failed to load settings: " + e);
      return defaults;
    } finally {
      try { SETTINGS_FILE.close(); } catch(e) {}
    }
  }

  function saveSettings(host, port, workflow, outputFolder){
    try {
      var settings = {};
      settings.host = host;
      settings.port = port;
      settings.workflow = workflow;
      settings.outputFolder = outputFolder || "";
      
      if (SETTINGS_FILE.open("w")) {
        SETTINGS_FILE.write(JSON.stringify(settings));
        log("Settings saved: " + SETTINGS_FILE.fsName);
      }
    } catch(e) {
      log("Failed to save settings: " + e);
    } finally {
      try { SETTINGS_FILE.close(); } catch(e) {}
    }
  }

  // ====== HTTP (socket) helpers ======
  
  // Input validation helpers
  function validateHost(host) {
    if (!host || host.trim() === "") return "Host cannot be empty";
    // Accept localhost or IP address format
    if (!/^(localhost|(\d{1,3}\.){3}\d{1,3})$/i.test(host.trim())) {
      return "Invalid host format (use 'localhost' or IP address like '127.0.0.1')";
    }
    return null;
  }
  
  function validatePort(port) {
    if (!port || port.trim() === "") return "Port cannot be empty";
    var portNum = parseInt(port.trim(), 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return "Port must be a number between 1 and 65535";
    }
    return null;
  }
  
  function sanitizePrompt(text) {
    // Remove control characters but preserve newlines
    return String(text || "")
      .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "")
      .trim();
  }
  
  function die(msg, detail){ 
    log("FAIL: "+msg+" :: "+(detail||"")); 
    alert(msg + (detail?("\n\nDetail:\n"+detail):"") + "\n\nLog: " + LOG.fsName); 
    throw new Error(msg); 
  }
  function sleep(ms){ $.sleep(ms); }
  function toBytes(str){ var out=[],c; for(var i=0;i<str.length;i++){ c=str.charCodeAt(i);
    if(c<=0x7F) out.push(c); else if(c<=0x7FF){ out.push(0xC0|(c>>6),0x80|(c&0x3F)); }
    else{ out.push(0xE0|(c>>12),0x80|((c>>6)&0x3F),0x80|(c&0x3F)); } } return out; }
  function readAll(sock){ var chunks=[]; while(!sock.eof){ var p=sock.read(8192); if(!p) break; chunks.push(p); } return chunks.join(""); }

  function httpRequest(method, path, headers, bodyStr, wantBinary, allowErrors, host, port){
    var s = new Socket();
    if (!s.open(host + ":" + port, "BINARY")) die("Could not connect to "+host+":"+port);
    var CRLF="\r\n";
    var req = method+" "+path+" HTTP/1.1"+CRLF+"Host: "+host+":"+port+CRLF+"Connection: close"+CRLF;
    if (headers) for (var k in headers) if (headers.hasOwnProperty(k)) req += k+": "+headers[k]+CRLF;

    if (bodyStr!=null){
      var b=toBytes(bodyStr); req += "Content-Length: "+b.length+CRLF+CRLF; s.write(req);
      var bin=""; for (var i=0;i<b.length;i++) bin+=String.fromCharCode(b[i]); s.write(bin);
    } else { req += CRLF; s.write(req); }

    var raw = readAll(s); s.close();
    var idx = raw.indexOf("\r\n\r\n"); if (idx<0) die("Malformed HTTP response.");
    var head = raw.substring(0, idx), body = raw.substring(idx+4);
    var first = head.split("\r\n")[0]; var m = first.match(/^HTTP\/\d\.\d\s+(\d+)/); var status = m?parseInt(m[1],10):0;
    if (!allowErrors && (status<200 || status>=300)) die("HTTP "+status+" for "+path, body);
    return { status: status, body: wantBinary ? body : body.toString() };
  }

  function httpRequestBinary(method, path, headers, bodyBinary, wantBinary, allowErrors, host, port){
    var s = new Socket();
    if (!s.open(host + ":" + port, "BINARY")) die("Could not connect to "+host+":"+port);
    var CRLF="\r\n";
    var req = method+" "+path+" HTTP/1.1"+CRLF+"Host: "+host+":"+port+CRLF+"Connection: close"+CRLF;
    if (headers) for (var k in headers) if (headers.hasOwnProperty(k)) req += k+": "+headers[k]+CRLF;

    if (bodyBinary!=null){
      req += "Content-Length: "+bodyBinary.length+CRLF+CRLF;
      s.write(req);
      s.write(bodyBinary);
    } else { req += CRLF; s.write(req); }

    var raw = readAll(s); s.close();
    var idx = raw.indexOf("\r\n\r\n"); if (idx<0) die("Malformed HTTP response.");
    var head = raw.substring(0, idx), body = raw.substring(idx+4);
    var first = head.split("\r\n")[0]; var m = first.match(/^HTTP\/\d\.\d\s+(\d+)/); var status = m?parseInt(m[1],10):0;
    if (!allowErrors && (status<200 || status>=300)) die("HTTP "+status+" for "+path, body);
    return { status: status, body: wantBinary ? body : body.toString() };
  }

  function httpPostJSONPrompt(promptObj, host, port){
    var payload = JSON.stringify({ prompt: promptObj });
    var r = httpRequest("POST", "/prompt", {"Content-Type":"application/json"}, payload, false, false, host, port);
    try { return JSON.parse(r.body); } catch(e){ die("JSON parse error from POST /prompt", r.body); }
  }
  function httpHistoryMaybe(promptId, host, port){
    var r = httpRequest("GET", "/history/" + promptId, {"Accept":"application/json"}, null, false, true, host, port);
    if (r.status !== 200 || !r.body) return null;
    try { return JSON.parse(r.body); } catch(e){ die("JSON parse error from /history/"+promptId, r.body); }
  }
  function httpDownloadToFile(path, outFile, host, port){
    var r = httpRequest("GET", path, null, null, true, false, host, port);
    outFile.encoding="BINARY"; if(!outFile.open("w")) die("Cannot write file:\n"+outFile.fsName);
    outFile.write(r.body); outFile.close(); if(!outFile.exists) die("Download failed:\n"+outFile.fsName);
  }

  // NEW: Upload image to ComfyUI via /upload/image API
  function httpUploadImage(sourceFile, host, port){
    var file = new File(sourceFile);
    if (!file.exists) die("Source image does not exist:\n"+file.fsName);
    if (!extOK(file.name)) die("Unsupported source image type (use PNG/JPG/WEBP/BMP).");

    // Read file as binary
    file.encoding = "BINARY";
    if (!file.open("r")) die("Cannot read source file:\n"+file.fsName);
    var fileData = file.read();
    file.close();

    // Build multipart/form-data
    var boundary = "----AEComfyBoundary" + Math.floor(Math.random()*1000000);
    var CRLF = "\r\n";
    
    var body = "";
    body += "--" + boundary + CRLF;
    body += 'Content-Disposition: form-data; name="image"; filename="' + basename(file.name) + '"' + CRLF;
    body += "Content-Type: application/octet-stream" + CRLF + CRLF;

    var bodyPrefix = body;
    var bodySuffix = CRLF + "--" + boundary + "--" + CRLF;
    
    var prefixBin = "";
    for (var i = 0; i < bodyPrefix.length; i++) {
      prefixBin += String.fromCharCode(bodyPrefix.charCodeAt(i) & 0xFF);
    }
    
    var suffixBin = "";
    for (var i = 0; i < bodySuffix.length; i++) {
      suffixBin += String.fromCharCode(bodySuffix.charCodeAt(i) & 0xFF);
    }

    var fullBody = prefixBin + fileData + suffixBin;

    log("Uploading image: " + file.name + " (" + fullBody.length + " bytes)");

    var headers = {
      "Content-Type": "multipart/form-data; boundary=" + boundary
    };

    var r = httpRequestBinary("POST", "/upload/image", headers, fullBody, false, false, host, port);
    
    try {
      var result = JSON.parse(r.body);
      if (!result || !result.name) die("Upload failed - no filename returned", r.body);
      log("Upload successful: " + result.name);
      return result.name;
    } catch(e) {
      die("JSON parse error from /upload/image", r.body);
    }
  }

  // ====== AE helpers ======
  function activeComp(){ return (app.project && app.project.activeItem instanceof CompItem) ? app.project.activeItem : null; }
  function fitLayerToComp(layer, comp){
    if (!layer || !comp || layer.width<=0 || layer.height<=0) return;
    var sx=(comp.width/layer.width)*100, sy=(comp.height/layer.height)*100, s=Math.max(sx,sy);
    var tr=layer.property("ADBE Transform Group"); if(tr){ var sc=tr.property("ADBE Scale"), ps=tr.property("ADBE Position");
      if(sc) sc.setValue([s,s,100]); if(ps) ps.setValue([comp.width/2, comp.height/2]); }
  }
  function setLayerInOutLike(layer, refLayer, comp){
    if (!layer || !refLayer) return;
    layer.startTime=0; layer.inPoint=refLayer.inPoint; layer.outPoint=Math.min(refLayer.outPoint, comp.duration);
  }
  
  function renderLayerToFile(layer, comp, outputFile) {
    log("=== renderLayerToFile START ===");
    log("Layer: " + (layer ? layer.name : "NULL"));
    log("Comp: " + (comp ? comp.name : "NULL"));
    log("Output file: " + (outputFile ? outputFile.fsName : "NULL"));
    
    try {
      log("Exporting frame from composition: " + comp.name);
      
      // Make sure comp viewer is active
      comp.openInViewer();
      $.sleep(300);
      
      // Create render queue item for single frame
      var renderQueue = app.project.renderQueue;
      log("Creating render queue item...");
      var renderItem = renderQueue.items.add(comp);
      log("Render item created, index: " + renderItem.index);
      
      // Set to render only current frame
      renderItem.timeSpanStart = comp.time;
      renderItem.timeSpanDuration = comp.frameDuration;
      
      log("Render time span: " + comp.time + " duration: " + comp.frameDuration);
      
      // Configure output module for PNG
      var outputModule = renderItem.outputModule(1);
      log("Got output module: " + outputModule.name);
      
      // Apply the PNG After 2 Comfy template
      var templateName = "PNG After 2 Comfy";
      
      try {
        log("Applying template: " + templateName);
        outputModule.applyTemplate(templateName);
        log("Template applied successfully");
      } catch(templateErr) {
        log("ERROR: Failed to apply template '" + templateName + "': " + templateErr.toString());
        log("Available templates:");
        var templates = outputModule.templates;
        for (var i = 0; i < templates.length; i++) {
          log("  - " + templates[i]);
        }
        throw new Error("Could not apply PNG template. Please ensure template '" + templateName + "' exists.");
      }
      
      // Force single file output (not sequence)
      // Get settings and modify to ensure single frame output
      try {
        var omSettings = outputModule.getSettings(GetSettingsFormat.STRING_SETTABLE);
        log("Current output settings:");
        log("  Use Comp Frame Number: " + omSettings["Use Comp Frame Number"]);
        log("  Starting Frame: " + omSettings["Starting Frame"]);
        
        // Disable frame numbering for single file output
        omSettings["Use Comp Frame Number"] = false;
        omSettings["Starting Frame"] = 0;
        
        outputModule.setSettings(omSettings);
        log("Modified settings to disable frame numbering");
      } catch(settingsErr) {
        log("WARNING: Could not modify frame numbering settings: " + settingsErr.toString());
      }
      
      // Set output file path
      log("Setting output file to: " + outputFile.fsName);
      outputModule.file = outputFile;
      
      // Get the actual file path After Effects will use (may add frame numbers)
      var actualOutputPath = outputModule.file.fsName;
      log("After Effects actual output path: " + actualOutputPath);
      
      // Check render item status before rendering
      log("Render item status: " + renderItem.status);
      log("Render item.render flag: " + renderItem.render);
      
      // Ensure item is queued for rendering
      if (renderItem.status !== RQItemStatus.QUEUED) {
        log("WARNING: Render item not queued, status is: " + renderItem.status);
        // Try to force queue it
        renderItem.render = true;
        log("Set render flag to true, new status: " + renderItem.status);
      }
      
      log("Rendering frame...");
      
      // Render the single frame
      log("Starting render queue...");
      renderQueue.render();
      log("Render queue completed");
      
      // Check final status
      log("Final render item status: " + renderItem.status);
      
      // Wait a moment for file system
      $.sleep(300);
      
      // The actual file might have frame numbers appended
      // Try to find the actual created file
      var actualFile = null;
      
      // Check if the exact file exists
      if (outputFile.exists) {
        log("Output file exists at expected location");
        actualFile = outputFile;
      } else {
        // File doesn't exist at expected path, look for numbered version
        log("Checking for numbered sequence file...");
        var folder = outputFile.parent;
        var baseName = outputFile.name.replace(/\.png$/i, "");
        
        // Common frame number patterns AE uses
        var patterns = [
          baseName + ".png00000",  // Extension gets frame number appended
          baseName + "00000.png",
          baseName + ".png[00000]",
          baseName + "_00000.png", 
          baseName + "[00000].png"
        ];
        
        for (var i = 0; i < patterns.length; i++) {
          var testFile = new File(folder.fsName + "/" + patterns[i]);
          log("Testing: " + testFile.fsName + " exists=" + testFile.exists);
          if (testFile.exists) {
            actualFile = testFile;
            log("Found actual output file: " + actualFile.fsName);
            break;
          }
        }
      }
      
      if (!actualFile || !actualFile.exists) {
        log("ERROR: Could not find rendered file!");
        log("Expected: " + outputFile.fsName);
        log("Also checked numbered versions");
        
        // Last resort - list all files in the folder to see what was created
        log("Listing files in output folder:");
        var folderFiles = folder.getFiles();
        for (var i = 0; i < folderFiles.length; i++) {
          if (folderFiles[i] instanceof File) {
            log("  " + folderFiles[i].name);
          }
        }
        
        throw new Error("Frame export failed - file not created at: " + outputFile.fsName);
      }
      
      log("Frame exported successfully: " + actualFile.length + " bytes");
      log("Actual file path: " + actualFile.fsName);
      
      // If we got a numbered file, rename it to what we wanted
      if (actualFile.fsName !== outputFile.fsName) {
        log("Renaming numbered file to desired name...");
        log("From: " + actualFile.fsName);
        log("To: " + outputFile.fsName);
        try {
          // Delete target if it exists
          if (outputFile.exists) {
            outputFile.remove();
            log("Removed existing target file");
          }
          
          // Rename the numbered file
          if (actualFile.rename(outputFile.name)) {
            log("Renamed successfully");
            actualFile = outputFile;
          } else {
            log("Rename returned false, trying copy...");
            // If rename fails, try copy and delete
            actualFile.copy(outputFile);
            actualFile.remove();
            actualFile = outputFile;
            log("Copied and deleted original");
          }
        } catch(renameErr) {
          log("Rename/copy failed: " + renameErr.toString());
          log("Will use numbered file as-is");
        }
      }
      
      // Clean up
      renderItem.remove();
      log("Render item removed");
      log("=== renderLayerToFile SUCCESS ===");
      
      return actualFile;
      
    } catch(e) {
      log("ERROR in renderLayerToFile: " + e.toString());
      log("Error line: " + (e.line || "unknown"));
      log("=== renderLayerToFile FAILED ===");
      throw e;
    }
  }

  // ====== Workflow utilities ======
  function deepCopy(o){ return JSON.parse(JSON.stringify(o)); }
  function snap(n, div){ return Math.max(div, Math.round(n/div)*div); }
  function clamp(n, maxv){ return (maxv && isFinite(maxv)) ? Math.min(n, maxv) : n; }
  function getCompDims(comp, div, maxw, maxh){
    var w=comp.width, h=comp.height;
    if (div && div>1){ w=snap(w,div); h=snap(h,div); }
    w=clamp(w,maxw); h=clamp(h,maxh);
    if (div && div>1){ w=Math.floor(w/div)*div; h=Math.floor(h/div)*div; }
    if (w < (div||1)) w=(div||1); if (h < (div||1)) h=(div||1);
    return {w:w,h:h};
  }
  function injectPrompt(wf, text, preferredId){
    var id=null;
    if (preferredId && wf[preferredId] && wf[preferredId].class_type==="CLIPTextEncode") id=preferredId;
    else { for (var k in wf){ var n=wf[k]; if(n && n.class_type==="CLIPTextEncode" && n.inputs && n.inputs.hasOwnProperty("text")){ id=k; break; }}}
    if (!id) die("No CLIPTextEncode node with 'text' input.");
    wf[id].inputs.text = text; return id;
  }
  
  function findNegativePromptNode(wf, positiveNodeId){
    // Try to find a second CLIPTextEncode node (likely negative prompt)
    var foundNodes = [];
    for (var k in wf){
      var n=wf[k];
      if(n && n.class_type==="CLIPTextEncode" && n.inputs && n.inputs.hasOwnProperty("text")){
        foundNodes.push(k);
      }
    }
    // If we have multiple nodes and one is the positive, find the other
    if (foundNodes.length > 1){
      for (var i=0; i<foundNodes.length; i++){
        if (foundNodes[i] !== positiveNodeId) return foundNodes[i];
      }
    }
    return null;
  }
  
  function hasNegativePromptNode(wf){
    // Check if workflow has multiple CLIPTextEncode nodes
    var count = 0;
    for (var k in wf){
      var n=wf[k];
      if(n && n.class_type==="CLIPTextEncode" && n.inputs && n.inputs.hasOwnProperty("text")){
        count++;
        if (count > 1) return true;
      }
    }
    return false;
  }
  
  function injectNegativePrompt(wf, text, negNodeId){
    if (!negNodeId || !wf[negNodeId]) return false;
    wf[negNodeId].inputs.text = text;
    return true;
  }
  function setSamplerParams(wf, params){
    // find first Sampler-like node
    for (var k in wf){
      var n=wf[k]; if(!n || !n.inputs) continue;
      var ct=String(n.class_type||""); if(!/Sampler/i.test(ct)) continue;
      if (params.seed!=null && n.inputs.hasOwnProperty("seed")) n.inputs.seed = params.seed>>>0;
      if (params.steps!=null && n.inputs.hasOwnProperty("steps")) n.inputs.steps = params.steps|0;
      if (params.cfg!=null && n.inputs.hasOwnProperty("cfg")) n.inputs.cfg = Number(params.cfg);
      if (params.sampler && n.inputs.hasOwnProperty("sampler_name")) n.inputs.sampler_name = params.sampler;
      if (params.scheduler && n.inputs.hasOwnProperty("scheduler")) n.inputs.scheduler = params.scheduler;
      if (params.denoise!=null && n.inputs.hasOwnProperty("denoise")) n.inputs.denoise = Number(params.denoise);
      return k;
    }
    return null;
  }
  function applyDims(wf, w, h){
    var touched=[];
    for (var k in wf){
      var n=wf[k]; if(!n||!n.inputs) continue;
      if (n.inputs.hasOwnProperty("width") && n.inputs.hasOwnProperty("height")){
        n.inputs.width=w; n.inputs.height=h; touched.push(k);
      }
    }
    return touched;
  }
  function basename(p){ return String(p).replace(/^[\\\/]+/,"").split(/[\\\/]/).pop(); }
  function extOK(path){ return /\.(png|jpg|jpeg|webp|bmp)$/i.test(path); }

  // Set LoadImage node's filename (uses uploaded filename from API)
  function setLoadImage(wf, uploadedFilename){
    var set=false;
    for (var k in wf){
      var n=wf[k]; if(!n||!n.inputs) continue;
      if (String(n.class_type||"").match(/LoadImage/i) && n.inputs.hasOwnProperty("image")){
        n.inputs.image = uploadedFilename;
        set=true; break;
      }
    }
    if (!set) die("No LoadImage node found in the workflow.");
    return uploadedFilename;
  }

  // ====== UI ======
  var win = (thisObj instanceof Panel) ? thisObj : new Window("palette", "Comfy I2I Panel", undefined, {resizeable:true});
  win.alignChildren = ["fill","top"];

  // Add panel event handlers for auto-refresh
  win.onActivate = function() {
    if (typeof refreshLayerList === 'function') {
      refreshLayerList();
    }
  };

  // Load saved settings
  var savedSettings = loadSettings();

  // Connection settings
  var connPanel = win.add("panel", undefined, "ComfyUI Connection");
  connPanel.alignChildren = ["fill","top"];
  var connRow = connPanel.add("group"); connRow.orientation="row";
  connRow.add("statictext", undefined, "Host:");
  var hostEdit = connRow.add("edittext", undefined, savedSettings.host); hostEdit.characters = 15;
  connRow.add("statictext", undefined, "Port:");
  var portEdit = connRow.add("edittext", undefined, savedSettings.port); portEdit.characters = 6;

  // Workflow picker
  var wfGrp = win.add("group"); wfGrp.orientation="row"; wfGrp.add("statictext", undefined, "Workflow:");
  var wfPath = wfGrp.add("edittext", undefined, savedSettings.workflow); wfPath.characters = 40; wfPath.enabled=false;
  var wfBtn = wfGrp.add("button", undefined, "Choose…");

  // Prompt + Denoise
  var promptPanel = win.add("panel", undefined, "Prompt & Denoise");
  promptPanel.alignChildren = ["fill","top"];
  promptPanel.add("statictext", undefined, "Positive Prompt:");
  var prompt = promptPanel.add("edittext", undefined, "", {multiline:true, wantReturn:true});
  prompt.preferredSize = [undefined, 60];
  
  promptPanel.add("statictext", undefined, "Negative Prompt:");
  var negPrompt = promptPanel.add("edittext", undefined, "(worst quality, low quality:1.4), (bad anatomy), text, error, missing fingers, extra digit, fewer digits, cropped, jpeg artifacts, signature, watermark, username, blurry, deformed face", {multiline:true, wantReturn:true});
  negPrompt.preferredSize = [undefined, 40];
  negPrompt.enabled = false; // Disabled by default until workflow is loaded

  var denGrp = promptPanel.add("group"); denGrp.orientation="row";
  var denLbl = denGrp.add("statictext", undefined, "Denoise:");
  var denSlider = denGrp.add("slider", undefined, 0.5, 0.0, 1.0); denSlider.preferredSize=[200, undefined];
  var denVal = denGrp.add("edittext", undefined, "0.50"); denVal.characters=6;

  // Sampling
  var sampPanel = win.add("panel", undefined, "Sampling");
  sampPanel.alignChildren = ["fill","top"];
  var rowS1 = sampPanel.add("group"); rowS1.orientation="row";
  var ddSampler = rowS1.add("dropdownlist", undefined, ["euler","euler_a","dpmpp_2m","dpmpp_sde","lcm"]);
  ddSampler.selection = 0;
  var ddScheduler = rowS1.add("dropdownlist", undefined, ["none","karras","exponential","sgm_uniform"]); ddScheduler.selection=0;

  var rowS2 = sampPanel.add("group"); rowS2.orientation="row";
  rowS2.add("statictext", undefined, "Steps:");
  var stepsSlider = rowS2.add("slider", undefined, 30, 1, 80); stepsSlider.preferredSize=[200, undefined];
  var stepsVal = rowS2.add("edittext", undefined, "30"); stepsVal.characters=4;

  var rowS3 = sampPanel.add("group"); rowS3.orientation="row";
  rowS3.add("statictext", undefined, "CFG:");
  var cfgSlider = rowS3.add("slider", undefined, 7.0, 1.0, 20.0); cfgSlider.preferredSize=[200, undefined];
  var cfgVal = rowS3.add("edittext", undefined, "7.0"); cfgVal.characters=4;

  // Size
  var sizePanel = win.add("panel", undefined, "Size");
  sizePanel.alignChildren = ["left","top"];
  var useComp = sizePanel.add("checkbox", undefined, "Use comp size"); useComp.value=true;
  var sizeRow = sizePanel.add("group"); sizeRow.orientation="row";
  var wEdit = sizeRow.add("edittext", undefined, "0"); wEdit.characters=5;
  sizeRow.add("statictext", undefined, "×");
  var hEdit = sizeRow.add("edittext", undefined, "0"); hEdit.characters=5;
  sizeRow.add("statictext", undefined, " Snap:");
  var snapDD = sizeRow.add("dropdownlist", undefined, ["1","8","64"]); snapDD.selection=2;
  sizeRow.add("statictext", undefined, " MaxW:");
  var maxWEdit = sizeRow.add("edittext", undefined, String(DEFAULT_MAXW)); maxWEdit.characters=5;
  sizeRow.add("statictext", undefined, " MaxH:");
  var maxHEdit = sizeRow.add("edittext", undefined, String(DEFAULT_MAXH)); maxHEdit.characters=5;

  // Seed
  var seedPanel = win.add("panel", undefined, "Seed");
  seedPanel.alignChildren = ["left","top"];
  var seedRow1 = seedPanel.add("group"); seedRow1.orientation="row";
  var rbFixed  = seedRow1.add("radiobutton", undefined, "Fixed"); rbFixed.value=true;
  var rbRandom = seedRow1.add("radiobutton", undefined, "Random per run");
  var seedRow2 = seedPanel.add("group"); seedRow2.orientation="row";
  seedRow2.add("statictext", undefined, "Seed:");
  var seedEdit = seedRow2.add("edittext", undefined, String((Math.floor(Math.random()*0xFFFFFFFF))>>>0)); seedEdit.characters=12;
  
  // Variations row (only visible when Fixed is selected)
  var variationsRow = seedPanel.add("group"); variationsRow.orientation="row";
  variationsRow.add("statictext", undefined, "Variations:");
  var variationsSlider = variationsRow.add("slider", undefined, 1, 1, 10);
  variationsSlider.preferredSize = [150, undefined];
  var variationsVal = variationsRow.add("edittext", undefined, "1");
  variationsVal.characters = 3;
  variationsRow.visible = false; // Hidden by default
  
  // Denoise Increment row (only visible when Fixed seed AND variations > 1)
  var denoiseIncrementRow = seedPanel.add("group"); denoiseIncrementRow.orientation="row";
  denoiseIncrementRow.add("statictext", undefined, "Denoise Increment:");
  var denoiseIncrementEdit = denoiseIncrementRow.add("edittext", undefined, "-0.10");
  denoiseIncrementEdit.characters = 6;
  denoiseIncrementEdit.helpTip = "Amount to add to denoise for each variation (can be negative)";
  denoiseIncrementRow.visible = false; // Hidden by default

  // Source - dropdown of image layers
  var srcPanel = win.add("panel", undefined, "Source Image");
  srcPanel.alignChildren = ["fill","top"];
  
  // Render with effects checkbox (above layer dropdown)
  var useEffectsRow = srcPanel.add("group"); useEffectsRow.orientation="row";
  var useEffects = useEffectsRow.add("checkbox", undefined, "Render with effects/transforms");
  useEffects.value = false;
  useEffects.helpTip = "When checked, renders the entire comp as it appears (with all effects, transforms, masks).\nWhen unchecked, uses the raw source file from the selected layer.";
  
  // Layer selection row
  var srcRow = srcPanel.add("group"); srcRow.orientation="row";
  srcRow.add("statictext", undefined, "Layer:");
  var layerDropdown = srcRow.add("dropdownlist", undefined, ["(no image layers)"]); 
  layerDropdown.preferredSize = [250, undefined];
  layerDropdown.selection = 0;
  var refreshLayersBtn = srcRow.add("button", undefined, "Refresh");
  refreshLayersBtn.preferredSize = [60, undefined];
  refreshLayersBtn.helpTip = "Refresh the list of image layers from the current composition";

  // Output Folder
  var outputPanel = win.add("panel", undefined, "Output Folder");
  outputPanel.alignChildren = ["fill","top"];
  
  var folderRow = outputPanel.add("group"); 
  folderRow.orientation = "row";
  folderRow.alignment = ["fill", "top"];
  folderRow.add("statictext", undefined, "Folder:");
  var outputFolderPath = folderRow.add("edittext", undefined, savedSettings.outputFolder || ""); 
  outputFolderPath.preferredSize.width = 200;
  var chooseFolderBtn = folderRow.add("button", undefined, "Choose...");
  chooseFolderBtn.preferredSize.width = 70;

  // Footer
  var foot = win.add("group"); foot.orientation="row"; foot.alignment=["fill","bottom"];
  var addToComp = foot.add("checkbox", undefined, "Add to comp"); addToComp.value = true;
  foot.add("statictext", undefined, " ");
  var genBtn = foot.add("button", undefined, "Generate", {name:"ok"});
  var cancelBtn = foot.add("button", undefined, "Cancel"); cancelBtn.enabled=false;
  var logBtn = foot.add("button", undefined, "View Log");
  logBtn.preferredSize = [70, undefined];
  logBtn.helpTip = "Open the log file to see detailed information";
  var statusTxt = foot.add("statictext", undefined, "Idle"); statusTxt.alignment=["right","center"];

  // ====== UI wiring ======
  function uInt(v, def){ var n=parseInt(String(v),10); return isFinite(n)?n:def; }
  function uNum(v, def){ var n=parseFloat(String(v)); return isFinite(n)?n:def; }
  function rand32(){ return (Math.floor(Math.random()*0xFFFFFFFF))>>>0; }
  function refreshCompDims(){
    try {
      var comp = activeComp();
      if (!comp) {
        wEdit.text = "0";
        hEdit.text = "0";
        return;
      }
      
      // Get snap value
      var snapVal = parseInt(snapDD.selection.text, 10);
      if (!isFinite(snapVal) || snapVal < 1) snapVal = 8;
      
      // Get max dimensions
      var maxW = uInt(maxWEdit.text, DEFAULT_MAXW);
      var maxH = uInt(maxHEdit.text, DEFAULT_MAXH);
      
      // Calculate dimensions
      var dims = getCompDims(comp, snapVal, maxW, maxH);
      
      // Update UI
      wEdit.text = String(dims.w);
      hEdit.text = String(dims.h);
      
      log("Refreshed comp dims: " + dims.w + "x" + dims.h + " (comp: " + comp.width + "x" + comp.height + ")");
    } catch(e) {
      log("Error refreshing comp dims: " + e.toString());
    }
  }
  
  function refreshLayerList(){
    // Clear dropdown
    layerDropdown.removeAll();
    
    var comp = activeComp();
    if (!comp) {
      layerDropdown.add("item", "(no active comp)");
      layerDropdown.selection = 0;
      setGenEnabled();
      return;
    }
    
    var imageLayers = [];
    for (var i = 1; i <= comp.numLayers; i++) {
      var layer = comp.layer(i);
      if (layer instanceof AVLayer && layer.source instanceof FootageItem && 
          layer.source.mainSource && layer.source.mainSource.file) {
        var fname = layer.source.mainSource.file.name;
        if (extOK(fname)) {
          imageLayers.push({
            layer: layer,
            displayName: layer.name + "  [" + fname + "]"
          });
        }
      }
    }
    
    if (imageLayers.length === 0) {
      layerDropdown.add("item", "(no image layers)");
      layerDropdown.selection = 0;
      setGenEnabled();
      return;
    }
    
    // Add layers to dropdown
    for (var i = 0; i < imageLayers.length; i++) {
      var item = layerDropdown.add("item", imageLayers[i].displayName);
      item.layerRef = imageLayers[i].layer;
    }
    
    // Select first by default, or try to select currently selected layer
    layerDropdown.selection = 0;
    if (comp.selectedLayers.length === 1) {
      var selLayer = comp.selectedLayers[0];
      for (var i = 0; i < layerDropdown.items.length; i++) {
        if (layerDropdown.items[i].layerRef === selLayer) {
          layerDropdown.selection = i;
          break;
        }
      }
    }
    
    setGenEnabled();
  }
  
  function getSelectedLayer(){
    if (!layerDropdown.selection || !layerDropdown.selection.layerRef) return null;
    return layerDropdown.selection.layerRef;
  }
  
  function setGenEnabled(){
    var ok = (wfPath.text && wfPath.text.length>0);
    if (ok){
      ok = ok && (hostEdit.text.replace(/\s+/g,"").length>0);
      ok = ok && (portEdit.text.replace(/\s+/g,"").length>0);
      ok = ok && (prompt.text.replace(/\s+/g,"").length>0);
      var comp = activeComp(); ok = ok && !!comp;
      var layer = getSelectedLayer();
      ok = ok && !!layer;
    }
    genBtn.enabled = ok;
  }
  function seedRefresh(){ 
    seedEdit.enabled = rbFixed.value; 
    
    // Always show variations row regardless of seed mode
    variationsRow.visible = true;
    
    // Show denoise increment only if Fixed seed AND variations > 1
    // With random seed, each variation gets a different random seed
    var showIncrement = rbFixed.value && (parseInt(variationsVal.text, 10) > 1);
    denoiseIncrementRow.visible = showIncrement;
    
    win.layout.layout(true); // Force panel to recalculate layout
  }
  function variationsSyncFromSlider(){ 
    variationsVal.text = String(Math.round(variationsSlider.value)); 
    seedRefresh(); // Update visibility of denoise increment
  }
  function variationsSyncFromEdit(){ 
    var v = Math.max(1, Math.min(10, uInt(variationsVal.text, 1))); 
    variationsSlider.value = v; 
    variationsVal.text = String(v); 
    seedRefresh(); // Update visibility of denoise increment
  }
  function denSyncFromSlider(){ denVal.text = String( (Math.round(denSlider.value*100)/100).toFixed(2) ); }
  function denSyncFromEdit(){ var v = Math.max(0, Math.min(1, uNum(denVal.text, 0.5))); denSlider.value = v; denVal.text = v.toFixed(2); }
  function stepsSyncFromSlider(){ stepsVal.text = String( Math.round(stepsSlider.value) ); }
  function stepsSyncFromEdit(){ var v = Math.max(1, Math.min(80, uInt(stepsVal.text, 30))); stepsSlider.value = v; stepsVal.text = String(v); }
  function cfgSyncFromSlider(){ cfgVal.text = String( (Math.round(cfgSlider.value*10)/10).toFixed(1) ); }
  function cfgSyncFromEdit(){ var v = Math.max(1, Math.min(20, uNum(cfgVal.text, 7))); cfgSlider.value = v; cfgVal.text = v.toFixed(1); }

  // initial states
  refreshCompDims(); refreshLayerList(); seedRefresh(); denSyncFromSlider(); stepsSyncFromSlider(); cfgSyncFromSlider(); setGenEnabled();

  // events
  hostEdit.onChanging = portEdit.onChanging = setGenEnabled;
  wfBtn.onClick = function(){
    var f = File.openDialog("Select Comfy API workflow JSON"); if (!f) return;
    wfPath.text = f.fsName; 
    
    // Check workflow for negative prompt support
    var wfFile = new File(f.fsName);
    try {
      if (wfFile.exists && wfFile.open("r")) {
        var wfText = wfFile.read();
        var workflow = JSON.parse(wfText);
        
        // Check if workflow has negative prompt node
        if (hasNegativePromptNode(workflow)) {
          negPrompt.enabled = true;
          log("Workflow has negative prompt support - enabled");
        } else {
          negPrompt.enabled = false;
          // Keep default text even when disabled
          log("Workflow has no negative prompt support - disabled");
        }
      }
    } catch(e) {
      log("Error checking workflow for negative prompt: " + e);
      negPrompt.enabled = false;
    } finally {
      try { wfFile.close(); } catch(e) {}
    }
    
    setGenEnabled();
  };
  prompt.onChanging = setGenEnabled;
  negPrompt.onChanging = setGenEnabled;
  useComp.onClick = function(){ 
    var en = !useComp.value; 
    wEdit.enabled=en; 
    hEdit.enabled=en; 
    snapDD.enabled=en; 
    maxWEdit.enabled=en; 
    maxHEdit.enabled=en; 
    if (useComp.value) refreshCompDims(); 
    setGenEnabled(); 
  };
  wEdit.onChanging = hEdit.onChanging = setGenEnabled;
  
  // Update dimensions when max values change (if using comp size)
  maxWEdit.onChanging = function() {
    if (useComp.value) refreshCompDims();
    setGenEnabled();
  };
  maxHEdit.onChanging = function() {
    if (useComp.value) refreshCompDims();
    setGenEnabled();
  };
  
  snapDD.onChange = function(){ 
    if (useComp.value) refreshCompDims(); 
    setGenEnabled(); 
  };

  denSlider.onChanging = denSyncFromSlider; denVal.onChange = function(){ denSyncFromEdit(); setGenEnabled(); };
  stepsSlider.onChanging = stepsSyncFromSlider; stepsVal.onChange = function(){ stepsSyncFromEdit(); setGenEnabled(); };
  cfgSlider.onChanging = cfgSyncFromSlider; cfgVal.onChange = function(){ cfgSyncFromEdit(); setGenEnabled(); };

  rbFixed.onClick = rbRandom.onClick = function(){ seedRefresh(); setGenEnabled(); };
  seedEdit.onChanging = setGenEnabled;
  
  variationsSlider.onChanging = variationsSyncFromSlider;
  variationsVal.onChange = function(){ variationsSyncFromEdit(); setGenEnabled(); };

  // Layer dropdown and refresh button
  layerDropdown.onChange = setGenEnabled;
  refreshLayersBtn.onClick = function(){ 
    refreshLayerList(); 
    // Update the last known comp after manual refresh
    lastActiveComp = activeComp() ? activeComp().id : null;
  };
  
  // Handle render with effects checkbox
  useEffects.onClick = function() {
    // Disable layer dropdown when rendering with effects
    layerDropdown.enabled = !useEffects.value;
    refreshLayersBtn.enabled = !useEffects.value;
    setGenEnabled();
  };
  
  // Output folder controls
  function updateOutputFolderDisplay(){
    // Only update if no custom folder is set
    if (!outputFolderPath.text || outputFolderPath.text.length === 0) {
      var projectFile = app.project.file;
      if (projectFile && projectFile.exists) {
        outputFolderPath.text = projectFile.parent.fsName;
        log("Output folder set to project folder: " + outputFolderPath.text);
      } else {
        outputFolderPath.text = Folder.temp.fsName;
        log("Output folder set to temp folder: " + outputFolderPath.text);
      }
    }
  }
  
  // Output folder button
  chooseFolderBtn.onClick = function(){
    var folder = Folder.selectDialog("Choose output folder for generated images");
    if (folder) {
      outputFolderPath.text = folder.fsName;
      log("Output folder selected: " + folder.fsName);
    }
  };
  
  // Initialize folder path from saved settings, or show default
  if (savedSettings.outputFolder && savedSettings.outputFolder.length > 0) {
    outputFolderPath.text = savedSettings.outputFolder;
  } else {
    updateOutputFolderDisplay();
  }

  // Store globally so event callback can access
  $._comfyPanel_refreshSelLabel = refreshLayerList;
  $._comfyPanel_updateOutputFolder = updateOutputFolderDisplay;
  $._comfyPanel_win = win;

  // Set up composition monitoring
  var lastActiveComp = null;
  var lastCompSize = null;
  var checkCompTimer = null;
  var panelClosed = false;

  function startCompMonitoring() {
    if (panelClosed) return;
    if (checkCompTimer) app.cancelTask(checkCompTimer);
    checkCompTimer = app.scheduleTask("$._comfyI2IPanel.checkActiveComp()", 1000, true);
  }

  function stopCompMonitoring() {
    panelClosed = true;
    if (checkCompTimer) {
      try {
        app.cancelTask(checkCompTimer);
      } catch(e) {
        // Ignore errors when canceling
      }
      checkCompTimer = null;
    }
  }

  function checkActiveComp() {
    try {
      var currentComp = activeComp();
      var currentCompId = currentComp ? currentComp.id : null;
      var currentSize = currentComp ? (currentComp.width + "x" + currentComp.height) : null;
      
      // Check if composition changed
      if (currentCompId !== lastActiveComp) {
        lastActiveComp = currentCompId;
        lastCompSize = currentSize;
        if (typeof refreshLayerList === 'function') {
          refreshLayerList();
        }
        // Refresh dimensions if using comp size
        if (useComp && useComp.value && typeof refreshCompDims === 'function') {
          refreshCompDims();
        }
        // Update output folder display if no custom folder is set
        if (typeof updateOutputFolderDisplay === 'function') {
          updateOutputFolderDisplay();
        }
      }
      // Check if composition size changed
      else if (currentSize !== lastCompSize && currentSize !== null) {
        lastCompSize = currentSize;
        // Refresh dimensions if using comp size
        if (useComp && useComp.value && typeof refreshCompDims === 'function') {
          refreshCompDims();
        }
      }
    } catch(e) {
      // Ignore errors during monitoring
    }
  }

  // Global function for scheduled task using unique namespace
  $._comfyI2IPanel.checkActiveComp = function() {
    // Don't run if panel is closed
    if (panelClosed || !checkCompTimer) return;
    
    try {
      // Check if we're in a modal state - bail out if so
      if (app.isWatchFolder) return;
      
      var currentComp = app.project.activeItem;
      if (!currentComp || !(currentComp instanceof CompItem)) return;
      
      var currentCompId = currentComp.id;
      var currentSize = currentComp.width + "x" + currentComp.height;
      
      // Check if window still exists and is visible
      if (!win || !win.visible) return;
      
      // Check if composition changed
      if (currentCompId !== lastActiveComp) {
        lastActiveComp = currentCompId;
        lastCompSize = currentSize;
        
        // Only refresh if functions exist
        if (typeof refreshLayerList === 'function') {
          try {
            refreshLayerList();
          } catch(e) {
            // Ignore refresh errors
          }
        }
        
        // Refresh dimensions if using comp size
        if (useComp && useComp.value && typeof refreshCompDims === 'function') {
          try {
            refreshCompDims();
          } catch(e) {
            // Ignore refresh errors
          }
        }
      }
      // Check if composition size changed
      else if (currentSize !== lastCompSize) {
        lastCompSize = currentSize;
        
        // Refresh dimensions if using comp size
        if (useComp && useComp.value && typeof refreshCompDims === 'function') {
          try {
            refreshCompDims();
          } catch(e) {
            // Ignore refresh errors
          }
        }
      }
    } catch(e) {
      // Silently ignore ALL errors to prevent modal dialogs
    }
  };

  // Start monitoring when panel loads
  startCompMonitoring();
  lastActiveComp = activeComp() ? activeComp().id : null;

  // Add cleanup on panel close
  win.onClose = function() {
    stopCompMonitoring();
    return true;
  };

  // show / layout
  if (win instanceof Window) { 
    win.center(); 
    win.show();
  } else { 
    win.layout.layout(true); 
  }

  // ====== RUN LOGIC ======
  var baseWorkflow = null;
  var stopRequested = false;

  genBtn.onClick = function(){
    try{
      // Get host/port from UI and validate
      var host = hostEdit.text.replace(/\s+/g, "");
      var port = portEdit.text.replace(/\s+/g, "");
      
      var hostError = validateHost(host);
      if (hostError) die(hostError);
      
      var portError = validatePort(port);
      if (portError) die(portError);

      if (!wfPath.text) die("Please choose a workflow JSON first.");
      var wfFile = new File(wfPath.text); 
      if(!wfFile.exists) die("Workflow file not found: " + wfPath.text);
      
      // Read workflow with proper file handle management
      var wfText = null;
      try {
        if (wfFile.open("r")) {
          wfText = wfFile.read();
        } else {
          die("Could not open workflow file.");
        }
      } finally {
        try { wfFile.close(); } catch(e) {}
      }
      
      try { baseWorkflow = JSON.parse(wfText); } catch(e){ die("Workflow JSON parse error (API export required).", e); }

      // Gather UI and sanitize inputs
      var promptStr = sanitizePrompt(prompt.text);
      var negPromptStr = sanitizePrompt(negPrompt.text);
      
      if (!promptStr || promptStr === "") die("Prompt cannot be empty.");
      
      var denoise = uNum(denVal.text, 0.5);
      var steps   = uInt(stepsVal.text, 30);
      var cfg     = uNum(cfgVal.text, 7.0);
      var sampler = ddSampler.selection ? ddSampler.selection.text : "euler";
      var scheduler = ddScheduler.selection ? ddScheduler.selection.text : "none";
      var baseSeed = rbFixed.value ? uInt(seedEdit.text, (Math.floor(Math.random()*0xFFFFFFFF))>>>0) : null;
      var numVariations = uInt(variationsVal.text, 1); // Always use variations value
      var denoiseIncrement = parseFloat(denoiseIncrementEdit.text) || 0.0;
      
      log("Seed mode: " + (rbFixed.value ? "Fixed" : "Random") + ", Base denoise: " + denoise + ", increment: " + denoiseIncrement + ", variations: " + numVariations);

      var comp = activeComp(); if(!comp) die("No active comp.");
      var snapDiv = parseInt(snapDD.selection.text,10);
      var dims = useComp.value ? getCompDims(comp, snapDiv, uInt(maxWEdit.text, DEFAULT_MAXW), uInt(maxHEdit.text, DEFAULT_MAXH))
                               : { w: uInt(wEdit.text, comp.width), h: uInt(hEdit.text, comp.height) };

      // Source image - get from dropdown
      var selectedLayer = getSelectedLayer();
      if (!selectedLayer) die("Please select a layer from the dropdown.");
      var refLayer = selectedLayer;
      
      var srcPath = null;
      var tempFile = null;
      
      // Check if we should render with effects or use raw source
      if (useEffects.value) {
        // Render layer as it appears in comp
        log("=== RENDER WITH EFFECTS/TRANSFORMS MODE ===");
        statusTxt.text = "Rendering layer…";
        
        // Use project folder instead of temp folder
        var projectFile = app.project.file;
        var outputFolder;
        
        if (projectFile && projectFile.exists) {
          outputFolder = projectFile.parent;
          log("Using project folder: " + outputFolder.fsName);
        } else {
          outputFolder = Folder.temp;
          log("Project not saved, using temp folder: " + outputFolder.fsName);
        }
        
        tempFile = new File(outputFolder.fsName + "/comfy_source_" + new Date().getTime() + ".png");
        log("Temp file will be: " + tempFile.fsName);
        
        try {
          log("Calling renderLayerToFile...");
          renderLayerToFile(selectedLayer, comp, tempFile);
          srcPath = tempFile.fsName;
          log("Using rendered layer with effects: " + srcPath);
        } catch(e) {
          log("FATAL ERROR during render: " + e.toString());
          log("Error message: " + e.message);
          die("Failed to render layer: " + e.message);
        }
      } else {
        // Use raw source file
        if (!(selectedLayer.source instanceof FootageItem) || !(selectedLayer.source.mainSource && selectedLayer.source.mainSource.file))
          die("Selected layer isn't a still image footage. Enable 'Render with effects/transforms' to use any layer type.");
        srcPath = selectedLayer.source.mainSource.file.fsName;
        if (!extOK(srcPath)) die("Selected layer source is not a PNG/JPG/WEBP/BMP.");
        log("Using raw source file: " + srcPath);
      }

      // Save project before generation
      if (app.project.file && app.project.dirty) {
        statusTxt.text = "Saving project…";
        log("Saving project before generation...");
        app.project.save();
        log("Project saved: " + app.project.file.fsName);
      } else if (!app.project.file) {
        log("Project not saved to disk yet - skipping auto-save");
      } else {
        log("Project has no unsaved changes - skipping save");
      }
      
      // UI state
      stopRequested = false;
      
      // Stop composition monitoring during generation to avoid conflicts
      stopCompMonitoring();
      
      setEnabled(false);
      
      log("START gen | host="+host+":"+port+" | prompt='"+promptStr+"' | src="+srcPath + " | variations="+numVariations);
      
      // Upload image once (reuse for all variations)
      statusTxt.text = "Uploading image…";
      log("Uploading source image to ComfyUI...");
      var uploadedFilename = httpUploadImage(srcPath, host, port);
      log("Upload complete: " + uploadedFilename);
      
      var generatedFiles = [];
      var successCount = 0;
      var failCount = 0;
      
      // Loop through variations
      for (var varIdx = 0; varIdx < numVariations; varIdx++) {
        if (stopRequested) {
          log("Canceled by user at variation " + (varIdx + 1));
          statusTxt.text = "Cancelled";
          break;
        }
        
        statusTxt.text = "Generating " + (varIdx + 1) + "/" + numVariations + "…";
        log("--- Variation " + (varIdx + 1) + "/" + numVariations + " ---");
        
        try {
          // Calculate denoise for this variation (only applies when Fixed seed + variations > 1)
          var currentDenoise = denoise + (denoiseIncrement * varIdx);
          if (rbFixed.value && numVariations > 1) {
            log("Variation " + (varIdx + 1) + " denoise: " + currentDenoise + " (base: " + denoise + " + increment: " + denoiseIncrement + " × " + varIdx + ")");
          } else {
            log("Variation " + (varIdx + 1) + " denoise: " + currentDenoise);
          }
          
          // Build workflow for this variation
          statusTxt.text = "Preparing workflow " + (varIdx + 1) + "/" + numVariations + "…";
          var wf = deepCopy(baseWorkflow);
          var posNodeId = injectPrompt(wf, promptStr, null);
          
          // Try to inject negative prompt if node exists
          var negNodeId = findNegativePromptNode(wf, posNodeId);
          if (negNodeId && negPrompt.enabled) {
            injectNegativePrompt(wf, negPromptStr, negNodeId);
          }
          
          applyDims(wf, dims.w, dims.h);
          
          // Seed generation logic:
          // If Fixed seed: use same seed for all variations
          // If Random: generate new random seed for each variation
          var currentSeed;
          if (baseSeed != null) {
            currentSeed = baseSeed; // Fixed seed - same for all variations
            log("Using fixed seed: " + currentSeed);
          } else {
            currentSeed = rand32(); // Random seed - new for each variation
            log("Using random seed: " + currentSeed + " (variation " + (varIdx + 1) + ")");
          }
          
          setSamplerParams(wf, {
            seed: currentSeed,
            steps: steps, cfg: cfg, sampler: sampler,
            scheduler: (scheduler==="none"? null : scheduler),
            denoise: currentDenoise  // Use calculated denoise for this variation
          });
          setLoadImage(wf, uploadedFilename);

          // POST /prompt
          statusTxt.text = "Submitting " + (varIdx + 1) + "/" + numVariations + "…";
          var post = httpPostJSONPrompt(wf, host, port);
          if (!post || !post.prompt_id) die("Unexpected /prompt response.", JSON.stringify(post));
          var pid = post.prompt_id;
          log("Prompt ID: " + pid);

          // Poll history
          statusTxt.text = "Processing " + (varIdx + 1) + "/" + numVariations + "…";
          var fileInfo=null, started=new Date().getTime();
          while(true){
            if (stopRequested) throw new Error("Canceled by user");
            if (new Date().getTime()-started > TIMEOUT_MS) die("Timed out waiting for result.");
            var hist = httpHistoryMaybe(pid, host, port);
            if (hist){
              var rec=hist[pid];
              if (rec && rec.outputs){
                for (var k in rec.outputs){
                  var out = rec.outputs[k];
                  if (out && out.images && out.images.length>0){ fileInfo = out.images[0]; break; }
                }
                if (fileInfo) break;
              }
            }
            sleep(POLL_MS);
          }
          log("Got image: "+(fileInfo.filename||"?"));

          statusTxt.text = "Downloading " + (varIdx + 1) + "/" + numVariations + "…";

          // Determine output folder based on settings priority:
          // 1. Custom folder (if enabled and exists)
          // 2. Project folder (if project is saved)
          // 3. Temp folder (fallback)
          var outputFolder = Folder.temp;
          var projectFile = app.project.file;
          
          // Determine output folder based on settings priority:
          // 1. Custom folder (if set and exists)
          // 2. Project folder (if project is saved) - DEFAULT
          // 3. Temp folder (fallback)
          var outputFolder = Folder.temp;
          var projectFile = app.project.file;
          
          if (outputFolderPath.text && outputFolderPath.text.length > 0) {
            // Try to use custom folder if set
            var customFolder = new Folder(outputFolderPath.text);
            if (customFolder.exists) {
              outputFolder = customFolder;
              log("Using custom output folder: " + outputFolder.fsName);
            } else {
              log("Custom folder doesn't exist, falling back to project/temp folder");
              if (projectFile && projectFile.exists) {
                outputFolder = projectFile.parent;
                log("Using project folder: " + outputFolder.fsName);
              } else {
                log("Project not saved - using temp folder: " + outputFolder.fsName);
              }
            }
          } else if (projectFile && projectFile.exists) {
            // Use project folder if available (DEFAULT)
            outputFolder = projectFile.parent;
            log("Using project folder for output: " + outputFolder.fsName);
          } else {
            // Fall back to temp folder
            log("Project not saved - using temp folder: " + outputFolder.fsName);
          }

          // Download
          var q = "/view?filename=" + encodeURIComponent(fileInfo.filename) +
                  "&subfolder=" + encodeURIComponent(fileInfo.subfolder || "") +
                  "&type=" + encodeURIComponent(fileInfo.type || "output");
          var outFile = new File(outputFolder.fsName + "/comfy_" + pid + "_" + fileInfo.filename);
          httpDownloadToFile(q, outFile, host, port);
          
          generatedFiles.push(outFile);
          successCount++;
          
        } catch(e) {
          failCount++;
          log("Variation " + (varIdx + 1) + " failed: " + e.message);
          statusTxt.text = "Error in variation " + (varIdx + 1);
        }
      }

      // Add all successful files to comp
      if (addToComp.value && generatedFiles.length > 0){
        statusTxt.text = "Importing " + generatedFiles.length + " file(s)…";
        log("Importing " + generatedFiles.length + " generated images to comp");
        app.beginUndoGroup("Comfy I2I Import (" + generatedFiles.length + " variations)");
        
        for (var i = 0; i < generatedFiles.length; i++) {
          var io = new ImportOptions(generatedFiles[i]);
          var footage = app.project.importFile(io);
          var L = comp.layers.add(footage);

          // match duration to reference image
          if (refLayer) setLayerInOutLike(L, refLayer, comp);
          else { L.startTime=0; L.inPoint=0; L.outPoint=Math.min(comp.duration, footage.duration || comp.duration); }
          fitLayerToComp(L, comp);
          try { if (refLayer) L.moveBefore(refLayer); } catch(_){}
        }
        
        app.endUndoGroup();
      }

      // Save settings after successful run (including custom output folder)
      saveSettings(host, port, wfPath.text, outputFolderPath.text);

      // Cleanup temp files
      statusTxt.text = "Cleaning up…";
      
      // Remove render temp file if it was created
      if (tempFile && tempFile.exists) {
        try { 
          tempFile.remove(); 
          log("Cleaned up render temp file: " + tempFile.name); 
        } catch(e) { 
          log("Could not remove render temp file: " + e); 
        }
      }
      
      // Optionally clean up downloaded files if not added to comp
      if (!addToComp.value && generatedFiles.length > 0) {
        log("Generated files not added to comp, cleaning up...");
        for (var i = 0; i < generatedFiles.length; i++) {
          try {
            if (generatedFiles[i].exists) {
              generatedFiles[i].remove();
              log("Removed: " + generatedFiles[i].name);
            }
          } catch(e) {
            log("Could not remove generated file: " + e);
          }
        }
      }
      
      // Clear the array
      generatedFiles = [];

      statusTxt.text = "Done";
      var resultMsg = "Generated " + successCount + " variation(s)";
      if (failCount > 0) resultMsg += " (" + failCount + " failed)";
      if (addToComp.value) resultMsg += "\nAdded to composition";
      log("DONE: " + resultMsg);
      alert(resultMsg);
      
    } catch(e){
      statusTxt.text = "Error";
      log("ERROR in generation: " + e.toString());
      alert("Error: " + e.message + "\n\nLog: " + LOG.fsName);
    } finally {
      // Re-enable UI and restart monitoring only if panel still exists
      if (win && win.visible) {
        setEnabled(true);
        startCompMonitoring();
      }
    }
  };

  cancelBtn.onClick = function(){
    stopRequested = true;
    statusTxt.text = "Canceling…";
  };
  
  logBtn.onClick = function(){
    if (LOG.exists) {
      LOG.execute();
    } else {
      alert("Log file does not exist yet.\nThe log will be created when you first run a generation.\n\nPath: " + LOG.fsName);
    }
  };

  function setEnabled(flag){
    var controls = [hostEdit, portEdit, wfBtn, prompt, denSlider, denVal, ddSampler, ddScheduler,
                    stepsSlider, stepsVal, cfgSlider, cfgVal,
                    useComp, wEdit, hEdit, snapDD, maxWEdit, maxHEdit,
                    rbFixed, rbRandom, seedEdit, variationsSlider, variationsVal, 
                    useEffects, addToComp, chooseFolderBtn];
    for (var i=0;i<controls.length;i++) {
      try { 
        if (controls[i]) controls[i].enabled = flag; 
      } catch(_){}
    }
    
    // Handle layer dropdown and refresh button separately - respect useEffects state
    if (flag) {
      layerDropdown.enabled = !useEffects.value;
      refreshLayersBtn.enabled = !useEffects.value;
    } else {
      layerDropdown.enabled = false;
      refreshLayersBtn.enabled = false;
    }
    
    // Handle negative prompt separately - only enable if workflow supports it
    if (flag) {
      // Check if workflow has negative prompt support
      try {
        if (baseWorkflow && hasNegativePromptNode(baseWorkflow)) {
          negPrompt.enabled = true;
        } else {
          negPrompt.enabled = false;
        }
      } catch(e) {
        negPrompt.enabled = false;
      }
    } else {
      negPrompt.enabled = false;
    }
    
    // For generate button, check if we should enable it based on validation
    if (flag) {
      setGenEnabled(); // Revalidate and set proper state
    } else {
      genBtn.enabled = false;
    }
    
    cancelBtn.enabled = !flag;
  }

})(this);