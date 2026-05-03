(function metadataInspector(thisObj){

    // ---------- UI ----------
    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel) ? thisObj : new Window("palette", "ComfyUI Workflow Reader", undefined, {resizeable:true});

        var grp = win.add("group {orientation:'column', alignChildren:['fill','top'], spacing:8, margins:10}");
        
        // Status row
        var statusRow = grp.add("group {orientation:'row', alignChildren:['left','center'], spacing:8}");
        var statusLabel = statusRow.add("statictext", undefined, "Status:");
        var statusText = statusRow.add("statictext", undefined, "Ready");
        statusText.graphics.foregroundColor = statusText.graphics.newPen(statusText.graphics.PenType.SOLID_COLOR, [0.5, 0.8, 0.5], 1);
        
        // Buttons
        var rowBtns = grp.add("group {orientation:'row', alignChildren:['left','center'], spacing:8}");
        var btnSelected = rowBtns.add("button", undefined, "From Selected Layer");
        var btnBrowse   = rowBtns.add("button", undefined, "Browse PNG…");
        var btnRefresh  = rowBtns.add("button", undefined, "⟳ Refresh");
        
        var btnRow2 = grp.add("group {orientation:'row', alignChildren:['left','center'], spacing:8}");
        var btnCopyAPI  = btnRow2.add("button", undefined, "Copy API Prompt");
        var btnSaveAPI  = btnRow2.add("button", undefined, "Save API Prompt");

        var info = grp.add("statictext", undefined, "Extract generation parameters from ComfyUI images", {multiline:true});
        info.preferredSize.width = 520;

        // Parameters panel
        var paramPanel = grp.add("panel", undefined, "Generation Parameters");
        paramPanel.orientation = "column";
        paramPanel.alignChildren = ["fill", "top"];
        paramPanel.spacing = 5;
        paramPanel.margins = 10;
        
        // Seed
        var seedRow = paramPanel.add("group {orientation:'row', alignChildren:['left','center'], spacing:8}");
        seedRow.add("statictext", undefined, "Seed:");
        var seedTxt = seedRow.add("edittext", undefined, "");
        seedTxt.preferredSize = [150, 20];
        
        // Steps & CFG
        var stepsCfgRow = paramPanel.add("group {orientation:'row', alignChildren:['left','center'], spacing:8}");
        stepsCfgRow.add("statictext", undefined, "Steps:");
        var stepsTxt = stepsCfgRow.add("edittext", undefined, "");
        stepsTxt.preferredSize = [60, 20];
        stepsCfgRow.add("statictext", undefined, "CFG:");
        var cfgTxt = stepsCfgRow.add("edittext", undefined, "");
        cfgTxt.preferredSize = [60, 20];
        
        // Sampler & Scheduler
        var samplerRow = paramPanel.add("group {orientation:'row', alignChildren:['left','center'], spacing:8}");
        samplerRow.add("statictext", undefined, "Sampler:");
        var samplerTxt = samplerRow.add("edittext", undefined, "");
        samplerTxt.preferredSize = [120, 20];
        samplerRow.add("statictext", undefined, "Scheduler:");
        var schedulerTxt = samplerRow.add("edittext", undefined, "");
        schedulerTxt.preferredSize = [100, 20];
        
        // Size
        var sizeRow = paramPanel.add("group {orientation:'row', alignChildren:['left','center'], spacing:8}");
        sizeRow.add("statictext", undefined, "Size:");
        var sizeTxt = sizeRow.add("edittext", undefined, "");
        sizeTxt.preferredSize = [100, 20];
        sizeRow.add("statictext", undefined, "Denoise:");
        var denoiseTxt = sizeRow.add("edittext", undefined, "");
        denoiseTxt.preferredSize = [60, 20];
        
        // Model
        var modelRow = paramPanel.add("group {orientation:'row', alignChildren:['left','center'], spacing:8}");
        modelRow.add("statictext", undefined, "Model:");
        var modelTxt = modelRow.add("edittext", undefined, "");
        modelTxt.preferredSize = [400, 20];
        
        // Positive Prompt
        var posRow = paramPanel.add("group {orientation:'column', alignChildren:['fill','top'], spacing:3}");
        posRow.add("statictext", undefined, "Positive Prompt:");
        var posTxt = posRow.add("edittext", undefined, "", {multiline:true, scrolling:true});
        posTxt.preferredSize = [520, 50];
        
        // Negative Prompt
        var negRow = paramPanel.add("group {orientation:'column', alignChildren:['fill','top'], spacing:3}");
        negRow.add("statictext", undefined, "Negative Prompt:");
        var negTxt = negRow.add("edittext", undefined, "", {multiline:true, scrolling:true});
        negTxt.preferredSize = [520, 40];

        var edit = grp.add("edittext", undefined, "", {multiline:true, scrolling:true});
        edit.preferredSize = [540, 200];

        win.layout.layout(true);
        win.onResizing = win.onResize = function() { win.layout.resize(); };

        // ---------- Variables ----------
        var currentPrompt = null;    // For API execution
        var lastPath = null;

        // ---------- Helpers ----------
        function countProperties(obj) {
            var count = 0;
            for (var key in obj) {
                if (obj.hasOwnProperty(key)) {
                    count++;
                }
            }
            return count;
        }

        function clearParameters() {
            seedTxt.text = "";
            stepsTxt.text = "";
            cfgTxt.text = "";
            samplerTxt.text = "";
            schedulerTxt.text = "";
            sizeTxt.text = "";
            denoiseTxt.text = "";
            modelTxt.text = "";
            posTxt.text = "";
            negTxt.text = "";
        }

        function extractParameters(workflow, prompt) {
            clearParameters();
            
            // Try to extract from API prompt first (more structured)
            if (prompt) {
                try {
                    // Pass 1: KSampler / KSamplerAdvanced wins for sampler params
                    for (var nodeId in prompt) {
                        if (!prompt.hasOwnProperty(nodeId)) continue;
                        var node = prompt[nodeId];
                        var inputs = node.inputs || {};
                        var classType = node.class_type || "";
                        
                        if (classType === "KSampler" || classType === "KSamplerAdvanced") {
                            if (inputs.seed !== undefined) seedTxt.text = String(inputs.seed);
                            if (inputs.steps !== undefined) stepsTxt.text = String(inputs.steps);
                            if (inputs.cfg !== undefined) cfgTxt.text = String(inputs.cfg);
                            if (inputs.sampler_name !== undefined) samplerTxt.text = String(inputs.sampler_name);
                            if (inputs.scheduler !== undefined) schedulerTxt.text = String(inputs.scheduler);
                            if (inputs.denoise !== undefined) denoiseTxt.text = String(inputs.denoise);
                        }
                    }
                    
                    // Pass 2: Flux / other nodes — only fill fields still empty
                    for (var nodeId in prompt) {
                        if (!prompt.hasOwnProperty(nodeId)) continue;
                        var node = prompt[nodeId];
                        var inputs = node.inputs || {};
                        var classType = node.class_type || "";
                        
                        // RandomNoise: seed for Flux2 workflows
                        if (classType === "RandomNoise") {
                            if (!seedTxt.text && inputs.noise_seed !== undefined) seedTxt.text = String(inputs.noise_seed);
                        }
                        
                        // KSamplerSelect and other *Sampler* nodes: sampler fallback
                        if (classType !== "KSampler" && classType !== "KSamplerAdvanced" && /Sampler/i.test(classType)) {
                            if (!samplerTxt.text && inputs.sampler_name !== undefined) samplerTxt.text = String(inputs.sampler_name);
                        }
                        
                        // Flux2Scheduler: steps + size
                        if (classType === "Flux2Scheduler") {
                            if (!stepsTxt.text && inputs.steps !== undefined) stepsTxt.text = String(inputs.steps);
                            if (!sizeTxt.text && inputs.width !== undefined && inputs.height !== undefined &&
                                typeof inputs.width === "number" && typeof inputs.height === "number") {
                                sizeTxt.text = inputs.width + " x " + inputs.height;
                            }
                        }
                        
                        // Latent image nodes: size
                        if (classType === "EmptyLatentImage" || classType === "EmptySD3LatentImage" || classType === "EmptyFlux2LatentImage") {
                            if (!sizeTxt.text && inputs.width !== undefined && inputs.height !== undefined) {
                                sizeTxt.text = inputs.width + " x " + inputs.height;
                            }
                        }
                        
                        // LatentUpscale / LatentUpscaleBy: size fallback
                        if (classType === "LatentUpscale" || classType === "LatentUpscaleBy") {
                            if (!sizeTxt.text && inputs.width !== undefined && inputs.height !== undefined) {
                                sizeTxt.text = inputs.width + " x " + inputs.height;
                            }
                        }
                        
                        // Checkpoint loaders: model
                        if (classType === "CheckpointLoaderSimple" || classType === "CheckpointLoader") {
                            if (!modelTxt.text && inputs.ckpt_name !== undefined) modelTxt.text = String(inputs.ckpt_name);
                        }
                        
                        // UNETLoader: model fallback for Flux
                        if (classType === "UNETLoader") {
                            if (!modelTxt.text && inputs.unet_name !== undefined) modelTxt.text = String(inputs.unet_name);
                        }
                        
                        // CLIPTextEncodeFlux: positive prompt for Flux1
                        if (classType === "CLIPTextEncodeFlux") {
                            var text = String(inputs.clip_l || "");
                            if (text && !posTxt.text) posTxt.text = text;
                        }
                        
                        // CLIPTextEncode: positive / negative
                        if (classType === "CLIPTextEncode") {
                            var text = String(inputs.text || "");
                            if (text && !posTxt.text) {
                                posTxt.text = text;
                            } else if (text && !negTxt.text) {
                                negTxt.text = text;
                            }
                        }
                    }
                } catch(e) {}
            }
            
            // If prompt extraction failed, try workflow (UI format)
            if (workflow && !seedTxt.text) {
                try {
                    var nodes = workflow.nodes || [];
                    for (var i = 0; i < nodes.length; i++) {
                        var node = nodes[i];
                        var type = node.type || "";
                        var widgets = node.widgets_values || [];
                        
                        // KSampler / KSamplerAdvanced
                        // widgets: [seed, control_after_generate, steps, cfg, sampler_name, scheduler, denoise]
                        if (type === "KSampler" || type === "KSamplerAdvanced") {
                            if (widgets.length >= 7) {
                                if (!seedTxt.text) seedTxt.text = String(widgets[0]);
                                if (!stepsTxt.text) stepsTxt.text = String(widgets[2]);
                                if (!cfgTxt.text) cfgTxt.text = String(widgets[3]);
                                if (!samplerTxt.text) samplerTxt.text = String(widgets[4]);
                                if (!schedulerTxt.text) schedulerTxt.text = String(widgets[5]);
                                if (!denoiseTxt.text) denoiseTxt.text = String(widgets[6]);
                            }
                        }
                        
                        // RandomNoise: [noise_seed, control_after_generate]
                        if (type === "RandomNoise" && widgets.length >= 1) {
                            if (!seedTxt.text) seedTxt.text = String(widgets[0]);
                        }
                        
                        // KSamplerSelect: [sampler_name]
                        if (type === "KSamplerSelect" && widgets.length >= 1) {
                            if (!samplerTxt.text) samplerTxt.text = String(widgets[0]);
                        }
                        
                        // Flux2Scheduler: [steps, width, height]
                        if (type === "Flux2Scheduler" && widgets.length >= 3) {
                            if (!stepsTxt.text) stepsTxt.text = String(widgets[0]);
                            if (!sizeTxt.text) sizeTxt.text = widgets[1] + " x " + widgets[2];
                        }
                        
                        // Latent image nodes: [width, height, batch_size]
                        if ((type === "EmptyLatentImage" || type === "EmptySD3LatentImage" || type === "EmptyFlux2LatentImage") && widgets.length >= 2) {
                            if (!sizeTxt.text) sizeTxt.text = widgets[0] + " x " + widgets[1];
                        }
                        
                        // Checkpoint loaders: [ckpt_name]
                        if ((type === "CheckpointLoaderSimple" || type === "CheckpointLoader") && widgets.length >= 1) {
                            if (!modelTxt.text) modelTxt.text = String(widgets[0]);
                        }
                        
                        // UNETLoader: [unet_name, weight_dtype]
                        if (type === "UNETLoader" && widgets.length >= 1) {
                            if (!modelTxt.text) modelTxt.text = String(widgets[0]);
                        }
                        
                        // CLIPTextEncodeFlux: [clip_l, t5xxl, guidance]
                        if (type === "CLIPTextEncodeFlux" && widgets.length >= 1) {
                            var text = String(widgets[0]);
                            if (text && !posTxt.text) posTxt.text = text;
                        }
                        
                        // CLIPTextEncode: [text]
                        if (type === "CLIPTextEncode" && widgets.length >= 1) {
                            var text = String(widgets[0]);
                            if (text && !posTxt.text) {
                                posTxt.text = text;
                            } else if (text && !negTxt.text) {
                                negTxt.text = text;
                            }
                        }
                    }
                } catch(e) {}
            }
        }

        function setStatus(s, isSuccess){
            statusText.text = s;
            if (isSuccess === true) {
                statusText.graphics.foregroundColor = statusText.graphics.newPen(statusText.graphics.PenType.SOLID_COLOR, [0, 0.8, 0], 1);
            } else if (isSuccess === false) {
                statusText.graphics.foregroundColor = statusText.graphics.newPen(statusText.graphics.PenType.SOLID_COLOR, [0.8, 0.3, 0], 1);
            } else {
                statusText.graphics.foregroundColor = statusText.graphics.newPen(statusText.graphics.PenType.SOLID_COLOR, [0.7, 0.7, 0.7], 1);
            }
        }

        function getSelectedFootagePath(){
            try {
                var item = app.project.activeItem;
                if (!item || !(item instanceof CompItem)) return null;
                var L = item.selectedLayers;
                if (!L || L.length === 0) return null;
                var src = L[0].source;
                if (!src || !(src instanceof FootageItem)) return null;
                if (!src.file || !src.file.exists) return null;
                var ext = (""+src.file.name).toLowerCase().split(".").pop();
                if (ext !== "png") return null;
                return src.file.fsName;
            } catch(e) { return null; }
        }

        function browsePNG(){
            var f = File.openDialog("Select a PNG with ComfyUI metadata", "PNG:*.png", false);
            return (f && f.exists) ? f.fsName : null;
        }

        // ---------- PNG Parsing (OPTIMIZED) ----------
        function readPNGTextChunks(path){
            var f = new File(path);
            if (!f.exists) throw new Error("File not found: " + path);
            f.encoding = "BINARY";
            if (!f.open("r")) throw new Error("Cannot open file.");
            
            function readBytes(n){
                var arr = [];
                for (var i=0;i<n;i++){
                    if (f.eof) break;
                    var ch = f.readch();
                    arr.push(ch.charCodeAt(0) & 0xFF);
                }
                return arr;
            }
            
            function toUInt32BE(b, i){
                return ((b[i]<<24)>>>0) + (b[i+1]<<16) + (b[i+2]<<8) + b[i+3];
            }
            
            function bytesToString(b, start, len){
                var s = "";
                var end = (typeof len === "number") ? (start+len) : b.length;
                for (var i=start;i<end;i++) s += String.fromCharCode(b[i]);
                return s;
            }

            // Verify PNG signature
            var sig = readBytes(8);
            var pngSig = [137,80,78,71,13,10,26,10];
            for (var si=0; si<8; si++) {
                if (sig[si] !== pngSig[si]) {
                    f.close();
                    throw new Error("Not a valid PNG file.");
                }
            }

            var results = [];
            var sawIEND = false;
            var maxChunks = 200; // Safety limit

            while (!f.eof && !sawIEND && results.length < maxChunks){
                var lenBytes = readBytes(4);
                if (lenBytes.length < 4) break;
                
                var len = toUInt32BE(lenBytes, 0);
                
                var typeBytes = readBytes(4);
                if (typeBytes.length < 4) break;
                
                var type = bytesToString(typeBytes, 0, 4);
                
                // Only read data for text chunks to save memory/time
                if (type === "tEXt" || type === "iTXt") {
                    var data = (len>0) ? readBytes(len) : [];
                    readBytes(4); // CRC

                    if (type === "tEXt"){
                        var nulIndex = -1;
                        for (var i=0;i<data.length;i++){ if (data[i]===0){ nulIndex=i; break; } }
                        var keyword = (nulIndex>=0) ? bytesToString(data,0,nulIndex) : "(no-keyword)";
                        var text    = (nulIndex>=0) ? bytesToString(data,nulIndex+1) : bytesToString(data,0);
                        results.push({type:type, keyword:keyword, text:text, note:""});
                    } else if (type === "iTXt"){
                        var p=0;
                        var kEnd = -1;
                        for (var j=p;j<data.length;j++){ if (data[j]===0){ kEnd=j; break; } }
                        var keyword = bytesToString(data,p,kEnd-p); p=kEnd+1;
                        var compFlag = data[p++];
                        var compMethod = data[p++];
                        var langEnd = -1; for (j=p;j<data.length;j++){ if (data[j]===0){ langEnd=j; break; } }
                        var langTag = bytesToString(data,p,langEnd-p); p=langEnd+1;
                        var transEnd = -1; for (j=p;j<data.length;j++){ if (data[j]===0){ transEnd=j; break; } }
                        var transKW = bytesToString(data,p,transEnd-p); p=transEnd+1;
                        
                        if (compFlag === 1){
                            results.push({type:type, keyword:keyword, text:"<compressed iTXt>", note:"compressed"});
                        } else {
                            var text = bytesToString(data,p);
                            results.push({type:type, keyword:keyword, text:text, note:""});
                        }
                    }
                } else if (type === "zTXt"){
                    var data = (len>0) ? readBytes(len) : [];
                    readBytes(4); // CRC
                    var znul = -1;
                    for (var zi=0;zi<data.length;zi++){ if (data[zi]===0){ znul=zi; break; } }
                    var zkeyword = (znul>=0) ? bytesToString(data,0,znul) : "(no-keyword)";
                    results.push({type:type, keyword:zkeyword, text:"<compressed zTXt>", note:"compressed"});
                } else if (type === "IEND"){
                    sawIEND = true;
                    break;
                } else {
                    // Skip non-text chunks quickly
                    f.seek(len + 4, 1); // Skip data + CRC relative to current position
                }
            }

            f.close();
            return results;
        }

        function extractComfyData(chunks){
            var workflow = null;
            var prompt = null;
            
            for (var i=0;i<chunks.length;i++){
                var c = chunks[i];
                var kw = (c.keyword||"").toLowerCase();
                var t = c.text || "";
                
                // Try to extract workflow
                if (kw === "workflow" && t.charAt(0) === "{") {
                    try {
                        workflow = JSON.parse(t);
                    } catch(e) {}
                }
                
                // Try to extract prompt
                if (kw === "prompt" && t.charAt(0) === "{") {
                    try {
                        prompt = JSON.parse(t);
                    } catch(e) {}
                }
                
                // Early exit if we found both
                if (workflow && prompt) break;
            }
            
            if (workflow || prompt) {
                return {
                    workflow: workflow,
                    prompt: prompt
                };
            }
            
            return null;
        }

        // ---------- Actions ----------
        function runOnPath(path){
            try{
                if (path === lastPath && currentPrompt) {
                    return;
                }
                
                setStatus("Reading PNG metadata...", null);
                var chunks = readPNGTextChunks(path);
                
                if (!chunks || chunks.length===0){
                    edit.text = "No text chunks found in PNG file.\n\nThis image may not contain ComfyUI metadata.";
                    setStatus("No metadata found", false);
                    currentPrompt = null;
                    lastPath = null;
                    return;
                }
                
                var data = extractComfyData(chunks);
                
                if (data) {
                    currentPrompt = data.prompt;
                    lastPath = path;
                    
                    // Extract parameters and display
                    extractParameters(data.workflow, data.prompt);
                    
                    // Display API prompt JSON
                    var output = "";
                    
                    if (data.prompt) {
                        output += JSON.stringify(data.prompt, null, 2);
                    } else {
                        output += "No API Prompt found in this image.\n\n";
                        if (data.workflow) {
                            output += "Note: This image contains workflow data but no API prompt.";
                        }
                    }
                    
                    edit.text = output;
                    
                    // Show what was found in status
                    if (data.prompt) {
                        setStatus("API Prompt loaded", true);
                    } else {
                        setStatus("No API prompt in image", false);
                    }
                } else {
                    var output = "No ComfyUI workflow data found\n\n";
                    output += "Found " + chunks.length + " text chunks:\n\n";
                    
                    for (var j=0;j<chunks.length;j++){
                        var c = chunks[j];
                        output += "// [" + c.type + "] " + (c.keyword||"") + "\n";
                        output += c.text.substring(0, 200) + "\n\n";
                    }
                    
                    edit.text = output;
                    setStatus("No ComfyUI data in this PNG", false);
                    clearParameters();
                    currentPrompt = null;
                    lastPath = null;
                }
            }catch(e){
                edit.text = "Error: " + e.message + "\n\n" + e.toString();
                setStatus("Error reading file", false);
                clearParameters();
                currentPrompt = null;
                lastPath = null;
            }
        }

        function autoRefresh() {
            var p = getSelectedFootagePath();
            if (p && p !== lastPath) {
                runOnPath(p);
            } else if (!p && lastPath) {
                edit.text = "Select a PNG layer to view ComfyUI workflow data.";
                setStatus("No layer selected", null);
                clearParameters();
                currentPrompt = null;
                lastPath = null;
            }
        }

        // ---------- Button Handlers ----------
        btnSelected.onClick = function(){
            var p = getSelectedFootagePath();
            if (!p){ 
                alert("Please select a PNG footage layer in an active composition first."); 
                return; 
            }
            runOnPath(p);
        };

        btnBrowse.onClick = function(){
            var p = browsePNG();
            if (p) runOnPath(p);
        };

        btnRefresh.onClick = function(){
            autoRefresh();
        };

        btnCopyAPI.onClick = function(){
            if (!currentPrompt) {
                alert("No API prompt data loaded. Select a ComfyUI PNG first.");
                return;
            }
            
            try {
                var tempFile = new File(Folder.temp + "/comfyui_prompt_" + new Date().getTime() + ".json");
                tempFile.encoding = "UTF-8";
                tempFile.open("w");
                tempFile.write(JSON.stringify(currentPrompt, null, 2));
                tempFile.close();
                
                system.callSystem('type "' + tempFile.fsName + '" | clip');
                
                tempFile.remove();
                
                setStatus("API prompt copied to clipboard!", true);
            } catch(e) {
                alert("Error copying to clipboard: " + e.message);
            }
        };

        btnSaveAPI.onClick = function(){
            if (!currentPrompt) {
                alert("No API prompt data to save. Select a ComfyUI PNG first.");
                return;
            }
            
            var out = File.saveDialog("Save ComfyUI API Prompt", "JSON:*.json");
            if (!out) return;
            
            try {
                out.encoding = "UTF-8";
                out.open("w");
                out.write(JSON.stringify(currentPrompt, null, 2));
                out.close();
                
                setStatus("API prompt saved: " + out.name, true);
            } catch(e) {
                alert("Error saving file: " + e.message);
            }
        };

        // Auto-refresh on panel show
        if (win instanceof Panel) {
            win.onShow = function() {
                autoRefresh();
            };
        }

        // Removed idle event listener - causes slowdown
        // Use Refresh button for manual updates

        return win;
    }

    var myUI = buildUI(thisObj);
    if (myUI instanceof Window) {
        myUI.center();
        myUI.show();
    }

})(this);
