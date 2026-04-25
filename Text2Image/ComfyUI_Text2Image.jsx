/* ComfyUI Text2Image Panel -- Generate images from text layer prompts
   Pure ExtendScript (AE) + Socket HTTP; no external tools required. */

(function(thisObj) {
  // ================= USER SETTINGS =================
  var DEFAULT_HOST = "127.0.0.1";
  var DEFAULT_PORT = "8188";

  var POLL_MS = 1000;

  var DEFAULT_SNAP = 64;
  var DEFAULT_MAXW = 2048;
  var DEFAULT_MAXH = 2048;

  // Settings file for persistence
  var SETTINGS_FILE = new File(Folder.userData.fsName + "/ComfyText2Image_Settings.json");
  var WORKFLOW_CACHE_INDEX_FILE = new File(Folder.userData.fsName + "/ComfyText2Image_CacheIndex.json");
  var WORKFLOW_CACHE_DIR = Folder.userData.fsName;
  
  // Initialize unique namespace
  if (!$._comfyText2ImagePanel) {
    $._comfyText2ImagePanel = {};
  }

  // =================================================


  // ================= LOGGING =================
  var LOG = new File(Folder.temp.fsName + "/Comfy_Text2Image_Panel.log");
  
  function log(s){ 
    try{ 
      if (!LOG) return;
      LOG.open("a"); 
      LOG.writeln(new Date().toISOString() + "  " + s); 
      LOG.close(); 
    } catch(e) {} 
  }
  
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
      var settings = {
        host: host,
        port: port,
        workflow: workflow,
        outputFolder: outputFolder || ""
      };
      
      if (SETTINGS_FILE.open("w")) {
        SETTINGS_FILE.write(JSON.stringify(settings));
        log("Settings saved");
      }
    } catch(e) {
      log("Failed to save settings: " + e);
    } finally {
      try { SETTINGS_FILE.close(); } catch(e) {}
    }
  }

  // ====== Workflow cache functions ======
  // workflowIndex: lightweight { name: { path, timestamp } } -- loaded at startup
  // workflowCache: full data { name: { objectInfo, samplerInfo, ... } } -- loaded on demand
  var workflowIndex = {};
  var workflowCache = {};

  function sanitizeCacheName(name) {
    return String(name).replace(/[^a-zA-Z0-9_\-]/g, "_");
  }

  function workflowEntryFile(name) {
    return new File(WORKFLOW_CACHE_DIR + "/ComfyText2Image_Cache_" + sanitizeCacheName(name) + ".json");
  }

  function loadWorkflowIndex(){
    if (!WORKFLOW_CACHE_INDEX_FILE.exists) return {};
    try {
      if (WORKFLOW_CACHE_INDEX_FILE.open("r")) {
        var json = WORKFLOW_CACHE_INDEX_FILE.read();
        WORKFLOW_CACHE_INDEX_FILE.close();
        if (!json || json.length === 0) return {};
        var idx = JSON.parse(json);
        if (!idx || typeof idx !== "object") return {};
        var count = 0;
        for (var k in idx) { if (idx[k]) count++; }
        log("Loaded workflow index (" + count + " entries)");
        return idx;
      }
    } catch(e) {
      log("Failed to load workflow index: " + String(e));
    }
    return {};
  }

  function saveWorkflowIndex(){
    try {
      if (WORKFLOW_CACHE_INDEX_FILE.open("w")) {
        WORKFLOW_CACHE_INDEX_FILE.write(JSON.stringify(workflowIndex));
        WORKFLOW_CACHE_INDEX_FILE.close();
        log("Saved workflow index");
      }
    } catch(e) {
      log("Failed to save workflow index: " + e);
    }
  }

  function saveWorkflowEntry(name, data){
    try {
      var f = workflowEntryFile(name);
      if (f.open("w")) {
        f.write(JSON.stringify(data));
        f.close();
        log("Saved cache entry: " + name);
      }
    } catch(e) {
      log("Failed to save cache entry " + name + ": " + e);
    }
  }

  function loadWorkflowEntry(name){
    if (workflowCache[name]) return workflowCache[name];
    try {
      var f = workflowEntryFile(name);
      if (!f.exists) return null;
      if (f.open("r")) {
        var json = f.read();
        f.close();
        if (!json || json.length === 0) return null;
        var data = JSON.parse(json);
        if (data) {
          workflowCache[name] = data;
          log("Loaded cache entry from disk: " + name);
          return data;
        }
      }
    } catch(e) {
      log("Failed to load cache entry " + name + ": " + e);
    }
    return null;
  }

  function deleteWorkflowEntry(name){
    try {
      var f = workflowEntryFile(name);
      if (f.exists) f.remove();
    } catch(e) {
      log("Failed to delete cache entry " + name + ": " + e);
    }
  }

  function getWorkflowName(workflowPath) {
    if (!workflowPath) return null;
    var f = new File(workflowPath);
    var name = f.name.replace(/\.json$/i, "");
    return name;
  }

  function cacheWorkflowInfo(workflowPath, objectInfo, samplerInfo) {
    var name = getWorkflowName(workflowPath);
    if (!name) return;
    var ts = new Date().getTime();

    // Update lightweight index
    workflowIndex[name] = { path: workflowPath, timestamp: ts };
    saveWorkflowIndex();

    // Save heavy data to separate file
    var entry = {
      path: workflowPath,
      objectInfo: objectInfo,
      samplerInfo: samplerInfo,
      timestamp: ts
    };
    workflowCache[name] = entry;
    saveWorkflowEntry(name, entry);
    log("Cached workflow: " + name);
  }

  function getCachedWorkflowInfo(workflowPath) {
    var name = getWorkflowName(workflowPath);
    if (!name || !workflowIndex[name]) return null;

    // Check if workflow file has been modified since caching
    var idxEntry = workflowIndex[name];
    var wfFile = new File(workflowPath);
    if (wfFile.exists) {
      var fileModifiedTime = wfFile.modified.getTime();
      if (fileModifiedTime > idxEntry.timestamp) {
        log("Workflow modified since cache, invalidating: " + name);
        delete workflowIndex[name];
        delete workflowCache[name];
        deleteWorkflowEntry(name);
        saveWorkflowIndex();
        return null;
      }
    }

    // Lazy-load the full entry from disk
    var entry = loadWorkflowEntry(name);
    if (!entry) {
      // Entry file missing -- remove stale index
      delete workflowIndex[name];
      saveWorkflowIndex();
      return null;
    }
    log("Using cached info for workflow: " + name);
    return entry;
  }

  function updateWorkflowDropdown() {
    wfDropdown.removeAll();
    
    var names = [];
    for (var name in workflowIndex) {
      if (workflowIndex[name]) {
        names.push(name);
      }
    }
    
    names.sort();
    
    if (names.length === 0) {
      wfDropdown.add("item", "(No cached workflows)");
      wfDropdown.selection = 0;
      wfDropdown.enabled = false;
      clearCacheBtn.enabled = false;
      return;
    }
    
    wfDropdown.enabled = true;
    clearCacheBtn.enabled = true;
    
    for (var i = 0; i < names.length; i++) {
      wfDropdown.add("item", names[i]);
    }
    
    var currentName = getWorkflowName(wfPath.text);
    if (currentName) {
      for (var j = 0; j < wfDropdown.items.length; j++) {
        if (wfDropdown.items[j].text === currentName) {
          wfDropdown.selection = j;
          break;
        }
      }
    }
    
    if (!wfDropdown.selection && wfDropdown.items.length > 0) {
      wfDropdown.selection = 0;
    }
  }

  function updateWorkflowUI(workflowPath) {
    var hasWorkflow = !!(workflowPath && workflowPath.length > 0);
    var hasNeg = false;

    if (hasWorkflow) {
      try {
        var wfFile = new File(workflowPath);
        if (wfFile.exists && wfFile.open("r")) {
          var wfText = wfFile.read();
          wfFile.close();
          var workflow = JSON.parse(wfText);
          hasNeg = hasNegativePromptNode(workflow);
        }
      } catch(e) {
        log("Error reading workflow for UI update: " + e);
      }
    }

    sampPanel.visible = hasWorkflow;
    sizePanel.visible = hasWorkflow;
    seedPanel.visible = hasWorkflow;
    negPromptPanel.visible = hasNeg;
    negPrompt.enabled = hasNeg;

    setGenEnabled();
    win.layout.layout(true);
  }

  function applyCachedWorkflowSettings(cachedInfo) {
    if (!cachedInfo || !cachedInfo.samplerInfo) return false;
    
    var samplerInfo = cachedInfo.samplerInfo;
    
    try {
      if (samplerInfo.samplers && samplerInfo.samplers.length > 0) {
        ddSampler.removeAll();
        var currentSamplerIndex = 0;
        for (var i = 0; i < samplerInfo.samplers.length; i++) {
          ddSampler.add("item", samplerInfo.samplers[i]);
          if (samplerInfo.currentValues && samplerInfo.currentValues.sampler_name === samplerInfo.samplers[i]) {
            currentSamplerIndex = i;
          }
        }
        ddSampler.selection = currentSamplerIndex;
      }
      
      if (samplerInfo.schedulers && samplerInfo.schedulers.length > 0) {
        ddScheduler.removeAll();
        var currentSchedulerIndex = 0;
        for (var i = 0; i < samplerInfo.schedulers.length; i++) {
          ddScheduler.add("item", samplerInfo.schedulers[i]);
          if (samplerInfo.currentValues && samplerInfo.currentValues.scheduler === samplerInfo.schedulers[i]) {
            currentSchedulerIndex = i;
          }
        }
        ddScheduler.selection = currentSchedulerIndex;
      }
      
      if (samplerInfo.stepsRange) {
        // Expand range first to avoid out-of-range errors during transition
        stepsSlider.minvalue = Math.min(stepsSlider.minvalue, samplerInfo.stepsRange.min);
        stepsSlider.maxvalue = Math.max(stepsSlider.maxvalue, samplerInfo.stepsRange.max);
        stepsSlider.minvalue = samplerInfo.stepsRange.min;
        stepsSlider.maxvalue = samplerInfo.stepsRange.max;
        var currentSteps = (samplerInfo.currentValues && samplerInfo.currentValues.steps != null) ? samplerInfo.currentValues.steps : samplerInfo.stepsRange.defaultValue;
        currentSteps = Math.max(samplerInfo.stepsRange.min, Math.min(samplerInfo.stepsRange.max, currentSteps));
        stepsSlider.value = currentSteps;
        stepsVal.text = String(Math.round(currentSteps));
      }
      
      if (samplerInfo.cfgRange) {
        cfgSlider.minvalue = Math.min(cfgSlider.minvalue, samplerInfo.cfgRange.min);
        cfgSlider.maxvalue = Math.max(cfgSlider.maxvalue, samplerInfo.cfgRange.max);
        cfgSlider.minvalue = samplerInfo.cfgRange.min;
        cfgSlider.maxvalue = samplerInfo.cfgRange.max;
        var currentCfg = (samplerInfo.currentValues && samplerInfo.currentValues.cfg != null) ? samplerInfo.currentValues.cfg : samplerInfo.cfgRange.defaultValue;
        currentCfg = Math.max(samplerInfo.cfgRange.min, Math.min(samplerInfo.cfgRange.max, currentCfg));
        cfgSlider.value = currentCfg;
        cfgVal.text = currentCfg.toFixed(1);
      }
      
      if (samplerInfo.denoiseRange) {
        denSlider.minvalue = Math.min(denSlider.minvalue, samplerInfo.denoiseRange.min);
        denSlider.maxvalue = Math.max(denSlider.maxvalue, samplerInfo.denoiseRange.max);
        denSlider.minvalue = samplerInfo.denoiseRange.min;
        denSlider.maxvalue = samplerInfo.denoiseRange.max;
        var currentDenoise = (samplerInfo.currentValues && samplerInfo.currentValues.denoise != null) ? samplerInfo.currentValues.denoise : samplerInfo.denoiseRange.defaultValue;
        currentDenoise = Math.max(samplerInfo.denoiseRange.min, Math.min(samplerInfo.denoiseRange.max, currentDenoise));
        denSlider.value = currentDenoise;
        denVal.text = currentDenoise.toFixed(2);
        denPanel.visible = true;
      } else {
        denPanel.visible = false;
      }
      
      if (samplerInfo.currentValues && samplerInfo.currentValues.seed != null) {
        seedEdit.text = String(samplerInfo.currentValues.seed);
      }
      
      return true;
    } catch(e) {
      log("Error applying cached settings: " + e);
      return false;
    }
  }

  // ====== Validation helpers ======
  function validateHost(host) {
    if (!host || host.trim() === "") return "Host cannot be empty";
    if (!/^(localhost|(\d{1,3}\.){3}\d{1,3})$/i.test(host.trim())) {
      return "Invalid host format";
    }
    return null;
  }
  
  function validatePort(port) {
    if (!port || port.trim() === "") return "Port cannot be empty";
    var portNum = parseInt(port.trim(), 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      return "Port must be between 1 and 65535";
    }
    return null;
  }
  
  function sanitizePrompt(text) {
    return String(text || "")
      .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "")
      .trim();
  }

  // ====== HTTP helpers ======
  function die(msg, detail){
    log("FAIL: "+msg+" :: "+(detail||""));
    throw new Error(msg);
  }
  
  function sleep(ms){ $.sleep(ms); }
  function rand32(){ 
    var n = Math.floor(Math.random() * 0xFFFFFFFF);
    if (n < 0) n = n + 0x100000000;
    return n;
  }

  
  function toBytes(str){ 
    var out=[],c; 
    for(var i=0;i<str.length;i++){ 
      c=str.charCodeAt(i);
      if(c<=0x7F) out.push(c); 
      else if(c<=0x7FF){ out.push(0xC0|(c>>6),0x80|(c&0x3F)); }
      else{ out.push(0xE0|(c>>12),0x80|((c>>6)&0x3F),0x80|(c&0x3F)); } 
    } 
    return out; 
  }
  
  function readAll(sock){ 
    var chunks=[]; 
    while(!sock.eof){ 
      var p=sock.read(8192); 
      if(!p) break; 
      chunks.push(p); 
    } 
    return chunks.join(""); 
  }

  function httpRequest(method, path, headers, bodyStr, wantBinary, allowErrors, host, port){
    var s = new Socket();
    if (!s.open(host + ":" + port, "BINARY")) die("Could not connect to "+host+":"+port);
    
    var CRLF="\r\n";
    var req = method+" "+path+" HTTP/1.1"+CRLF+"Host: "+host+":"+port+CRLF+"Connection: close"+CRLF;
    if (headers) for (var k in headers) if (headers.hasOwnProperty(k)) req += k+": "+headers[k]+CRLF;

    if (bodyStr!=null){
      var b=toBytes(bodyStr); 
      req += "Content-Length: "+b.length+CRLF+CRLF; 
      s.write(req);
      var bin=""; 
      for (var i=0;i<b.length;i++) bin+=String.fromCharCode(b[i]); 
      s.write(bin);
    } else { 
      req += CRLF; 
      s.write(req); 
    }

    var raw = readAll(s);
    s.close();

    var idx = raw.indexOf("\r\n\r\n");
    var sepLen = 4;
    if (idx < 0) { idx = raw.indexOf("\n\n"); sepLen = 2; }
    if (idx < 0) die("Malformed HTTP response.");

    var head = raw.substring(0, idx), body = raw.substring(idx + sepLen);
    var first = head.split("\r\n")[0]; 
    var m = first.match(/^HTTP\/\d\.\d\s+(\d+)/); 
    var status = m?parseInt(m[1],10):0;
    
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
    outFile.encoding="BINARY"; 
    if(!outFile.open("w")) die("Cannot write file:\n"+outFile.fsName);
    outFile.write(r.body); 
    outFile.close(); 
    if(!outFile.exists) die("Download failed:\n"+outFile.fsName);
  }
  
  function httpGetObjectInfo(host, port){
    var r = httpRequest("GET", "/object_info", {"Accept":"application/json"}, null, false, true, host, port);
    if (r.status !== 200 || !r.body) return null;
    try { return JSON.parse(r.body); } catch(e){ log("JSON parse error from /object_info: " + e); return null; }
  }

  // ====== AE helpers ======
  function activeComp(){ 
    return (app.project && app.project.activeItem instanceof CompItem) ? app.project.activeItem : null; 
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
  
  function setLayerInOutLike(layer, refLayer, comp){
    if (!layer || !refLayer) return;
    layer.startTime=0; 
    layer.inPoint=refLayer.inPoint; 
    layer.outPoint=Math.min(refLayer.outPoint, comp.duration);
  }

  // ====== Workflow utilities ======
  function deepCopy(o){ return JSON.parse(JSON.stringify(o)); }
  
  function snap(n, div){ 
    return Math.max(div, Math.round(n/div)*div); 
  }
  
  function clamp(n, maxv){ 
    return (maxv && isFinite(maxv)) ? Math.min(n, maxv) : n; 
  }
  
  function getCompDims(comp, div, maxw, maxh){
    var w=comp.width, h=comp.height;
    if (div && div>1){ w=snap(w,div); h=snap(h,div); }
    w=clamp(w,maxw); h=clamp(h,maxh);
    if (div && div>1){ w=Math.floor(w/div)*div; h=Math.floor(h/div)*div; }
    if (w < (div||1)) w=(div||1); 
    if (h < (div||1)) h=(div||1);
    return {w:w,h:h};
  }
  
  function isPromptNode(n){
    if (!n || !n.inputs) return false;
    if (n.class_type === "CLIPTextEncode" && n.inputs.hasOwnProperty("text")) return true;
    if (n.class_type === "CLIPTextEncodeFlux" && n.inputs.hasOwnProperty("clip_l")) return true;
    return false;
  }

  function setPromptText(node, text){
    if (node.class_type === "CLIPTextEncodeFlux") {
      node.inputs.clip_l = text;
      node.inputs.t5xxl  = text;
    } else {
      node.inputs.text = text;
    }
  }

  function injectPrompt(wf, text, preferredId){
    var id=null;
    if (preferredId && wf[preferredId] && isPromptNode(wf[preferredId])) {
      id=preferredId;
    } else {
      for (var k in wf){
        if(isPromptNode(wf[k])){
          id=k;
          break;
        }
      }
    }
    if (!id) die("No CLIPTextEncode node with 'text' input.");
    setPromptText(wf[id], text);
    return id;
  }

  function findNegativePromptNode(wf, positiveNodeId){
    var foundNodes = [];
    for (var k in wf){
      if(isPromptNode(wf[k])) foundNodes.push(k);
    }
    if (foundNodes.length > 1){
      for (var i=0; i<foundNodes.length; i++){
        if (foundNodes[i] !== positiveNodeId) return foundNodes[i];
      }
    }
    return null;
  }

  function hasNegativePromptNode(wf){
    var count = 0;
    for (var k in wf){
      if(isPromptNode(wf[k])){
        count++;
        if (count > 1) return true;
      }
    }
    return false;
  }

  function injectNegativePrompt(wf, text, negNodeId){
    if (!negNodeId || !wf[negNodeId]) return false;
    setPromptText(wf[negNodeId], text);
    return true;
  }
  
  function setSamplerParams(wf, params){
    for (var k in wf){
      var n=wf[k]; 
      if(!n || !n.inputs) continue;
      var ct=String(n.class_type||""); 
      
      // Match both basic and advanced samplers
      if (ct === "KSampler" || ct === "KSamplerAdvanced" || /Sampler/i.test(ct)) {
        // Common parameters for all samplers
        if (params.seed!=null && n.inputs.hasOwnProperty("seed")) 
          n.inputs.seed = params.seed>>>0;
        if (params.steps!=null && n.inputs.hasOwnProperty("steps")) 
          n.inputs.steps = params.steps|0;
        if (params.cfg!=null && n.inputs.hasOwnProperty("cfg")) 
          n.inputs.cfg = Number(params.cfg);
        if (params.sampler && n.inputs.hasOwnProperty("sampler_name")) 
          n.inputs.sampler_name = params.sampler;
        if (params.scheduler && n.inputs.hasOwnProperty("scheduler")) 
          n.inputs.scheduler = params.scheduler;
        if (params.denoise!=null && n.inputs.hasOwnProperty("denoise")) 
          n.inputs.denoise = Number(params.denoise);
        
        // Advanced KSampler parameters - only modify if explicitly provided
        if (ct === "KSamplerAdvanced") {
          if (params.hasOwnProperty("add_noise") && n.inputs.hasOwnProperty("add_noise"))
            n.inputs.add_noise = params.add_noise;
          if (params.hasOwnProperty("start_at_step") && n.inputs.hasOwnProperty("start_at_step"))
            n.inputs.start_at_step = params.start_at_step;
          if (params.hasOwnProperty("end_at_step") && n.inputs.hasOwnProperty("end_at_step"))
            n.inputs.end_at_step = params.end_at_step;
          if (params.hasOwnProperty("return_with_leftover_noise") && n.inputs.hasOwnProperty("return_with_leftover_noise"))
            n.inputs.return_with_leftover_noise = params.return_with_leftover_noise;
        }
        
        return k;
      }
    }
    return null;
  }
  
  function applyDims(wf, w, h){
    var touched=[];
    // Only modify nodes that generate or manipulate latent dimensions
    var targetTypes = ["EmptyLatentImage", "EmptySD3LatentImage", "LatentUpscale", "LatentUpscaleBy"];
    
    for (var k in wf){
      var n=wf[k]; 
      if(!n||!n.inputs||!n.class_type) continue;
      
      // Only modify specific node types to avoid breaking scale/crop nodes
      var isTarget = false;
      for (var i = 0; i < targetTypes.length; i++) {
        if (n.class_type === targetTypes[i]) {
          isTarget = true;
          break;
        }
      }
      
      if (isTarget && n.inputs.hasOwnProperty("width") && n.inputs.hasOwnProperty("height")){
        n.inputs.width=w; 
        n.inputs.height=h; 
        touched.push(k);
        log("Applied dims to " + n.class_type + " node: " + w + "x" + h);
      }
    }
    return touched;
  }
  
  function findSamplerNodeInfo(workflow, objectInfo){
    if (!objectInfo) return null;
    
    // Prioritize finding KSampler or KSamplerAdvanced first
    var samplerNode = null;
    var samplerNodeId = null;
    
    for (var nodeId in workflow){
      var node = workflow[nodeId];
      if (!node || !node.class_type) continue;
      
      var nodeClass = String(node.class_type);
      
      // Prioritize exact matches
      if (nodeClass === "KSampler" || nodeClass === "KSamplerAdvanced") {
        samplerNode = node;
        samplerNodeId = nodeId;
        break;
      } else if (!samplerNode && /Sampler/i.test(nodeClass)) {
        // Fallback to other sampler types
        samplerNode = node;
        samplerNodeId = nodeId;
      }
    }
    
    if (!samplerNode || !samplerNodeId) return null;
    
    var nodeClass = String(samplerNode.class_type);
    var nodeDef = objectInfo[nodeClass];
    if (!nodeDef || !nodeDef.input || !nodeDef.input.required) return null;
    var info = {
      nodeId: samplerNodeId,
      className: nodeClass,
      isAdvanced: (nodeClass === "KSamplerAdvanced"),
      samplers: null,
      schedulers: null,
      stepsRange: null,
      cfgRange: null,
      denoiseRange: null,
      hasSeed: false,
      currentValues: {
        steps: null,
        cfg: null,
        sampler_name: null,
        scheduler: null,
        denoise: null,
        seed: null
      }
    };
    
    // Extract current values from workflow
    if (samplerNode && samplerNode.inputs) {
      if (samplerNode.inputs.steps !== undefined) {
        info.currentValues.steps = samplerNode.inputs.steps;
      }
      if (samplerNode.inputs.cfg !== undefined) {
        info.currentValues.cfg = samplerNode.inputs.cfg;
      }
      if (samplerNode.inputs.sampler_name !== undefined) {
        info.currentValues.sampler_name = samplerNode.inputs.sampler_name;
      }
      if (samplerNode.inputs.scheduler !== undefined) {
        info.currentValues.scheduler = samplerNode.inputs.scheduler;
      }
      if (samplerNode.inputs.denoise !== undefined) {
        info.currentValues.denoise = samplerNode.inputs.denoise;
      }
      if (samplerNode.inputs.seed !== undefined) {
        info.currentValues.seed = samplerNode.inputs.seed;
      }
    }
    
    var required = nodeDef.input.required;
    
    if (required.sampler_name && required.sampler_name[0] instanceof Array) {
      info.samplers = required.sampler_name[0];
    }
    
    if (required.scheduler && required.scheduler[0] instanceof Array) {
      info.schedulers = required.scheduler[0];
    }
    
    if (required.steps && required.steps[0] === "INT") {
      var stepsConfig = required.steps[1];
      if (stepsConfig) {
        info.stepsRange = {
          min: stepsConfig.min || 1,
          max: stepsConfig.max || 150,
          defaultValue: stepsConfig["default"] || 20
        };
      }
    }
    
    if (required.cfg && required.cfg[0] === "FLOAT") {
      var cfgConfig = required.cfg[1];
      if (cfgConfig) {
        info.cfgRange = {
          min: cfgConfig.min || 0.0,
          max: cfgConfig.max || 100.0,
          defaultValue: cfgConfig["default"] || 8.0,
          step: cfgConfig.step || 0.1
        };
      }
    }
    
    if (required.denoise && required.denoise[0] === "FLOAT") {
      var denoiseConfig = required.denoise[1];
      if (denoiseConfig) {
        info.denoiseRange = {
          min: denoiseConfig.min || 0.0,
          max: denoiseConfig.max || 1.0,
          defaultValue: denoiseConfig["default"] || 1.0,
          step: denoiseConfig.step || 0.01
        };
      }
    }
    
    if (required.seed) {
      info.hasSeed = true;
    }
    
    return info;
  }

  function extractSettings(wf, dims, seedUsed){
    var model=null, sampler=null, steps=null, cfg=null, scheduler=null, denoise=null;

    for (var k in wf){
      var n = wf[k]; 
      if (!n || !n.inputs) continue;
      var ct = String(n.class_type||"");
      if (/CheckpointLoader/i.test(ct) && n.inputs.ckpt_name) {
        model = n.inputs.ckpt_name;
        break;
      }
      if (ct === "UNETLoader" && n.inputs.unet_name) {
        model = n.inputs.unet_name;
        break;
      }
    }

    for (var s in wf){
      var sn = wf[s]; 
      if (!sn || !sn.inputs) continue;
      var sct = String(sn.class_type||"");
      if (/Sampler/i.test(sct)) {
        if (sn.inputs.sampler_name) sampler = sn.inputs.sampler_name;
        if (sn.inputs.steps != null) steps = sn.inputs.steps;
        if (sn.inputs.cfg != null) cfg = sn.inputs.cfg;
        if (sn.inputs.scheduler) scheduler = sn.inputs.scheduler;
        if (sn.inputs.denoise != null) denoise = sn.inputs.denoise;
      }
    }

    var sizeStr = dims ? (dims.w + "x" + dims.h) : null;
    return { 
      seed: seedUsed, 
      prompt: null, 
      size: sizeStr, 
      sampler: sampler, 
      steps: steps, 
      cfg: cfg, 
      scheduler: scheduler, 
      denoise: denoise, 
      model: model 
    };
  }

  function makeInfoText(comp, refLayer, info){
    var lines = [];
    if (info.seed != null) lines.push("Seed: " + info.seed);
    if (info.prompt != null) lines.push("Prompt: " + info.prompt);
    if (info.size) lines.push("Size: " + info.size);
    if (info.model) lines.push("Model: " + info.model);
    if (info.sampler) lines.push("Sampler: " + info.sampler);
    if (info.scheduler) lines.push("Scheduler: " + info.scheduler);
    if (info.steps != null) lines.push("Steps: " + info.steps);
    if (info.cfg != null) lines.push("CFG: " + info.cfg);
    if (info.denoise != null) lines.push("Denoise: " + info.denoise);

    var text = lines.join("\r");
    var tl = comp.layers.addText(text);
    var tp = tl.property("ADBE Text Properties");
    var tdProp = tp.property("ADBE Text Document");
    var td = tdProp.value;

    td.fontSize = 28;
    td.applyFill = true;
    td.fillColor = [1, 1, 1];
    td.applyStroke = false;
    td.justification = ParagraphJustification.LEFT_JUSTIFY;
    tdProp.setValue(td);

    var tr = tl.property("ADBE Transform Group");
    tr.property("ADBE Position").setValue([100, comp.height - 120]);

    setLayerInOutLike(tl, refLayer, comp);
    try { tl.moveBefore(refLayer); } catch(_) {}
    return tl;
  }

  // ====== UI ======
  var win = (thisObj instanceof Panel) ? thisObj : new Window("palette", "ComfyUI Text2Image", undefined, {resizeable:true});
  win.alignChildren = ["fill","top"];
  win.spacing = 5;
  win.margins = 10;
  
  log("=== Text2Image Panel initialized ===");

  var savedSettings = loadSettings();

  // Connection settings
  var connPanel = win.add("panel", undefined, "ComfyUI Connection");
  connPanel.alignChildren = ["fill","top"];
  var connRow = connPanel.add("group"); 
  connRow.orientation="row";
  connRow.add("statictext", undefined, "Host:");
  var hostEdit = connRow.add("edittext", undefined, savedSettings.host); 
  hostEdit.characters = 15;
  connRow.add("statictext", undefined, "Port:");
  var portEdit = connRow.add("edittext", undefined, savedSettings.port); 
  portEdit.characters = 6;

  // Workflow picker
  var wfGrp = win.add("group"); 
  wfGrp.orientation="row"; 
  wfGrp.alignment = ["fill","top"];
  wfGrp.add("statictext", undefined, "Workflow:");
  var wfPath = wfGrp.add("edittext", undefined, savedSettings.workflow); 
  wfPath.characters = 40; 
  wfPath.enabled=false;
  var wfBtn = wfGrp.add("button", undefined, "Choose...");
  
  // Cached workflows dropdown
  var cacheGrp = win.add("group");
  cacheGrp.orientation = "row";
  cacheGrp.alignment = ["fill", "top"];
  cacheGrp.add("statictext", undefined, "Cached:");
  var wfDropdown = cacheGrp.add("dropdownlist", undefined, []);
  wfDropdown.preferredSize.width = 200;
  var clearCacheBtn = cacheGrp.add("button", undefined, "Clear Cache");
  
  // Add spacing
  win.add("statictext", undefined, " ");

  // Prompt mode checkbox
  var useAllTextLayers = win.add("checkbox", undefined, "Use all enabled text layers");
  useAllTextLayers.value = false;
  useAllTextLayers.alignment = ["left", "top"];

  // Prompt text box
  var promptPanel = win.add("panel", undefined, "Prompt");
  promptPanel.alignChildren = ["fill","top"];
  promptPanel.alignment = ["fill","top"];
  var promptText = promptPanel.add("edittext", undefined, "A beautiful landscape", {multiline:true, wantReturn:true});
  promptText.preferredSize = [undefined, 60];
  promptText.alignment = ["fill","top"];

  // Negative Prompt (initially hidden until workflow is loaded)
  var negPromptPanel = win.add("panel", undefined, "Negative Prompt");
  negPromptPanel.alignChildren = ["fill","top"];
  var negPrompt = negPromptPanel.add("edittext", undefined, "(worst quality, low quality:1.4), (bad anatomy), text, error, missing fingers, extra digit, fewer digits, cropped, jpeg artifacts, signature, watermark, username, blurry, deformed face", {multiline:true, wantReturn:true});
  negPrompt.preferredSize = [undefined, 40];
  negPrompt.enabled = false;
  negPromptPanel.visible = false;

  // Footer (placed early so it is always visible)
  var foot = win.add("group"); 
  foot.orientation="row"; 
  foot.alignment=["fill","top"];
  var genBtn = foot.add("button", undefined, "Generate");
  var cancelBtn = foot.add("button", undefined, "Cancel"); 
  cancelBtn.enabled=false;
  var logBtn = foot.add("button", undefined, "View Log");
  logBtn.preferredSize = [70, undefined];
  var statusTxt = foot.add("statictext", undefined, "Idle"); 
  statusTxt.alignment=["right","center"];

  // Sampling
  var sampPanel = win.add("panel", undefined, "Sampling");
  sampPanel.alignChildren = ["fill","top"];
  sampPanel.visible = false; // Hidden until workflow loaded
  
  var rowS1 = sampPanel.add("group"); 
  rowS1.orientation="row";
  var ddSampler = rowS1.add("dropdownlist", undefined, ["euler","euler_a","dpmpp_2m","dpmpp_sde","lcm"]);
  ddSampler.selection = 0;
  var ddScheduler = rowS1.add("dropdownlist", undefined, ["none","karras","exponential","sgm_uniform"]); 
  ddScheduler.selection=0;

  var rowS2 = sampPanel.add("group"); 
  rowS2.orientation="row";
  rowS2.add("statictext", undefined, "Steps:");
  var stepsSlider = rowS2.add("slider", undefined, 30, 1, 80); 
  stepsSlider.preferredSize=[200, undefined];
  var stepsVal = rowS2.add("edittext", undefined, "30"); 
  stepsVal.characters=4;

  var rowS3 = sampPanel.add("group"); 
  rowS3.orientation="row";
  rowS3.add("statictext", undefined, "CFG:");
  var cfgSlider = rowS3.add("slider", undefined, 7.0, 1.0, 20.0); 
  cfgSlider.preferredSize=[200, undefined];
  var cfgVal = rowS3.add("edittext", undefined, "7.0"); 
  cfgVal.characters=4;

  // Denoise (hidden by default, only show for img2img workflows)
  var denPanel = win.add("panel", undefined, "Denoise");
  denPanel.alignChildren = ["fill","top"];
  denPanel.visible = false;
  var denGrp = denPanel.add("group"); 
  denGrp.orientation="row";
  denGrp.add("statictext", undefined, "Denoise:");
  var denSlider = denGrp.add("slider", undefined, 0.5, 0.0, 1.0); 
  denSlider.preferredSize=[200, undefined];
  var denVal = denGrp.add("edittext", undefined, "0.50"); 
  denVal.characters=6;

  // Size
  var sizePanel = win.add("panel", undefined, "Size");
  sizePanel.alignChildren = ["left","top"];
  sizePanel.visible = false; // Hidden until workflow loaded
  
  var useComp = sizePanel.add("checkbox", undefined, "Use comp size"); 
  useComp.value=true;
  var sizeRow = sizePanel.add("group"); 
  sizeRow.orientation="row";
  var wEdit = sizeRow.add("edittext", undefined, "0"); 
  wEdit.characters=5;
  sizeRow.add("statictext", undefined, "x");
  var hEdit = sizeRow.add("edittext", undefined, "0"); 
  hEdit.characters=5;
  sizeRow.add("statictext", undefined, " Snap:");
  var snapDD = sizeRow.add("dropdownlist", undefined, ["1","8","64"]); 
  snapDD.selection=2;
  sizeRow.add("statictext", undefined, " MaxW:");
  var maxWEdit = sizeRow.add("edittext", undefined, String(DEFAULT_MAXW)); 
  maxWEdit.characters=5;
  sizeRow.add("statictext", undefined, " MaxH:");
  var maxHEdit = sizeRow.add("edittext", undefined, String(DEFAULT_MAXH)); 
  maxHEdit.characters=5;

  // Seed
  var seedPanel = win.add("panel", undefined, "Seed");
  seedPanel.alignChildren = ["left","top"];
  seedPanel.visible = false; // Hidden until workflow loaded
  
  var seedRow1 = seedPanel.add("group"); 
  seedRow1.orientation="row";
  var rbFixed     = seedRow1.add("radiobutton", undefined, "Fixed");
  rbFixed.value = true;
  var rbRandom    = seedRow1.add("radiobutton", undefined, "Random per run");
  var rbIncrement = seedRow1.add("radiobutton", undefined, "Increment");
  var seedRow2 = seedPanel.add("group"); 
  seedRow2.orientation="row";
  seedRow2.add("statictext", undefined, "Seed:");
  var seedEdit = seedRow2.add("edittext", undefined, String(rand32())); 
  seedEdit.characters=12;
  var seedRow3 = seedPanel.add("group");
  seedRow3.orientation="row";
  seedRow3.add("statictext", undefined, "Variations:");
  var variationsEdit = seedRow3.add("edittext", undefined, "1");
  variationsEdit.characters=4;
  variationsEdit.enabled = false;

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

  // ====== UI wiring ======
  function uInt(v, def){ 
    var n=parseInt(String(v),10); 
    return isFinite(n)?n:def; 
  }
  
  function uNum(v, def){ 
    var n=parseFloat(String(v)); 
    return isFinite(n)?n:def; 
  }

  function refreshCompDims(){
    try {
      var comp = activeComp();
      if (!comp) {
        wEdit.text = "0";
        hEdit.text = "0";
        return;
      }
      
      var snapVal = parseInt(snapDD.selection.text, 10);
      if (!isFinite(snapVal) || snapVal < 1) snapVal = 8;
      
      var maxW = uInt(maxWEdit.text, DEFAULT_MAXW);
      var maxH = uInt(maxHEdit.text, DEFAULT_MAXH);
      
      var dims = getCompDims(comp, snapVal, maxW, maxH);
      
      wEdit.text = String(dims.w);
      hEdit.text = String(dims.h);
      
      log("Refreshed comp dims: " + dims.w + "x" + dims.h);
    } catch(e) {
      log("Error refreshing comp dims: " + e.toString());
    }
  }

  function setGenEnabled(){
    var ok = (wfPath.text && wfPath.text.length>0);
    
    if (ok){
      ok = ok && (hostEdit.text.replace(/\s+/g,"").length>0);
      ok = ok && (portEdit.text.replace(/\s+/g,"").length>0);
      ok = ok && !!activeComp();
      
      // Check if we're using text layers or prompt text
      if (!useAllTextLayers.value) {
        ok = ok && (promptText.text && promptText.text.replace(/\s+/g,"").length > 0);
      }
    }
    genBtn.enabled = ok;
  }

  function seedRefresh(){
    seedEdit.enabled = rbFixed.value || rbIncrement.value;
    variationsEdit.enabled = rbRandom.value || rbIncrement.value;
  }
  
  function denSyncFromSlider(){ 
    denVal.text = String((Math.round(denSlider.value*100)/100).toFixed(2)); 
  }
  
  function denSyncFromEdit(){ 
    var v = Math.max(denSlider.minvalue, Math.min(denSlider.maxvalue, uNum(denVal.text, 0.5))); 
    denSlider.value = v; 
    denVal.text = v.toFixed(2); 
  }
  
  function stepsSyncFromSlider(){ 
    stepsVal.text = String(Math.round(stepsSlider.value)); 
  }
  
  function stepsSyncFromEdit(){ 
    var v = Math.max(stepsSlider.minvalue, Math.min(stepsSlider.maxvalue, uInt(stepsVal.text, 30))); 
    stepsSlider.value = v; 
    stepsVal.text = String(v); 
  }
  
  function cfgSyncFromSlider(){ 
    cfgVal.text = String((Math.round(cfgSlider.value*10)/10).toFixed(1)); 
  }
  
  function cfgSyncFromEdit(){ 
    var v = Math.max(cfgSlider.minvalue, Math.min(cfgSlider.maxvalue, uNum(cfgVal.text, 7))); 
    cfgSlider.value = v; 
    cfgVal.text = v.toFixed(1); 
  }

  function updateOutputFolderDisplay(){
    if (!outputFolderPath.text || outputFolderPath.text.length === 0) {
      var projectFile = app.project.file;
      if (projectFile && projectFile.exists) {
        outputFolderPath.text = projectFile.parent.fsName;
        log("Output folder set to project folder");
      } else {
        outputFolderPath.text = Folder.temp.fsName;
        log("Output folder set to temp folder");
      }
    }
  }

  // Initial states
  refreshCompDims(); 
  seedRefresh(); 
  denSyncFromSlider(); 
  stepsSyncFromSlider(); 
  cfgSyncFromSlider(); 
  setGenEnabled();
  updateOutputFolderDisplay();
  
  // Prompt mode toggle
  function updatePromptMode() {
    promptText.enabled = !useAllTextLayers.value;
  }
  updatePromptMode();

  // Events
  hostEdit.onChanging = portEdit.onChanging = setGenEnabled;
  
  useAllTextLayers.onClick = function() {
    updatePromptMode();
    setGenEnabled();
  };
  
  wfBtn.onClick = function(){
    try {
      var f = File.openDialog("Select ComfyUI API workflow JSON"); 
      if (!f) return;
      wfPath.text = f.fsName;
      
      var host = hostEdit.text.replace(/\s+/g, "") || DEFAULT_HOST;
      var port = portEdit.text.replace(/\s+/g, "") || DEFAULT_PORT;
      
      // Check cache first
      var cachedInfo = getCachedWorkflowInfo(f.fsName);
      var objectInfo = null;
      var samplerInfo = null;
      
      if (cachedInfo) {
        // Use cached data
        objectInfo = cachedInfo.objectInfo;
        samplerInfo = cachedInfo.samplerInfo;
        statusTxt.text = "Loaded from cache";
        log("Using cached workflow info");
      } else {
        // Load and analyze workflow from API
        var wfFile = new File(f.fsName);
        try {
          if (wfFile.exists && wfFile.open("r")) {
            var wfText = wfFile.read();
            var workflow = JSON.parse(wfText);
            
            // Get object info from ComfyUI
            statusTxt.text = "Loading workflow info...";
            objectInfo = httpGetObjectInfo(host, port);
            
            if (objectInfo) {
              log("Got object info from ComfyUI");
              
              // Find sampler node and extract its configuration
              samplerInfo = findSamplerNodeInfo(workflow, objectInfo);
              
              // Cache the results
              cacheWorkflowInfo(f.fsName, objectInfo, samplerInfo);
              updateWorkflowDropdown();
            }
          }
        } catch(e) {
          statusTxt.text = "Error loading workflow";
          log("Error analyzing workflow: " + e);
          statusTxt.text = "Error loading workflow";
        } finally {
          try { wfFile.close(); } catch(e) {}
        }
      }
      
      // Apply settings from samplerInfo (whether cached or fresh)
      if (samplerInfo) {
        log("Applying sampler settings: " + samplerInfo.className);
        
        // Update sampler dropdown and select current value from workflow
        if (samplerInfo.samplers && samplerInfo.samplers.length > 0) {
          ddSampler.removeAll();
          var currentSamplerIndex = 0;
          for (var i = 0; i < samplerInfo.samplers.length; i++) {
            ddSampler.add("item", samplerInfo.samplers[i]);
            if (samplerInfo.currentValues && samplerInfo.currentValues.sampler_name === samplerInfo.samplers[i]) {
              currentSamplerIndex = i;
            }
          }
          ddSampler.selection = currentSamplerIndex;
          log("Loaded " + samplerInfo.samplers.length + " samplers, selected: " + ddSampler.selection.text);
        }
        
        // Update scheduler dropdown and select current value from workflow
        if (samplerInfo.schedulers && samplerInfo.schedulers.length > 0) {
          ddScheduler.removeAll();
          var currentSchedulerIndex = 0;
          for (var i = 0; i < samplerInfo.schedulers.length; i++) {
            ddScheduler.add("item", samplerInfo.schedulers[i]);
            if (samplerInfo.currentValues && samplerInfo.currentValues.scheduler === samplerInfo.schedulers[i]) {
              currentSchedulerIndex = i;
            }
          }
          ddScheduler.selection = currentSchedulerIndex;
          log("Loaded " + samplerInfo.schedulers.length + " schedulers, selected: " + ddScheduler.selection.text);
        }
        
        // Update steps slider with current value from workflow
        if (samplerInfo.stepsRange) {
          stepsSlider.minvalue = samplerInfo.stepsRange.min;
          stepsSlider.maxvalue = samplerInfo.stepsRange.max;
          var currentSteps = (samplerInfo.currentValues && samplerInfo.currentValues.steps != null) ? samplerInfo.currentValues.steps : samplerInfo.stepsRange.defaultValue;
          stepsSlider.value = currentSteps;
          stepsVal.text = String(currentSteps);
          log("Steps range: " + samplerInfo.stepsRange.min + "-" + samplerInfo.stepsRange.max + ", current: " + currentSteps);
        }
        
        // Update CFG slider with current value from workflow
        if (samplerInfo.cfgRange) {
          cfgSlider.minvalue = samplerInfo.cfgRange.min;
          cfgSlider.maxvalue = samplerInfo.cfgRange.max;
          var currentCfg = (samplerInfo.currentValues && samplerInfo.currentValues.cfg != null) ? samplerInfo.currentValues.cfg : samplerInfo.cfgRange.defaultValue;
          cfgSlider.value = currentCfg;
          cfgVal.text = currentCfg.toFixed(1);
          log("CFG range: " + samplerInfo.cfgRange.min + "-" + samplerInfo.cfgRange.max + ", current: " + currentCfg);
        }
        
        // Update denoise slider with current value from workflow
        if (samplerInfo.denoiseRange) {
          denSlider.minvalue = samplerInfo.denoiseRange.min;
          denSlider.maxvalue = samplerInfo.denoiseRange.max;
          var currentDenoise = (samplerInfo.currentValues && samplerInfo.currentValues.denoise != null) ? samplerInfo.currentValues.denoise : samplerInfo.denoiseRange.defaultValue;
          denSlider.value = currentDenoise;
          denVal.text = currentDenoise.toFixed(2);
          denPanel.visible = true;
          log("Denoise range: " + samplerInfo.denoiseRange.min + "-" + samplerInfo.denoiseRange.max + ", current: " + currentDenoise);
        } else {
          denPanel.visible = false;
        }
        
        // Update seed with current value from workflow
        if (samplerInfo.hasSeed && samplerInfo.currentValues && samplerInfo.currentValues.seed != null) {
          seedEdit.text = String(samplerInfo.currentValues.seed);
          log("Loaded seed from workflow: " + samplerInfo.currentValues.seed);
        }
        
        // Show/hide seed panel based on whether node has seed
        if (samplerInfo.hasSeed) {
          seedPanel.visible = true;
        }
      } else {
        log("Warning: No sampler node found in workflow");
      }
      
      statusTxt.text = cachedInfo ? "Workflow loaded (cached)" : "Workflow loaded";
      updateWorkflowUI(f.fsName);
    } catch(e) {
      statusTxt.text = "Error";
      log("Error in workflow selection: " + e);
    }
  };

  // Cached workflow dropdown handler
  wfDropdown.onChange = function() {
    if (!wfDropdown.selection) return;
    
    var selectedName = wfDropdown.selection.text;
    if (selectedName === "(No cached workflows)") return;
    
    // Lazy-load the full entry from disk on demand
    var cachedInfo = loadWorkflowEntry(selectedName);
    if (!cachedInfo) return;
    
    try {
      // Update workflow path
      wfPath.text = cachedInfo.path;
      
      // Apply cached settings
      statusTxt.text = "Loading cached workflow...";
      
      if (applyCachedWorkflowSettings(cachedInfo)) {
        statusTxt.text = "Workflow loaded (cached)";
        updateWorkflowUI(cachedInfo.path);
        log("Applied cached workflow: " + selectedName);
      }
    } catch(e) {
      statusTxt.text = "Error loading cached workflow";
      log("Error applying cached workflow: " + e);
    }
  };

  // Clear cache button handler
  clearCacheBtn.onClick = function() {
    try {
      var confirmed = confirm("Clear all cached workflow data?");
      if (!confirmed) return;
      
      // Delete individual entry files
      for (var name in workflowIndex) {
        if (workflowIndex[name]) deleteWorkflowEntry(name);
      }
      workflowIndex = {};
      workflowCache = {};
      saveWorkflowIndex();
      updateWorkflowDropdown();
      
      statusTxt.text = "Cache cleared";
      log("Workflow cache cleared");
    } catch(e) {
      log("Error clearing cache: " + e);
    }
  };

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
  maxWEdit.onChanging = maxHEdit.onChanging = function() {
    if (useComp.value) refreshCompDims();
    setGenEnabled();
  };
  
  snapDD.onChange = function(){ 
    if (useComp.value) refreshCompDims(); 
    setGenEnabled(); 
  };

  denSlider.onChanging = denSyncFromSlider; 
  denVal.onChange = function(){ denSyncFromEdit(); setGenEnabled(); };
  stepsSlider.onChanging = stepsSyncFromSlider; 
  stepsVal.onChange = function(){ stepsSyncFromEdit(); setGenEnabled(); };
  cfgSlider.onChanging = cfgSyncFromSlider; 
  cfgVal.onChange = function(){ cfgSyncFromEdit(); setGenEnabled(); };

  rbFixed.onClick = rbRandom.onClick = rbIncrement.onClick = function(){ seedRefresh(); setGenEnabled(); };
  seedEdit.onChanging = setGenEnabled;
  
  promptText.onChanging = setGenEnabled;

  chooseFolderBtn.onClick = function(){
    try {
      var folder = Folder.selectDialog("Choose output folder");
      if (folder) {
        outputFolderPath.text = folder.fsName;
        log("Output folder selected: " + folder.fsName);
      }
    } catch(e) {
      log("Error selecting folder: " + e);
    }
  };

  logBtn.onClick = function(){
    if (LOG.exists) {
      LOG.execute();
    } else {
      alert("Log file does not exist yet.\n\nPath: " + LOG.fsName);
    }
  };

  // Composition monitoring
  var lastActiveComp = null;
  var lastCompSize = null;
  var checkCompTimer = null;
  var panelClosed = false;

  function startCompMonitoring() {
    if (panelClosed) return;
    if (checkCompTimer) app.cancelTask(checkCompTimer);
    checkCompTimer = app.scheduleTask("$._comfyText2ImagePanel.checkActiveComp()", 1000, true);
  }

  function stopCompMonitoring() {
    panelClosed = true;
    if (checkCompTimer) {
      try {
        app.cancelTask(checkCompTimer);
      } catch(e) {}
      checkCompTimer = null;
    }
  }

  $._comfyText2ImagePanel.checkActiveComp = function() {
    if (panelClosed || !checkCompTimer) return;
    
    try {
      if (app.isWatchFolder) return;
      if (!win || !win.visible) return;
      
      var currentComp = app.project.activeItem;
      var hasComp = (currentComp && currentComp instanceof CompItem);
      
      if (!hasComp) {
        // No comp open -- update button state if it changed
        if (lastActiveComp !== null) {
          lastActiveComp = null;
          lastCompSize = null;
          try { setGenEnabled(); } catch(e) {}
        }
        return;
      }
      
      var currentCompId = currentComp.id;
      var currentSize = currentComp.width + "x" + currentComp.height;
      
      if (currentCompId !== lastActiveComp) {
        lastActiveComp = currentCompId;
        lastCompSize = currentSize;
        
        if (useComp && useComp.value) {
          try { refreshCompDims(); } catch(e) {}
        }
        try { setGenEnabled(); } catch(e) {}
      } else if (currentSize !== lastCompSize) {
        lastCompSize = currentSize;
        
        if (useComp && useComp.value) {
          try { refreshCompDims(); } catch(e) {}
        }
      }
    } catch(e) {}
  };

  startCompMonitoring();
  lastActiveComp = activeComp() ? activeComp().id : null;

  // Initialize workflow cache index (lightweight -- only names/paths/timestamps)
  workflowIndex = loadWorkflowIndex();
  updateWorkflowDropdown();

  // Restore workflow UI from saved settings + cache
  if (savedSettings.workflow) {
    var startupName = getWorkflowName(savedSettings.workflow);
    if (startupName && workflowIndex[startupName]) {
      var startupEntry = loadWorkflowEntry(startupName);
      if (startupEntry) {
        try { applyCachedWorkflowSettings(startupEntry); } catch(e) { log("Startup cache apply error: " + e); }
      }
    }
    try { updateWorkflowUI(savedSettings.workflow); } catch(e) { log("Startup UI restore error: " + e); }
  }

  win.onClose = function() {
    stopCompMonitoring();
    return true;
  };

  if (win instanceof Window) { 
    win.center(); 
    win.show();
  } else { 
    win.layout.layout(true);
    win.layout.resize();
  }

  // ====== GENERATION LOGIC ======
  var baseWorkflow = null;
  var stopRequested = false;

  genBtn.onClick = function(){
    try{
      var host = hostEdit.text.replace(/\s+/g, "");
      var port = portEdit.text.replace(/\s+/g, "");
      
      var hostError = validateHost(host);
      if (hostError) die(hostError);
      
      var portError = validatePort(port);
      if (portError) die(portError);

      if (!wfPath.text) die("Please choose a workflow JSON first.");
      var wfFile = new File(wfPath.text); 
      if(!wfFile.exists) die("Workflow file not found");
      
      var wfText = null;
      try {
        if (wfFile.open("r")) {
          wfText = wfFile.read();
        } else {
          die("Could not open workflow file");
        }
      } finally {
        try { wfFile.close(); } catch(e) {}
      }
      
      try { 
        baseWorkflow = JSON.parse(wfText); 
      } catch(e){ 
        die("Workflow JSON parse error (API export required)", e); 
      }

      var negPromptStr = sanitizePrompt(negPrompt.text);
      var denoise = denPanel.visible ? uNum(denVal.text, 0.5) : null;
      var steps = uInt(stepsVal.text, 30);
      var cfg = uNum(cfgVal.text, 7.0);
      var sampler = ddSampler.selection ? ddSampler.selection.text : "euler";
      var scheduler = ddScheduler.selection ? ddScheduler.selection.text : "none";
      var useSeed = (rbFixed.value || rbIncrement.value) ? uInt(seedEdit.text, rand32()) : null;

      var comp = activeComp(); 
      if(!comp) die("No active comp");

      var snapDiv = parseInt(snapDD.selection.text,10);
      var dims = useComp.value ? getCompDims(comp, snapDiv, uInt(maxWEdit.text, DEFAULT_MAXW), uInt(maxHEdit.text, DEFAULT_MAXH))
                               : { w: uInt(wEdit.text, comp.width), h: uInt(hEdit.text, comp.height) };

      // Collect targets based on mode
      var targets = [];
      
      if (useAllTextLayers.value) {
        // Use all enabled text layers in composition
        for (var i = 1; i <= comp.numLayers; i++) {
          var L = comp.layer(i);
          if (!L || !L.enabled || L.locked) continue;
          var tp = L.property("ADBE Text Properties");
          var td = tp ? tp.property("ADBE Text Document") : null;
          if (!td) continue;
          var tdoc = td.value;
          var text = sanitizePrompt(String(tdoc && tdoc.text || ""));
          if (!text || text === "") continue;
          targets.push({ layer: L, text: text });
        }
        
        if (targets.length === 0) die("No enabled text layers found in composition");
      } else {
        // Use prompt text box - generate single image
        var userPrompt = sanitizePrompt(promptText.text);
        if (!userPrompt || userPrompt === "") die("Please enter a prompt");
        
        // Create a dummy target for the single generation
        targets.push({ layer: null, text: userPrompt });
      }

      // Save project
      if (app.project.file && app.project.dirty) {
        statusTxt.text = "Saving project...";
        log("Saving project");
        app.project.save();
      }

      stopRequested = false;
      stopCompMonitoring();
      setEnabled(false);

      log("START batch generation | layers=" + targets.length);

      // Determine output folder
      var outputFolder = Folder.temp;
      var projectFile = app.project.file;
      
      if (outputFolderPath.text && outputFolderPath.text.length > 0) {
        var customFolder = new Folder(outputFolderPath.text);
        if (customFolder.exists) {
          outputFolder = customFolder;
          log("Using custom output folder");
        } else if (projectFile && projectFile.exists) {
          outputFolder = projectFile.parent;
          log("Using project folder");
        }
      } else if (projectFile && projectFile.exists) {
        outputFolder = projectFile.parent;
        log("Using project folder");
      }

      app.beginUndoGroup("ComfyUI Text2Image Batch");

      var successCount = 0;
      var failCount = 0;
      
      // Get number of variations
      var numVariations = (rbRandom.value || rbIncrement.value) ? Math.max(1, uInt(variationsEdit.text, 1)) : 1;
      log("Variations: " + numVariations);
      
      // If text layer mode, do all layers per variation
      // If prompt mode, repeat the prompt for each variation
      for (var varIdx = 0; varIdx < numVariations; varIdx++) {
        if (stopRequested) {
          log("Canceled by user");
          statusTxt.text = "Cancelled";
          break;
        }
        
        // For text layer mode with random seed: generate new seed for each variation
        var variationSeed = useSeed != null ? (rbIncrement.value ? useSeed + varIdx : useSeed) : rand32();
        log("Variation " + (varIdx + 1) + "/" + numVariations + " | Seed: " + variationSeed);

        for (var idx = targets.length - 1; idx >= 0; idx--) {
          if (stopRequested) {
            log("Canceled by user");
            statusTxt.text = "Cancelled";
            break;
          }

          var T = targets[idx];
          var layer = T.layer;
          var promptStr = T.text;

          var totalOps = targets.length * numVariations;
          var currentOp = (varIdx * targets.length) + (targets.length - idx);
          statusTxt.text = "Processing " + currentOp + "/" + totalOps + "...";
          log("Processing: " + (layer ? layer.name : "prompt") + " (var " + (varIdx+1) + ")");

          try {
            var wf = deepCopy(baseWorkflow);
            var posNodeId = injectPrompt(wf, promptStr, null);
            
            var negNodeId = findNegativePromptNode(wf, posNodeId);
            if (negNodeId && negPrompt.enabled) {
              injectNegativePrompt(wf, negPromptStr, negNodeId);
            }
            
            applyDims(wf, dims.w, dims.h);
            
            var currentSeed = variationSeed;
          
          var samplerParams = {
            seed: currentSeed,
            steps: steps, 
            cfg: cfg, 
            sampler: sampler,
            scheduler: (scheduler==="none"? null : scheduler)
          };
          if (denoise != null) samplerParams.denoise = denoise;
          
          setSamplerParams(wf, samplerParams);

          var post = httpPostJSONPrompt(wf, host, port);
          if (!post || !post.prompt_id) die("Unexpected /prompt response");
          var pid = post.prompt_id;
          log("Prompt ID: " + pid);

          var fileInfo=null;
          while(true){
            if (stopRequested) throw new Error("Canceled by user");
            
            var hist = httpHistoryMaybe(pid, host, port);
            if (hist){
              var rec=hist[pid];
              if (rec && rec.outputs){
                for (var k in rec.outputs){
                  var out = rec.outputs[k];
                  if (out && out.images && out.images.length>0){ 
                    fileInfo = out.images[0]; 
                    break; 
                  }
                }
                if (fileInfo) break;
              }
            }
            sleep(POLL_MS);
          }
          log("Got image: " + fileInfo.filename);

          var q = "/view?filename=" + encodeURIComponent(fileInfo.filename) +
                  "&subfolder=" + encodeURIComponent(fileInfo.subfolder || "") +
                  "&type=" + encodeURIComponent(fileInfo.type || "output");
          var outFile = new File(outputFolder.fsName + "/" + fileInfo.filename);
          httpDownloadToFile(q, outFile, host, port);

          var io = new ImportOptions(outFile);
          var footage = app.project.importFile(io);
          var imgLayer = comp.layers.add(footage);

          // Handle layer placement based on mode
          if (layer) {
            // Text layer mode - match timing and position at top of comp
            setLayerInOutLike(imgLayer, layer, comp);
            // Move to top of comp so all variations stack in order
            try { 
              imgLayer.moveToBeginning();
            } catch(_){}
          } else {
            // Prompt text mode - set to comp duration and move to top
            imgLayer.startTime = 0;
            imgLayer.inPoint = 0;
            imgLayer.outPoint = comp.duration;
            try { 
              imgLayer.moveToBeginning();
            } catch(_){}
          }
          
          fitLayerToComp(imgLayer, comp);

          if (app.project.file) {
            app.project.save();
            log("Project saved after image");
          }

          successCount++;
          log("Success: " + (layer ? layer.name : "prompt"));

        } catch(e) {
          failCount++;
          log("Failed: " + (layer ? layer.name : "prompt") + " - " + e.message);
        }
      } // end targets loop
      
      if (stopRequested) break; // break out of variations loop if cancelled
      
    } // end variations loop

      app.endUndoGroup();

      saveSettings(host, port, wfPath.text, outputFolderPath.text);

      statusTxt.text = "Done";
      var resultMsg = "Generated " + successCount + " image(s)";
      if (failCount > 0) resultMsg += " (" + failCount + " failed)";
      log("DONE: " + resultMsg);
      alert(resultMsg);

    } catch(e){
      statusTxt.text = "Error: " + e.message;
      log("ERROR: " + e.toString());
    } finally {
      if (win && win.visible) {
        setEnabled(true);
        startCompMonitoring();
      }
    }
  };

  cancelBtn.onClick = function(){
    stopRequested = true;
    statusTxt.text = "Canceling...";
  };

  function setEnabled(flag){
    var controls = [hostEdit, portEdit, wfBtn, useAllTextLayers, promptText, negPrompt,
                    denSlider, denVal, ddSampler, ddScheduler,
                    stepsSlider, stepsVal, cfgSlider, cfgVal,
                    useComp, wEdit, hEdit, snapDD, maxWEdit, maxHEdit,
                    rbFixed, rbRandom, seedEdit, variationsEdit,
                    chooseFolderBtn];
    
    for (var i=0;i<controls.length;i++) {
      try { 
        if (controls[i]) controls[i].enabled = flag; 
      } catch(_){}
    }
    
    if (flag) {
      negPrompt.enabled = negPromptPanel.visible;
      // Respect prompt mode toggle
      updatePromptMode();
      // Respect seed mode
      seedRefresh();
      setGenEnabled();
    } else {
      genBtn.enabled = false;
    }
    
    cancelBtn.enabled = !flag;
  }

})(this);