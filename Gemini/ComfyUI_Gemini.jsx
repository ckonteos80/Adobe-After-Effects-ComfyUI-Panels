/* ComfyUI CloudGen Panel — Cloud image generation via ComfyUI
   Routes prompts and reference images to Google Gemini (Nano Banana / Nano Banana Pro)
   through a local ComfyUI instance. All required nodes (GeminiImageNode, GeminiImage2Node,
   BatchImagesNode) are built into ComfyUI — no custom pack required.
   Generation is billed via ComfyUI credits (platform.comfy.org), not a Google API key.

   Pure ExtendScript + Socket HTTP; no script-level dependencies.
   Requires: ComfyUI running locally on the configured host/port.
*/

(function(thisObj) {

  // ============================================================
  // CONSTANTS
  // ============================================================
  var DEFAULT_HOST = "127.0.0.1";
  var DEFAULT_PORT = "8000";
  var POLL_MS = 1000;

  var SETTINGS_FILE = new File(Folder.userData.fsName + "/ComfyCloudGen_Settings.json");
  var LOG = new File(Folder.temp.fsName + "/Comfy_CloudGen_Panel.log");
  var RENDER_TEMPLATE_NAME = "PNG After 2 Comfy";

  // Image-footage extension filter (matches existing I2I panel)
  var IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp|bmp)$/i;

  // Special dropdown entry strings
  var KIND_NONE          = "(none)";
  var KIND_TOP_IMAGE     = "[Top image layer]";
  var KIND_LOWEST_IMAGE  = "[Lowest image layer]";

  var PROMPT_SRC_TYPED       = "Type prompt";
  var PROMPT_SRC_TOP_TEXT    = "[Top text layer]";
  // ============================================================
  // NAMESPACE
  // ============================================================
  if (!$._comfyCloudGenPanel) {
    $._comfyCloudGenPanel = {};
  }

  // ============================================================
  // LOGGING
  // ============================================================
  function log(s){
    try{
      if (!LOG) return;
      LOG.encoding = "UTF-8";
      if (!LOG.open("a")) return;
      LOG.writeln(new Date().toISOString() + "  " + s);
      LOG.close();
    } catch(e) {}
  }
  log("=== CloudGen Panel initialized ===");

  // ============================================================
  // SETTINGS PERSISTENCE
  // ============================================================
  function loadSettings(){
    var defaults = {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      outputFolder: "",
      lastModel: "nano_banana_pro",
      lastMode: "t2i",
      lastAspect: "match_comp",
      lastResolution: "1K",
      lastVariations: 1,
      sessionCost: 0,
      apiKey: "",
      googleApiKey: "",
      aeProjectFolder: "",
      filenamePrefix: "CloudGen",
      renderTemplateName: "PNG After 2 Comfy"
    };
    if (!SETTINGS_FILE.exists) return defaults;
    try {
      if (SETTINGS_FILE.open("r")) {
        var json = SETTINGS_FILE.read();
        SETTINGS_FILE.close();
        if (!json) return defaults;
        var s = JSON.parse(json);
        // Merge with defaults for missing keys
        for (var k in defaults) if (defaults.hasOwnProperty(k) && s[k] === undefined) s[k] = defaults[k];
        return s;
      }
    } catch(e){ log("Failed to load settings: " + e); }
    return defaults;
  }

  function saveSettings(s){
    try {
      if (SETTINGS_FILE.open("w")) {
        SETTINGS_FILE.write(JSON.stringify(s));
        SETTINGS_FILE.close();
      }
    } catch(e){ log("Failed to save settings: " + e); }
  }

  // ============================================================
  // UTILITY HELPERS
  // ============================================================
  function die(msg, detail){
    log("FAIL: " + msg + " :: " + (detail || ""));
    throw new Error(msg);
  }
  function sleep(ms){ $.sleep(ms); }
  function rand32(){
    var n = Math.floor(Math.random() * 0x7FFFFFFF);
    if (n < 0) n = 0;
    return n;
  }
  function basename(p){ return String(p).replace(/^[\\\/]+/,"").split(/[\\\/]/).pop(); }
  function extOK(path){ return IMAGE_EXT_RE.test(path); }
  function deepCopy(o){ return JSON.parse(JSON.stringify(o)); }
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
  function arrIndexOf(arr, val){
    for (var i = 0; i < arr.length; i++) if (arr[i] === val) return i;
    return -1;
  }
  function arrContains(arr, val){ return arrIndexOf(arr, val) >= 0; }

  // ============================================================
  // HTTP LAYER (Socket-based, plain HTTP to local ComfyUI)
  // ============================================================
  function httpRequest(method, path, headers, bodyStr, wantBinary, allowErrors, host, port){
    var s = new Socket();
    s.timeout = 5;
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
    } else { req += CRLF; s.write(req); }
    var raw = readAll(s);
    s.close();
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

  function httpRequestBinary(method, path, headers, bodyBinary, wantBinary, allowErrors, host, port){
    var s = new Socket();
    s.timeout = 5;
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
    var first = head.split("\r\n")[0]; var m = first.match(/^HTTP\/\d\.\d\s+(\d+)/);
    var status = m?parseInt(m[1],10):0;
    if (!allowErrors && (status<200 || status>=300)) die("HTTP "+status+" for "+path, body);
    return { status: status, body: wantBinary ? body : body.toString() };
  }

  function httpPostPrompt(promptObj, host, port, apiKey){
    var body = { prompt: promptObj };
    if (apiKey) body.extra_data = { api_key_comfy_org: apiKey };
    var payload = JSON.stringify(body);
    var r = httpRequest("POST", "/prompt", {"Content-Type":"application/json"}, payload, false, true, host, port);
    if (r.status < 200 || r.status >= 300) {
      die("ComfyUI rejected workflow (HTTP "+r.status+"). Response: " + (r.body || "").substring(0, 500), r.body);
    }
    try { return JSON.parse(r.body); } catch(e){ die("JSON parse error from POST /prompt", r.body); }
  }

  function httpHistoryMaybe(promptId, host, port){
    var r = httpRequest("GET", "/history/" + promptId, {"Accept":"application/json"}, null, false, true, host, port);
    if (r.status !== 200 || !r.body) return null;
    try { return JSON.parse(r.body); } catch(e){
      log("History parse error (will retry): " + r.body.substring(0, 100));
      return null;
    }
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
    outFile.write(r.body);
    outFile.close();
    if(!outFile.exists) die("Download failed:\n"+outFile.fsName);
  }

  function httpUploadImage(sourceFile, host, port){
    var file = new File(sourceFile);
    if (!file.exists) die("Source image does not exist:\n"+file.fsName);
    if (!extOK(file.name)) die("Unsupported image type (use PNG/JPG/WEBP/BMP): " + file.name);
    file.encoding = "BINARY";
    if (!file.open("r")) die("Cannot read source file:\n"+file.fsName);
    var fileData = file.read();
    file.close();

    var boundary = "----AECloudGenBoundary" + Math.floor(Math.random()*1000000);
    var CRLF = "\r\n";
    var bodyPrefix = "";
    bodyPrefix += "--" + boundary + CRLF;
    bodyPrefix += 'Content-Disposition: form-data; name="image"; filename="' + basename(file.name) + '"' + CRLF;
    bodyPrefix += "Content-Type: application/octet-stream" + CRLF + CRLF;
    var bodySuffix = CRLF + "--" + boundary + "--" + CRLF;

    var prefixBin = "";
    for (var i = 0; i < bodyPrefix.length; i++) prefixBin += String.fromCharCode(bodyPrefix.charCodeAt(i) & 0xFF);
    var suffixBin = "";
    for (var j = 0; j < bodySuffix.length; j++) suffixBin += String.fromCharCode(bodySuffix.charCodeAt(j) & 0xFF);

    var fullBody = prefixBin + fileData + suffixBin;
    log("Uploading: " + file.name + " (" + fullBody.length + " bytes)");

    var headers = { "Content-Type": "multipart/form-data; boundary=" + boundary };
    var r = httpRequestBinary("POST", "/upload/image", headers, fullBody, false, false, host, port);
    try {
      var result = JSON.parse(r.body);
      if (!result || !result.name) die("Upload failed — no filename returned", r.body);
      log("Upload OK: " + result.name);
      return result.name;
    } catch(e) { die("JSON parse error from /upload/image", r.body); }
  }

  // ============================================================
  // BUNDLED WORKFLOWS (embedded inline; reference copies on disk)
  // ============================================================
  // Each workflow uses "__PROMPT__" and "__SLOT_N__" markers replaced at submit time.
  var WORKFLOW_NANO_BANANA_T2I = {
    "5": {
      "inputs": {
        "prompt": "__PROMPT__",
        "model": "gemini-2.5-flash-image-preview",
        "seed": 0,
        "aspect_ratio": "auto",
        "response_modalities": "IMAGE",
        "system_prompt": "You are an expert image-generation engine. You must ALWAYS produce an image.\nInterpret all user input—regardless of format, intent, or abstraction—as literal visual directives for image composition.\nIf a prompt is conversational or lacks specific visual details, you must creatively invent a concrete visual scenario that depicts the concept.\nPrioritize generating the visual representation above any text, formatting, or conversational requests."
      },
      "class_type": "GeminiImageNode",
      "_meta": { "title": "Nano Banana (Google Gemini Image)" }
    },
    "30": {
      "inputs": { "filename_prefix": "CloudGen", "images": ["5", 0] },
      "class_type": "SaveImage",
      "_meta": { "title": "Save Image" }
    }
  };

  var WORKFLOW_NANO_BANANA_I2I = {
    "5": {
      "inputs": {
        "prompt": "__PROMPT__",
        "model": "gemini-2.5-flash-image-preview",
        "seed": 0,
        "aspect_ratio": "auto",
        "response_modalities": "IMAGE",
        "system_prompt": "You are an expert image-generation engine. You must ALWAYS produce an image.\nInterpret all user input—regardless of format, intent, or abstraction—as literal visual directives for image composition.\nIf a prompt is conversational or lacks specific visual details, you must creatively invent a concrete visual scenario that depicts the concept.\nPrioritize generating the visual representation above any text, formatting, or conversational requests.",
        "images": ["34", 0]
      },
      "class_type": "GeminiImageNode",
      "_meta": { "title": "Nano Banana (Google Gemini Image)" }
    },
    "30": { "inputs": { "filename_prefix": "CloudGen", "images": ["5", 0] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } },
    "33": { "inputs": { "image": "__SLOT_0__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 0)" } },
    "35": { "inputs": { "image": "__SLOT_1__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 1)" } },
    "38": { "inputs": { "image": "__SLOT_2__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 2)" } },
    "36": { "inputs": { "image": "__SLOT_3__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 3)" } },
    "37": { "inputs": { "image": "__SLOT_4__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 4)" } },
    "34": {
      "inputs": {
        "images.image0": ["33", 0],
        "images.image1": ["35", 0],
        "images.image2": ["38", 0],
        "images.image3": ["36", 0],
        "images.image4": ["37", 0]
      },
      "class_type": "BatchImagesNode",
      "_meta": { "title": "Batch Images" }
    }
  };

  var WORKFLOW_NANO_BANANA_PRO_T2I = {
    "35": {
      "inputs": {
        "prompt": "__PROMPT__",
        "model": "gemini-3-pro-image-preview",
        "seed": 0,
        "aspect_ratio": "1:1",
        "resolution": "1K",
        "response_modalities": "IMAGE",
        "system_prompt": "You are an expert image-generation engine. You must ALWAYS produce an image.\nInterpret all user input—regardless of format, intent, or abstraction—as literal visual directives for image composition.\nIf a prompt is conversational or lacks specific visual details, you must creatively invent a concrete visual scenario that depicts the concept.\nPrioritize generating the visual representation above any text, formatting, or conversational requests."
      },
      "class_type": "GeminiImage2Node",
      "_meta": { "title": "Nano Banana Pro (Google Gemini Image)" }
    },
    "30": { "inputs": { "filename_prefix": "CloudGen", "images": ["35", 0] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } }
  };

  var WORKFLOW_NANO_BANANA_PRO_I2I = {
    "35": {
      "inputs": {
        "prompt": "__PROMPT__",
        "model": "gemini-3-pro-image-preview",
        "seed": 0,
        "aspect_ratio": "1:1",
        "resolution": "1K",
        "response_modalities": "IMAGE",
        "system_prompt": "You are an expert image-generation engine. You must ALWAYS produce an image.\nInterpret all user input—regardless of format, intent, or abstraction—as literal visual directives for image composition.\nIf a prompt is conversational or lacks specific visual details, you must creatively invent a concrete visual scenario that depicts the concept.\nPrioritize generating the visual representation above any text, formatting, or conversational requests.",
        "images": ["36", 0]
      },
      "class_type": "GeminiImage2Node",
      "_meta": { "title": "Nano Banana Pro (Google Gemini Image)" }
    },
    "30": { "inputs": { "filename_prefix": "CloudGen", "images": ["35", 0] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } },
    "11": { "inputs": { "image": "__SLOT_0__"  }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 0)"  } },
    "37": { "inputs": { "image": "__SLOT_1__"  }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 1)"  } },
    "40": { "inputs": { "image": "__SLOT_2__"  }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 2)"  } },
    "38": { "inputs": { "image": "__SLOT_3__"  }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 3)"  } },
    "39": { "inputs": { "image": "__SLOT_4__"  }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 4)"  } },
    "43": { "inputs": { "image": "__SLOT_5__"  }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 5)"  } },
    "42": { "inputs": { "image": "__SLOT_6__"  }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 6)"  } },
    "41": { "inputs": { "image": "__SLOT_7__"  }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 7)"  } },
    "44": { "inputs": { "image": "__SLOT_8__"  }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 8)"  } },
    "45": { "inputs": { "image": "__SLOT_9__"  }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 9)"  } },
    "46": { "inputs": { "image": "__SLOT_10__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 10)" } },
    "47": { "inputs": { "image": "__SLOT_11__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 11)" } },
    "48": { "inputs": { "image": "__SLOT_12__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 12)" } },
    "49": { "inputs": { "image": "__SLOT_13__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 13)" } },
    "36": {
      "inputs": {
        "images.image0":  ["11", 0],
        "images.image1":  ["37", 0],
        "images.image2":  ["40", 0],
        "images.image3":  ["38", 0],
        "images.image4":  ["39", 0],
        "images.image5":  ["43", 0],
        "images.image6":  ["42", 0],
        "images.image7":  ["41", 0],
        "images.image8":  ["44", 0],
        "images.image9":  ["45", 0],
        "images.image10": ["46", 0],
        "images.image11": ["47", 0],
        "images.image12": ["48", 0],
        "images.image13": ["49", 0]
      },
      "class_type": "BatchImagesNode",
      "_meta": { "title": "Batch Images" }
    }
  };

  var WORKFLOW_NB_PM_T2I = {
    "2": {
      "inputs": {
        "prompt": "",
        "model": "gemini-2.5-flash-image-preview",
        "aspect_ratio": "1:1",
        "image_size": "4K",
        "seed": 0,
        "randomize_seed": false,
        "api_key": "",
        "system_prompt": "You are an expert image composition engine. Use the reference images to understand the visual style, character traits, and composition goals. Generate a new image that matches the described scenario.",
        "safety_threshold": "BLOCK_ONLY_HIGH"
      },
      "class_type": "GoogleAI_NanoBananaNode",
      "_meta": { "title": "Google AI - Nano Banana (PromptModel)" }
    },
    "3": {
      "inputs": { "filename_prefix": "CloudGen", "images": ["2", 0] },
      "class_type": "SaveImage",
      "_meta": { "title": "Save Image" }
    }
  };

  var WORKFLOW_NB_PM_I2I = {
    "2": {
      "inputs": {
        "prompt": "",
        "model": "gemini-2.5-flash-image-preview",
        "aspect_ratio": "1:1",
        "image_size": "4K",
        "seed": 0,
        "randomize_seed": false,
        "api_key": "",
        "system_prompt": "You are an expert image composition engine. Use the reference images to understand the visual style, character traits, and composition goals. Generate a new image that matches the described scenario.",
        "safety_threshold": "BLOCK_ONLY_HIGH",
        "image_1": ["4", 0],
        "image_2": ["5", 0],
        "image_3": ["6", 0],
        "image_4": ["7", 0],
        "image_5": ["8", 0]
      },
      "class_type": "GoogleAI_NanoBananaNode",
      "_meta": { "title": "Google AI - Nano Banana (PromptModel)" }
    },
    "4": { "inputs": { "image": "__SLOT_0__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 0)" } },
    "5": { "inputs": { "image": "__SLOT_1__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 1)" } },
    "6": { "inputs": { "image": "__SLOT_2__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 2)" } },
    "7": { "inputs": { "image": "__SLOT_3__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 3)" } },
    "8": { "inputs": { "image": "__SLOT_4__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 4)" } },
    "3": {
      "inputs": { "filename_prefix": "CloudGen", "images": ["2", 0] },
      "class_type": "SaveImage",
      "_meta": { "title": "Save Image" }
    }
  };

  var WORKFLOW_NB_PRO_PM_T2I = {
    "2": {
      "inputs": {
        "prompt": "",
        "model": "gemini-3-pro-image-preview",
        "aspect_ratio": "1:1",
        "image_size": "4K",
        "seed": 0,
        "randomize_seed": false,
        "api_key": "",
        "system_prompt": "You are an expert image composition engine. Use the reference images to understand the visual style, character traits, and composition goals. Generate a new image that matches the described scenario.",
        "safety_threshold": "BLOCK_ONLY_HIGH"
      },
      "class_type": "GoogleAI_NanoBananaNode",
      "_meta": { "title": "Google AI - Nano Banana Pro (PromptModel)" }
    },
    "3": {
      "inputs": { "filename_prefix": "CloudGen", "images": ["2", 0] },
      "class_type": "SaveImage",
      "_meta": { "title": "Save Image" }
    }
  };

  var WORKFLOW_NB_PRO_PM_I2I = {
    "2": {
      "inputs": {
        "prompt": "",
        "model": "gemini-3-pro-image-preview",
        "aspect_ratio": "1:1",
        "image_size": "4K",
        "seed": 0,
        "randomize_seed": false,
        "api_key": "",
        "system_prompt": "You are an expert image composition engine. Use the reference images to understand the visual style, character traits, and composition goals. Generate a new image that matches the described scenario.",
        "safety_threshold": "BLOCK_ONLY_HIGH",
        "image_1": ["4", 0],
        "image_2": ["5", 0],
        "image_3": ["6", 0],
        "image_4": ["7", 0],
        "image_5": ["8", 0]
      },
      "class_type": "GoogleAI_NanoBananaNode",
      "_meta": { "title": "Google AI - Nano Banana Pro (PromptModel)" }
    },
    "4": { "inputs": { "image": "__SLOT_0__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 0)" } },
    "5": { "inputs": { "image": "__SLOT_1__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 1)" } },
    "6": { "inputs": { "image": "__SLOT_2__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 2)" } },
    "7": { "inputs": { "image": "__SLOT_3__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 3)" } },
    "8": { "inputs": { "image": "__SLOT_4__" }, "class_type": "LoadImage", "_meta": { "title": "Load Image (slot 4)" } },
    "3": {
      "inputs": { "filename_prefix": "CloudGen", "images": ["2", 0] },
      "class_type": "SaveImage",
      "_meta": { "title": "Save Image" }
    }
  };

  // ============================================================
  // MODEL REGISTRY
  // ============================================================
  // Aspect ratio strings to (w/h) numeric ratios for matching.
  function aspectToRatio(aspStr){
    if (aspStr === "auto") return null;
    var m = aspStr.match(/^(\d+):(\d+)$/);
    if (!m) return null;
    return parseFloat(m[1]) / parseFloat(m[2]);
  }

  var MODELS = {
    "nano_banana": {
      displayName: "Nano Banana (ComfyUI)",
      modelString: "gemini-2.5-flash-image-preview",
      nodeClass: "GeminiImageNode",
      refCap: 5,
      t2iOnly: false,
      apiKeyType: "comfy",
      imageInputStyle: "batch",
      supportsResolution: false,
      resolutionParamName: "resolution",
      supportedResolutions: [],
      supportedAspects: ["auto","1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9"],
      creditsPerImage: { "1K": 8.2, "2K": 8.2, "4K": 8.2 },
      workflowT2I: WORKFLOW_NANO_BANANA_T2I,
      workflowI2I: WORKFLOW_NANO_BANANA_I2I,
      generatorNodeId: "5",
      saveNodeId: "30",
      batchNodeId: "34",
      loadImageNodeIdsBySlot: ["33","35","38","36","37"]
    },
    "nano_banana_pro": {
      displayName: "Nano Banana Pro (ComfyUI)",
      modelString: "gemini-3-pro-image-preview",
      nodeClass: "GeminiImage2Node",
      refCap: 14,
      t2iOnly: false,
      apiKeyType: "comfy",
      imageInputStyle: "batch",
      supportsResolution: true,
      resolutionParamName: "resolution",
      supportedResolutions: ["1K","2K","4K"],
      supportedAspects: ["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],
      creditsPerImage: { "1K": 28.3, "2K": 28.3, "4K": 50.5 },
      workflowT2I: WORKFLOW_NANO_BANANA_PRO_T2I,
      workflowI2I: WORKFLOW_NANO_BANANA_PRO_I2I,
      generatorNodeId: "35",
      saveNodeId: "30",
      batchNodeId: "36",
      loadImageNodeIdsBySlot: ["11","37","40","38","39","43","42","41","44","45","46","47","48","49"]
    },
    "nano_banana_pm": {
      displayName: "Nano Banana (PromptModel)",
      modelString: "gemini-2.5-flash-image-preview",
      nodeClass: "GoogleAI_NanoBananaNode",
      refCap: 5,
      t2iOnly: false,
      apiKeyType: "google",
      imageInputStyle: "direct",
      supportsResolution: true,
      resolutionParamName: "image_size",
      supportedResolutions: ["1K","2K","4K"],
      supportedAspects: ["auto","1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9"],
      creditsPerImage: {},
      workflowT2I: WORKFLOW_NB_PM_T2I,
      workflowI2I: WORKFLOW_NB_PM_I2I,
      generatorNodeId: "2",
      saveNodeId: "3",
      batchNodeId: null,
      loadImageNodeIdsBySlot: ["4","5","6","7","8"]
    },
    "nano_banana_pro_pm": {
      displayName: "Nano Banana Pro (PromptModel)",
      modelString: "gemini-3-pro-image-preview",
      nodeClass: "GoogleAI_NanoBananaNode",
      refCap: 5,
      t2iOnly: false,
      apiKeyType: "google",
      imageInputStyle: "direct",
      supportsResolution: true,
      resolutionParamName: "image_size",
      supportedResolutions: ["1K","2K","4K"],
      supportedAspects: ["1:1","3:2","2:3","3:4","4:3","4:5","5:4","9:16","16:9","21:9"],
      creditsPerImage: {},
      workflowT2I: WORKFLOW_NB_PRO_PM_T2I,
      workflowI2I: WORKFLOW_NB_PRO_PM_I2I,
      generatorNodeId: "2",
      saveNodeId: "3",
      batchNodeId: null,
      loadImageNodeIdsBySlot: ["4","5","6","7","8"]
    }
  };
  var MODEL_KEYS = ["nano_banana_pro","nano_banana","nano_banana_pro_pm","nano_banana_pm"]; // dropdown order

  function getModel(key){ return MODELS[key] || MODELS[MODEL_KEYS[0]]; }

  // ============================================================
  // ASPECT RATIO MATCHING
  // ============================================================
  function chooseClosestAspect(model, compRatio){
    // Find the aspect in model.supportedAspects whose w/h is closest to compRatio.
    // "auto" excluded from matching (it's a self-explaining choice for the Gemini 2.5 node).
    var best = null;
    var bestDiff = Infinity;
    for (var i = 0; i < model.supportedAspects.length; i++){
      var a = model.supportedAspects[i];
      var r = aspectToRatio(a);
      if (r === null) continue;
      var d = Math.abs(r - compRatio);
      if (d < bestDiff) { bestDiff = d; best = a; }
    }
    return best;
  }

  // ============================================================
  // AE HELPERS
  // ============================================================
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

  function setLayerInOut(layer, inPt, outPt, comp){
    if (!layer || !comp) return;
    layer.startTime = 0;
    layer.inPoint = Math.max(0, inPt);
    layer.outPoint = Math.min(outPt, comp.duration);
  }

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

  // Returns image-footage layers in stack order (index 1 first = topmost).
  function getImageLayers(comp){
    var out = [];
    if (!comp) return out;
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      if (!L.enabled) continue;
      if (L.source && typeof L.source.numLayers === "number"){
        out.push(L);           // precomp
      } else if (L.source && L.source.file && extOK(L.source.file.name)){
        out.push(L);           // footage with image extension
      }
    }
    return out;
  }

  // Returns enabled text layers in stack order (top first).
  function getTextLayers(comp){
    var out = [];
    if (!comp) return out;
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      if (!L.enabled) continue;
      if (!(L instanceof TextLayer)) continue;
      out.push(L);
    }
    return out;
  }

  function getTextLayerSourceText(layer){
    try {
      var srcProp = layer.property("ADBE Text Properties").property("ADBE Text Document");
      var doc = srcProp.value;
      return doc.text || "";
    } catch(e){ return ""; }
  }

  function isImageOutputFormat(fmt){
    var f = (fmt || "").toLowerCase();
    return f.indexOf("sequence") >= 0 ||
           f.indexOf("png")      >= 0 ||
           f.indexOf("tiff")     >= 0 ||
           f.indexOf("tif")      >= 0 ||
           f.indexOf("openexr")  >= 0 ||
           f.indexOf("exr")      >= 0 ||
           f.indexOf("dpx")      >= 0 ||
           f.indexOf("cineon")   >= 0 ||
           f.indexOf("targa")    >= 0 ||
           f.indexOf("jpeg")     >= 0 ||
           f.indexOf("jpg")      >= 0 ||
           f.indexOf("radiance") >= 0 ||
           f.indexOf("sgi")      >= 0 ||
           f.indexOf("iff")      >= 0;
  }

  function queryRenderTemplates(){
    if (!app.project) return [];
    var allNames = [];
    var probeComp = null, probeRI = null;
    try {
      var rq = app.project.renderQueue;
      if (rq.numItems > 0){
        allNames = [].concat(rq.item(1).outputModule(1).templates);
      } else {
        probeComp = app.project.items.addComp("__cg_tmpl_q__", 4, 4, 1, 1/24, 24);
        probeRI   = rq.items.add(probeComp);
        allNames  = [].concat(probeRI.outputModule(1).templates);
        probeRI.remove();   probeRI   = null;
        probeComp.remove(); probeComp = null;
      }
      probeComp = app.project.items.addComp("__cg_tmpl_q__", 4, 4, 1, 1/24, 24);
      probeRI   = rq.items.add(probeComp);
      var om    = probeRI.outputModule(1);
      var imageNames = [];
      for (var i = 0; i < allNames.length; i++){
        try {
          om.applyTemplate(allNames[i]);
          var fmt = om.getSettings(GetSettingsFormat.STRING_SETTABLE)["Format"] || "";
          if (!fmt) fmt = om.getSettings(GetSettingsFormat.STRING)["Format"] || "";
          if (isImageOutputFormat(fmt)) imageNames.push(allNames[i]);
        } catch(tmplErr){
          // Can't probe this template — include it so the user can still select it
          imageNames.push(allNames[i]);
        }
      }
      imageNames.sort();
      return imageNames;
    } catch(err){
      try { log("queryRenderTemplates failed"); } catch(_){}
      return [];
    } finally {
      try { if (probeRI)   probeRI.remove();   } catch(_){}
      try { if (probeComp) probeComp.remove(); } catch(_){}
    }
  }

  // The topmost image layer that is active at time t (or null if none).
  function findTopImageAt(imageLayers, t){
    for (var i = 0; i < imageLayers.length; i++){
      var L = imageLayers[i];
      if (L.inPoint <= t && t < L.outPoint) return L;
    }
    return null;
  }
  // The bottommost (highest index) image layer active at t (or null).
  function findLowestImageAt(imageLayers, t){
    for (var i = imageLayers.length - 1; i >= 0; i--){
      var L = imageLayers[i];
      if (L.inPoint <= t && t < L.outPoint) return L;
    }
    return null;
  }

  // The topmost (lowest index) text layer active at t (or null).
  function findTopTextAt(textLayers, t){
    for (var i = 0; i < textLayers.length; i++){
      var L = textLayers[i];
      if (L.inPoint <= t && t < L.outPoint) return L;
    }
    return null;
  }

  // Returns [{frame, periodEnd, topLayer}] — one entry each time the topmost image layer
  // changes within [workStart, workEnd). periodEnd = start of next transition or workEnd.
  function findImageTopTransitions(comp, workStart, workEnd){
    var imageLayers = getImageLayers(comp);
    var EPS = 0.0005;
    var times = [workStart, workEnd];
    for (var i = 0; i < imageLayers.length; i++){
      var ip = imageLayers[i].inPoint, op = imageLayers[i].outPoint;
      if (ip > workStart && ip < workEnd) times.push(ip);
      if (op > workStart && op < workEnd) times.push(op);
    }
    times.sort(function(a,b){ return a-b; });

    var transitions = [];
    var lastTop = null;
    for (var j = 0; j < times.length - 1; j++){
      if (times[j+1] - times[j] < EPS) continue;
      var top = findTopImageAt(imageLayers, (times[j] + times[j+1]) / 2);
      if (top !== lastTop){
        if (transitions.length > 0) transitions[transitions.length-1].periodEnd = times[j];
        if (top !== null) transitions.push({ frame: times[j], periodEnd: workEnd, topLayer: top });
        lastTop = top;
      }
    }
    return transitions;
  }

  // Returns [{frame, periodEnd, topTextLayer, prompt}] — one entry each time the topmost
  // text layer changes within [workStart, workEnd).
  function findTextTopTransitions(comp, workStart, workEnd){
    var textLayers = getTextLayers(comp);
    var EPS = 0.0005;
    var times = [workStart, workEnd];
    for (var i = 0; i < textLayers.length; i++){
      var ip = textLayers[i].inPoint, op = textLayers[i].outPoint;
      if (ip > workStart && ip < workEnd) times.push(ip);
      if (op > workStart && op < workEnd) times.push(op);
    }
    times.sort(function(a,b){ return a-b; });

    var transitions = [];
    var lastTop = null;
    for (var j = 0; j < times.length - 1; j++){
      if (times[j+1] - times[j] < EPS) continue;
      var top = findTopTextAt(textLayers, (times[j] + times[j+1]) / 2);
      if (top !== lastTop){
        if (transitions.length > 0) transitions[transitions.length-1].periodEnd = times[j];
        if (top !== null) transitions.push({ frame: times[j], periodEnd: workEnd, topTextLayer: top, prompt: getTextLayerSourceText(top) });
        lastTop = top;
      }
    }
    return transitions;
  }

  // Like findTextTopTransitions but also considers image layer transitions so that a
  // change in either the topmost text layer OR the topmost image ref starts a new segment.
  function findTextAndImageTopTransitions(comp, workStart, workEnd, activeSlots){
    var textLayers  = getTextLayers(comp);
    var imageLayers = getImageLayers(comp);
    var EPS = 0.0005;
    var times = [workStart, workEnd];
    var i;
    for (i = 0; i < textLayers.length; i++){
      var ti = textLayers[i];
      if (ti.inPoint  > workStart && ti.inPoint  < workEnd) times.push(ti.inPoint);
      if (ti.outPoint > workStart && ti.outPoint < workEnd) times.push(ti.outPoint);
    }
    for (i = 0; i < imageLayers.length; i++){
      var il = imageLayers[i];
      if (il.inPoint  > workStart && il.inPoint  < workEnd) times.push(il.inPoint);
      if (il.outPoint > workStart && il.outPoint < workEnd) times.push(il.outPoint);
    }
    times.sort(function(a,b){ return a-b; });

    var transitions = [];
    var lastKey = null;
    for (var j = 0; j < times.length - 1; j++){
      if (times[j+1] - times[j] < EPS) continue;
      var midT = (times[j] + times[j+1]) / 2;
      var topText = findTopTextAt(textLayers, midT);
      if (!topText) continue;
      var stateKey = String(topText.index);
      for (var s = 0; s < activeSlots.length; s++){
        var slot = activeSlots[s];
        var imgR = null;
        if      (slot.kind === "top")    imgR = findTopImageAt(imageLayers, midT);
        else if (slot.kind === "lowest") imgR = findLowestImageAt(imageLayers, midT);
        stateKey += ":" + (imgR ? String(imgR.index) : "null");
      }
      if (stateKey === lastKey && transitions.length > 0){
        transitions[transitions.length - 1].periodEnd = times[j + 1];
      } else {
        transitions.push({
          frame:        times[j],
          periodEnd:    times[j + 1],
          topTextLayer: topText,
          prompt:       getTextLayerSourceText(topText)
        });
        lastKey = stateKey;
      }
    }
    return transitions;
  }

  // Returns an array of {textLayer, prompt, window:{start,end}} covering the comp work
  // area, segmented by when the topmost-active text layer changes.
  function buildTopTextSources(comp){
    var textLayers = getTextLayers(comp);
    if (textLayers.length === 0) return [];
    var EPS = 0.0005;
    var events = {};
    var wsStart = comp.workAreaStart;
    var wsEnd   = comp.workAreaStart + comp.workAreaDuration;
    events[wsStart] = true;
    events[wsEnd]   = true;
    for (var i = 0; i < textLayers.length; i++){
      var L = textLayers[i];
      if (L.inPoint  > wsStart && L.inPoint  < wsEnd) events[L.inPoint]  = true;
      if (L.outPoint > wsStart && L.outPoint < wsEnd) events[L.outPoint] = true;
    }
    var times = [];
    for (var k in events) if (events.hasOwnProperty(k)) times.push(parseFloat(k));
    times.sort(function(a,b){ return a-b; });

    var sources = [];
    for (var j = 0; j < times.length - 1; j++){
      var t1 = times[j], t2 = times[j+1];
      if (t2 - t1 < EPS) continue;
      var topTxt = findTopTextAt(textLayers, (t1+t2)/2);
      if (!topTxt) continue;
      if (sources.length > 0){
        var prev = sources[sources.length-1];
        if (prev.textLayer === topTxt && Math.abs(prev.window.end - t1) < EPS){
          prev.window.end = t2;
          continue;
        }
      }
      sources.push({
        textLayer: topTxt,
        prompt: getTextLayerSourceText(topTxt),
        window: { start: t1, end: t2 }
      });
    }
    return sources;
  }

  // ============================================================
  // TIME-WINDOW SEGMENTATION
  // ============================================================
  // Returns array of {top: layer|null, lowest: layer|null, start, end}.
  // Segments span [start, end) and are merged where (top, lowest) stay constant.
  function segmentWindow(comp, windowStart, windowEnd){
    var imageLayers = getImageLayers(comp);
    var EPS = 0.0005; // half a millisecond
    var events = {};
    events[windowStart] = true;
    events[windowEnd] = true;
    for (var i = 0; i < imageLayers.length; i++){
      var L = imageLayers[i];
      if (L.inPoint > windowStart && L.inPoint < windowEnd) events[L.inPoint] = true;
      if (L.outPoint > windowStart && L.outPoint < windowEnd) events[L.outPoint] = true;
    }
    var times = [];
    for (var k in events) if (events.hasOwnProperty(k)) times.push(parseFloat(k));
    times.sort(function(a,b){ return a-b; });

    var segs = [];
    for (var j = 0; j < times.length - 1; j++){
      var t1 = times[j], t2 = times[j+1];
      if (t2 - t1 < EPS) continue;
      var mid = (t1 + t2) / 2;
      var top = findTopImageAt(imageLayers, mid);
      var low = findLowestImageAt(imageLayers, mid);
      if (segs.length > 0){
        var prev = segs[segs.length-1];
        if (prev.top === top && prev.lowest === low && Math.abs(prev.end - t1) < EPS){
          prev.end = t2;
          continue;
        }
      }
      segs.push({ top: top, lowest: low, start: t1, end: t2 });
    }
    return segs;
  }

  // ============================================================
  // RENDER-WITH-EFFECTS (export current frame of a layer's parent comp)
  // ============================================================
  function renderLayerToFile(comp, outputFile){
    // Renders the current single frame of `comp` to outputFile (PNG).
    // Requires output module template RENDER_TEMPLATE_NAME to exist in AE.
    log("renderLayerToFile: " + outputFile.fsName);
    comp.openInViewer();
    $.sleep(200);
    var renderQueue = app.project.renderQueue;
    var renderItem = renderQueue.items.add(comp);
    renderItem.timeSpanStart = comp.time;
    renderItem.timeSpanDuration = comp.frameDuration;
    var outputModule = renderItem.outputModule(1);
    var _tmplName = (settings.renderTemplateName) || RENDER_TEMPLATE_NAME;
    try { outputModule.applyTemplate(_tmplName); }
    catch(e){
      try { renderItem.remove(); } catch(_){}
      var _detail = ""; try { _detail = String(e); } catch(_){}
      die("Output module template '" + _tmplName + "' not found.\nCheck Settings → FX Template and ensure the template exists in AE.", _detail);
    }
    try {
      var omSettings = outputModule.getSettings(GetSettingsFormat.STRING_SETTABLE);
      omSettings["Use Comp Frame Number"] = false;
      omSettings["Starting Frame"] = 0;
      outputModule.setSettings(omSettings);
    } catch(_){}
    outputModule.file = outputFile;
    if (renderItem.status !== RQItemStatus.QUEUED) renderItem.render = true;
    // Pause all other queued items so only ours renders
    var _ourIdx = renderQueue.numItems; // our item was just added — always last
    var _pausedIdx = [];
    for (var _ri = 1; _ri < _ourIdx; _ri++){
      try {
        if (renderQueue.item(_ri).status === RQItemStatus.QUEUED){
          renderQueue.item(_ri).render = false;
          _pausedIdx.push(_ri);
        }
      } catch(_){}
    }
    try {
      renderQueue.render();
    } finally {
      for (var _pi = 0; _pi < _pausedIdx.length; _pi++){
        try { renderQueue.item(_pausedIdx[_pi]).render = true; } catch(_){}
      }
    }
    $.sleep(200);

    var actual = null;
    if (outputFile.exists) actual = outputFile;
    else {
      var folder = outputFile.parent;
      var baseName = outputFile.name.replace(/\.png$/i, "");
      var patterns = [
        baseName + ".png00000", baseName + "00000.png",
        baseName + ".png[00000]", baseName + "_00000.png", baseName + "[00000].png"
      ];
      for (var i = 0; i < patterns.length; i++){
        var testFile = new File(folder.fsName + "/" + patterns[i]);
        if (testFile.exists){ actual = testFile; break; }
      }
    }
    if (!actual || !actual.exists){
      try { renderItem.remove(); } catch(_){}
      die("Frame export failed — file not created at: " + outputFile.fsName);
    }
    if (actual.fsName !== outputFile.fsName){
      try {
        if (outputFile.exists) outputFile.remove();
        if (!actual.rename(outputFile.name)){
          actual.copy(outputFile);
          actual.remove();
        }
        actual = outputFile;
      } catch(_){}
    }
    try { renderItem.remove(); } catch(_){}
    return actual;
  }

  // Save a layer's source file path (or render it via render queue if useRenderFX = true).
  // Returns a File on disk that can be uploaded to ComfyUI.
  function renderLayerIsolated(layer, comp, outputFile){
    // Save visibility of every layer and disable them all
    var savedEnabled = [];
    for (var li = 1; li <= comp.numLayers; li++){
      savedEnabled.push(comp.layer(li).enabled);
      try { comp.layer(li).enabled = false; } catch(_){}
    }
    // Enable only the target layer so the render captures just it + its effects
    try { layer.enabled = true; } catch(_){}
    try {
      return renderLayerToFile(comp, outputFile);
    } finally {
      // Always restore visibility regardless of success or failure
      for (var li2 = 1; li2 <= comp.numLayers; li2++){
        try { comp.layer(li2).enabled = savedEnabled[li2 - 1]; } catch(_){}
      }
    }
  }

  function materializeRefLayer(layer, comp, outputFolder, useRenderFX){
    if (!layer) die("Reference layer is null");
    var tmp = new File(outputFolder.fsName + "/cg_ref_" + new Date().getTime() + "_" + Math.floor(Math.random()*10000) + ".png");
    if (useRenderFX){
      // Render just this layer (solo it) so other layers — text, other refs — don't pollute the export
      return renderLayerIsolated(layer, comp, tmp);
    }
    if (layer.source && typeof layer.source.numLayers === "number"){
      var savedPrecompTime = layer.source.time;
      try { layer.source.time = comp.time; } catch(_){}
      var result = renderLayerToFile(layer.source, tmp);
      try { layer.source.time = savedPrecompTime; } catch(_){}
      return result;
    }
    if (!(layer.source && layer.source.file)) die("Reference layer has no source file");
    var srcFile = layer.source.file;
    if (!srcFile.exists) die("Source file not found: " + srcFile.fsName);
    return srcFile;
  }

  // ============================================================
  // WORKFLOW BUILDER
  // ============================================================
  // Build a submitted workflow from a model's template by:
  //   - replacing __PROMPT__ with the actual prompt
  //   - setting seed
  //   - setting aspect_ratio (and resolution if supported)
  //   - for I2I: replacing __SLOT_N__ filenames AND removing unused LoadImage nodes
  //     plus their entries in BatchImagesNode
  function buildWorkflow(model, mode, params){
    // params = { prompt, seed, aspect, resolution, uploadedSlotFilenames, filenamePrefix, googleApiKey }
    var wf = deepCopy(mode === "i2i" ? model.workflowI2I : model.workflowT2I);
    var gen = wf[model.generatorNodeId];
    if (!gen) die("Generator node missing from workflow template: " + model.generatorNodeId);

    gen.inputs.prompt = params.prompt || "";
    gen.inputs.seed   = params.seed;
    if (params.aspect) gen.inputs.aspect_ratio = params.aspect;
    if (model.supportsResolution && params.resolution)
      gen.inputs[model.resolutionParamName || "resolution"] = params.resolution;
    if (model.apiKeyType === "google")
      gen.inputs.api_key = params.googleApiKey || "";
    if (params.filenamePrefix && wf[model.saveNodeId])
      wf[model.saveNodeId].inputs.filename_prefix = params.filenamePrefix;

    if (mode === "i2i"){
      var slotCount = params.uploadedSlotFilenames.length;
      var i, k, nodeId, nid;

      if (model.imageInputStyle === "direct"){
        // New style: wire LoadImage nodes directly into image_1…image_N on the generator
        for (i = 0; i < slotCount; i++){
          nodeId = model.loadImageNodeIdsBySlot[i];
          if (!wf[nodeId]) die("LoadImage node missing for slot " + i + " (id " + nodeId + ")");
          wf[nodeId].inputs.image = params.uploadedSlotFilenames[i];
          gen.inputs["image_" + (i + 1)] = [nodeId, 0];
        }
        for (k = slotCount; k < model.loadImageNodeIdsBySlot.length; k++){
          nid = model.loadImageNodeIdsBySlot[k];
          if (wf[nid]) delete wf[nid];
          delete gen.inputs["image_" + (k + 1)];
        }
      } else {
        // Existing batch style: BatchImagesNode + LoadImage slots
        var batchNode = wf[model.batchNodeId];
        if (!batchNode) die("BatchImagesNode missing from I2I workflow: " + model.batchNodeId);
        for (i = 0; i < slotCount; i++){
          nodeId = model.loadImageNodeIdsBySlot[i];
          if (!wf[nodeId]) die("LoadImage node missing for slot " + i + " (id " + nodeId + ")");
          wf[nodeId].inputs.image = params.uploadedSlotFilenames[i];
        }
        for (k = slotCount; k < model.loadImageNodeIdsBySlot.length; k++){
          nid = model.loadImageNodeIdsBySlot[k];
          if (wf[nid]) delete wf[nid];
          var batchKey = "images.image" + k;
          if (batchNode.inputs.hasOwnProperty(batchKey)) delete batchNode.inputs[batchKey];
        }
      }
    }
    return wf;
  }

  // ============================================================
  // COST ESTIMATION
  // ============================================================
  function estimateCreditsPerImage(model, resolution){
    if (model.supportsResolution){
      return (model.creditsPerImage[resolution] !== undefined) ? model.creditsPerImage[resolution] : 28.3;
    }
    return model.creditsPerImage["1K"];
  }

  // ============================================================
  // GENERATION PLANNER
  // ============================================================
  // Plans the list of generations to be run, given the user's UI state.
  // Returns an array of:
  //   { prompt, refs: [layer|null,...], textLayer, segIndex, varIndex, segStart, segEnd }
  // plus skip log (reasons, ranges) for diagnostic purposes.
  function planGenerations(opts){
    // opts = {
    //   comp,
    //   model,
    //   mode,                  // "t2i" | "i2i"
    //   variations,
    //   promptSource,          // PROMPT_SRC_TYPED | PROMPT_SRC_TOP_TEXT | text layer name
    //   typedPrompt,           // when source = typed
    //   slots                  // array of {kind: "none"|"top"|"lowest"|"layer", layer: layer|null, useRenderFX}
    // }
    var plan = [];
    var skips = [];
    var comp = opts.comp;
    var model = opts.model;
    var mode = opts.mode;
    var variations = Math.max(1, opts.variations|0);
    var slots = opts.slots || [];

    // Determine prompt sources to iterate over.
    // Each source is { textLayer: layer|null, prompt: string, window: {start,end}|null }
    var sources = [];
    if (opts.promptSource === PROMPT_SRC_TYPED){
      sources.push({ textLayer: null, prompt: opts.typedPrompt || "", window: null });
    } else if (opts.promptSource === PROMPT_SRC_TOP_TEXT){
      var topSrcs = buildTopTextSources(comp);
      if (topSrcs.length === 0){
        skips.push("Prompt source = Top text layer but no text layers active in work area");
        return { plan: plan, skips: skips };
      }
      for (var ti = 0; ti < topSrcs.length; ti++) sources.push(topSrcs[ti]);
    } else {
      // Specific text layer by name
      var tls3 = getTextLayers(comp);
      var found = null;
      for (var j = 0; j < tls3.length; j++){
        if (tls3[j].name === opts.promptSource) { found = tls3[j]; break; }
      }
      if (!found){
        skips.push("Specific text layer not found: " + opts.promptSource);
        return { plan: plan, skips: skips };
      }
      sources.push({ textLayer: found, prompt: getTextLayerSourceText(found), window: { start: found.inPoint, end: found.outPoint } });
    }

    // Active slots for I2I
    var activeSlots = [];
    if (mode === "i2i"){
      for (var s = 0; s < slots.length; s++){
        if (slots[s].kind !== "none") activeSlots.push(slots[s]);
      }
      if (activeSlots.length === 0){
        skips.push("I2I mode but no active reference slots — generation aborted");
        return { plan: plan, skips: skips };
      }
    }

    var hasDynamicSlots = false;
    for (var ns = 0; ns < activeSlots.length; ns++){
      if (activeSlots[ns].kind === "top" || activeSlots[ns].kind === "lowest"){
        hasDynamicSlots = true;
        break;
      }
    }

    // ---- First-frame iteration path (any dynamic slot present) ----
    if (hasDynamicSlots){
      var wsStart = comp.workAreaStart;
      var wsEnd   = comp.workAreaStart + comp.workAreaDuration;
      var keyFrames = [];

      if (opts.promptSource === PROMPT_SRC_TOP_TEXT){
        // Iterate by top TEXT + IMAGE layer transitions combined
        var textTrans = findTextAndImageTopTransitions(comp, wsStart, wsEnd, activeSlots);
        if (textTrans.length === 0){
          skips.push("Prompt source = Top text layer but no text layers active in work area");
          return { plan: plan, skips: skips };
        }
        for (var tt = 0; tt < textTrans.length; tt++){
          keyFrames.push({
            frame:      textTrans[tt].frame,
            periodEnd:  textTrans[tt].periodEnd,
            prompt:     textTrans[tt].prompt,
            textLayer:  textTrans[tt].topTextLayer
          });
        }
      } else {
        // Iterate by top IMAGE layer transitions; prompt is constant or named layer
        var imgTrans = findImageTopTransitions(comp, wsStart, wsEnd);
        if (imgTrans.length === 0){
          skips.push("No top image layers active in work area");
          return { plan: plan, skips: skips };
        }
        var resolvedPrompt = "";
        if (opts.promptSource === PROMPT_SRC_TYPED){
          resolvedPrompt = opts.typedPrompt || "";
        } else {
          // Named specific text layer
          var tls3 = getTextLayers(comp);
          var found3 = null;
          for (var j3 = 0; j3 < tls3.length; j3++){
            if (tls3[j3].name === opts.promptSource){ found3 = tls3[j3]; break; }
          }
          if (!found3){
            skips.push("Specific text layer not found: " + opts.promptSource);
            return { plan: plan, skips: skips };
          }
          resolvedPrompt = getTextLayerSourceText(found3);
        }
        for (var it = 0; it < imgTrans.length; it++){
          keyFrames.push({
            frame:      imgTrans[it].frame,
            periodEnd:  imgTrans[it].periodEnd,
            prompt:     resolvedPrompt,
            textLayer:  null
          });
        }
      }

      var imageLayers = getImageLayers(comp);
      for (var kf = 0; kf < keyFrames.length; kf++){
        var kfData   = keyFrames[kf];
        var t        = kfData.frame;
        var kfLabel  = kfData.textLayer ? kfData.textLayer.name : ("frame " + t.toFixed(3) + "s");
        var refs     = [];
        var ok       = true;
        var seenLayers = [];   // for deduplication when top == lowest

        for (var sl = 0; sl < activeSlots.length; sl++){
          var slot = activeSlots[sl];
          var r = null;
          if (slot.kind === "top")         r = findTopImageAt(imageLayers, t);
          else if (slot.kind === "lowest") r = findLowestImageAt(imageLayers, t);
          else if (slot.kind === "layer")  r = slot.layer;

          if (!r){
            skips.push("[" + kfLabel + "] slot " + (sl+1) + " (" + slot.kind + ") resolved to null — skipped");
            ok = false;
            break;
          }
          // Named layer: must be active at this frame
          if (slot.kind === "layer" && (r.inPoint > t || r.outPoint <= t)){
            skips.push("[" + kfLabel + "] named layer '" + r.name + "' not active at frame — skipped");
            ok = false;
            break;
          }
          // Deduplicate: if this layer is already in refs (top == lowest case), skip slot silently
          var duplicate = false;
          for (var di = 0; di < seenLayers.length; di++){
            if (seenLayers[di] === r){ duplicate = true; break; }
          }
          if (duplicate) continue;
          seenLayers.push(r);
          refs.push({ layer: r, useRenderFX: !!slot.useRenderFX });
        }
        if (!ok) continue;

        for (var vv = 0; vv < variations; vv++){
          plan.push({
            prompt:    kfData.prompt,
            refs:      refs,
            textLayer: kfData.textLayer,
            segIndex:  kf,
            varIndex:  vv,
            segStart:  t,
            segEnd:    kfData.periodEnd
          });
        }
      }

      return { plan: plan, skips: skips };
    }

    // ---- No dynamic slots: existing behaviour (playhead / text-window) ----
    // Iterate prompt sources
    for (var srcIdx = 0; srcIdx < sources.length; srcIdx++){
      var src = sources[srcIdx];
      var srcLabel = src.textLayer ? src.textLayer.name : "(typed)";

      if (!src.window){
        // No window — resolve named/constant slots at playhead time
        var tPH = comp.time;
        var refsP = [];
        var okP = true;
        for (var sl2 = 0; sl2 < activeSlots.length; sl2++){
          var slotP = activeSlots[sl2];
          var rP = null;
          if (slotP.kind === "layer") rP = slotP.layer;
          if (!rP){
            skips.push("[" + srcLabel + "] slot " + (sl2+1) + " (" + slotP.kind + ") resolved to null at playhead — skipped");
            okP = false;
            break;
          }
          refsP.push({ layer: rP, useRenderFX: !!slotP.useRenderFX });
        }
        if (!okP) continue;
        for (var vvP = 0; vvP < variations; vvP++){
          plan.push({
            prompt: src.prompt, refs: refsP, textLayer: null,
            segIndex: srcIdx, varIndex: vvP, segStart: tPH, segEnd: tPH + comp.frameDuration
          });
        }
        continue;
      }

      // Has a window — named layer slots only (no dynamic slots in this branch)
      var refsW = [];
      var okW = true;
      for (var sw = 0; sw < activeSlots.length; sw++){
        var slotW = activeSlots[sw];
        if (slotW.kind === "layer"){
          var lyr = slotW.layer;
          if (!lyr){ okW = false; skips.push("[" + srcLabel + "] slot " + (sw+1) + " layer missing"); break; }
          if (lyr.outPoint <= src.window.start || lyr.inPoint >= src.window.end){
            okW = false;
            skips.push("[" + srcLabel + "] slot " + (sw+1) + " layer '" + lyr.name + "' does not overlap window");
            break;
          }
          refsW.push({ layer: lyr, useRenderFX: !!slotW.useRenderFX });
        }
      }
      if (!okW) continue;
      for (var vw = 0; vw < variations; vw++){
        plan.push({
          prompt: src.prompt, refs: refsW, textLayer: src.textLayer,
          segIndex: srcIdx, varIndex: vw, segStart: src.window.start, segEnd: src.window.end
        });
      }
    }

    return { plan: plan, skips: skips };
  }

  // ============================================================
  // GLOBAL UI STATE (referenced by handlers + scheduled tasks)
  // ============================================================
  var settings = loadSettings();
  var slots = [];           // array of slot UI objects (see buildSlotUI)
  var stopRequested = false;
  var generating = false;
  var _suppressSlotChange = false;
  var lastCompId = null;
  var lastCompName = null;
  var lastLayerFingerprint = null;
  var compStateCache = {};
  var _pendingPromptSrc = null;
  var promptSrcLayer    = null;
  var sessionId = new Date().getTime();
  $._comfyCloudGenPanel._sessionId = sessionId;

  // ============================================================
  // UI BUILD
  // ============================================================
  var win = (thisObj instanceof Panel) ? thisObj : new Window("palette", "Comfy CloudGen", undefined, {resizeable:true});
  win.orientation = "column";
  win.alignChildren = ["fill","top"];
  win.spacing = 6;
  win.margins = 8;

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

  // ---------- Model ----------
  var modelPanel = win.add("panel", undefined, "Model & Mode");
  modelPanel.orientation = "column"; modelPanel.alignChildren = ["fill","top"];
  var modelRow = modelPanel.add("group"); modelRow.orientation = "row";
  modelRow.add("statictext", undefined, "Model:");
  var modelDrop = modelRow.add("dropdownlist", undefined, []);
  for (var mki = 0; mki < MODEL_KEYS.length; mki++){
    modelDrop.add("item", MODELS[MODEL_KEYS[mki]].displayName);
  }
  var savedModelIdx = arrIndexOf(MODEL_KEYS, settings.lastModel);
  modelDrop.selection = (savedModelIdx >= 0) ? savedModelIdx : 0;
  modelDrop.preferredSize.width = 220;


  // ---------- Prompt ----------
  var promptPanel = win.add("panel", undefined, "Prompt");
  promptPanel.orientation = "column"; promptPanel.alignChildren = ["fill","top"];
  var promptSrcRow = promptPanel.add("group"); promptSrcRow.orientation = "row";
  promptSrcRow.add("statictext", undefined, "Source:");
  var promptSrcDrop = promptSrcRow.add("dropdownlist", undefined, []);
  promptSrcDrop.preferredSize.width = 280;
  var promptField = promptPanel.add("edittext", undefined, "", {multiline:true, wantReturn:true});
  promptField.preferredSize.height = 70;

  // ---------- Reference Images ----------
  var refPanel = win.add("panel", undefined, "Reference Images");
  refPanel.orientation = "column"; refPanel.alignChildren = ["fill","top"];
  var slotsContainer = refPanel.add("group"); slotsContainer.orientation = "column"; slotsContainer.alignChildren = ["fill","top"];
  var addBtnRow = refPanel.add("group"); addBtnRow.orientation = "row"; addBtnRow.alignment = ["fill","top"];
  var addSlotBtn = addBtnRow.add("button", undefined, "+ Add reference");

  // ---------- Output controls ----------
  var outPanel = win.add("panel", undefined, "Output");
  outPanel.orientation = "column"; outPanel.alignChildren = ["fill","top"];
  var aspRow = outPanel.add("group"); aspRow.orientation = "row";
  aspRow.add("statictext", undefined, "Aspect:");
  var aspectDrop = aspRow.add("dropdownlist", undefined, []);
  aspectDrop.preferredSize.width = 130;

  var resRow = outPanel.add("group"); resRow.orientation = "row";
  resRow.add("statictext", undefined, "Resolution:");
  var resDrop = resRow.add("dropdownlist", undefined, []);
  resDrop.preferredSize.width = 90;

  var varRow = outPanel.add("group"); varRow.orientation = "row";
  varRow.add("statictext", undefined, "Variations:");
  var varSlider = varRow.add("slider", undefined, settings.lastVariations, 1, 10);
  varSlider.preferredSize.width = 150;
  var varEdit = varRow.add("edittext", undefined, String(settings.lastVariations));
  varEdit.characters = 3;

  // ---------- Generate ----------
  var genGroup = win.add("group"); genGroup.orientation = "row"; genGroup.alignment = ["fill","top"];
  var genBtn = genGroup.add("button", undefined, "Generate");
  genBtn.preferredSize.height = 32;
  genBtn.alignment = ["fill","top"];
  var stopBtn = genGroup.add("button", undefined, "Stop"); stopBtn.enabled = false;

  var statusTxt = win.add("statictext", undefined, "Status: idle"); statusTxt.alignment = ["fill","top"];
  var sessionTxt = win.add("statictext", undefined, "Session: 0 images · 0 credits");
  sessionTxt.alignment = ["fill","top"];

  // ---------- Settings ----------
  var settingsPanel = win.add("panel", undefined, "Settings");
  settingsPanel.orientation = "column"; settingsPanel.alignChildren = ["fill","top"];
  var comfyKeyRow = settingsPanel.add("group"); comfyKeyRow.orientation = "row";
  comfyKeyRow.add("statictext", undefined, "ComfyOrg Key:");
  var apiKeyEdit = comfyKeyRow.add("edittext", undefined, settings.apiKey || "", {noecho: true});
  apiKeyEdit.preferredSize.width = 240;
  apiKeyEdit.helpTip = "ComfyOrg API key — generate at platform.comfy.org → Account → API Keys";

  var googleKeyRow = settingsPanel.add("group"); googleKeyRow.orientation = "row";
  googleKeyRow.add("statictext", undefined, "Google Key:");
  var googleApiKeyEdit = googleKeyRow.add("edittext", undefined, settings.googleApiKey || "", {noecho: true});
  googleApiKeyEdit.preferredSize.width = 240;
  googleApiKeyEdit.helpTip = "Google AI API key — used by Imagen 4 and Nano Banana 2 nodes";

  var folderRow = settingsPanel.add("group"); folderRow.orientation = "row";
  folderRow.add("statictext", undefined, "Output folder:");
  var outputFolderEdit = folderRow.add("edittext", undefined, settings.outputFolder || "");
  outputFolderEdit.preferredSize.width = 200;
  var chooseFolderBtn = folderRow.add("button", undefined, "Browse");
  chooseFolderBtn.preferredSize.width = 70;
  var aeFolderRow = settingsPanel.add("group"); aeFolderRow.orientation = "row";
  aeFolderRow.add("statictext", undefined, "AE folder:");
  var aeFolderEdit = aeFolderRow.add("edittext", undefined, settings.aeProjectFolder || "");
  aeFolderEdit.preferredSize.width = 200;
  aeFolderEdit.helpTip = "Project panel folder for imported footage. Leave blank for root. Use / for subfolders, e.g. CloudGen/Renders";
  var pickAEFolderBtn = aeFolderRow.add("button", undefined, "Pick");
  pickAEFolderBtn.preferredSize.width = 70;
  pickAEFolderBtn.helpTip = "Use the folder currently selected in the Project panel";

  var prefixRow = settingsPanel.add("group"); prefixRow.orientation = "row";
  prefixRow.add("statictext", undefined, "File prefix:");
  var filePrefixEdit = prefixRow.add("edittext", undefined, settings.filenamePrefix || "CloudGen");
  filePrefixEdit.preferredSize.width = 160;
  filePrefixEdit.helpTip = "Prefix for filenames saved by ComfyUI (e.g. 'CloudGen' → CloudGen_00001_.png)";

  var fxTmplRow = settingsPanel.add("group"); fxTmplRow.orientation = "row";
  fxTmplRow.add("statictext", undefined, "FX Template:");
  var renderTmplDrop = fxTmplRow.add("dropdownlist", undefined, []);
  renderTmplDrop.preferredSize.width = 220;
  renderTmplDrop.helpTip = "Output module template used when rendering reference slots with FX enabled";
  var renderTmplRefreshBtn = fxTmplRow.add("button", undefined, "↺");
  renderTmplRefreshBtn.preferredSize.width = 28;
  renderTmplRefreshBtn.helpTip = "Refresh template list from AE";

  var logBtnRow = settingsPanel.add("group"); logBtnRow.orientation = "row";
  var viewLogBtn = logBtnRow.add("button", undefined, "View Log");
  var clearSessionBtn = logBtnRow.add("button", undefined, "Reset session counter");
  var clearCompMemBtn = logBtnRow.add("button", undefined, "Clear comp memory");
  clearCompMemBtn.helpTip = "Forget all saved settings for the current composition and reset to defaults";
  var memBtnRow2 = settingsPanel.add("group"); memBtnRow2.orientation = "row";
  var clearAllMemBtn = memBtnRow2.add("button", undefined, "Clear all comps memory");
  clearAllMemBtn.helpTip = "Forget saved settings for every composition and reset the UI to defaults";

  // Session counter init
  function refreshSessionCounter(){
    sessionTxt.text = "Session: " + (settings.sessionCount || 0) + " images · " + (settings.sessionCost || 0).toFixed(1) + " credits";
  }
  if (settings.sessionCount === undefined) settings.sessionCount = 0;
  refreshSessionCounter();

  // ============================================================
  // SLOT UI MANAGEMENT
  // ============================================================
  function buildSlotUI(slotIndex){
    var grp = slotsContainer.add("group");
    grp.orientation = "row";
    grp.alignChildren = ["left","center"];
    var label = grp.add("statictext", undefined, "Slot " + (slotIndex+1) + ":");
    label.preferredSize.width = 50;
    var dd = grp.add("dropdownlist", undefined, []);
    dd.preferredSize.width = 160;
    var topChk = grp.add("checkbox", undefined, "▲ Top"); topChk.value = false;
    var lowChk = grp.add("checkbox", undefined, "▼ Low"); lowChk.value = false;
    var fxChk  = grp.add("checkbox", undefined, "FX");       fxChk.value  = false;
    var rmBtn  = grp.add("button", undefined, "−");
    rmBtn.preferredSize.width = 28;
    var slot = {
      group: grp, dropdown: dd, topChk: topChk, lowChk: lowChk,
      fx: fxChk, removeBtn: rmBtn, kind: "none", layer: null
    };
    rmBtn.onClick = function(){ removeSlot(slot); };

    // Checkbox handlers — safe to repopulate siblings because we are NOT inside
    // a DropDownList onChange (the AE 25.4+ bug only triggers in that context).
    topChk.onClick = function(){
      if (topChk.value){
        lowChk.value  = false;
        slot.kind  = "top";
        slot.layer = null;
        slot.dropdown.enabled = false;
      } else {
        var pick = slot.dropdown.selection ? slot.dropdown.selection.text : KIND_NONE;
        slot.kind  = (pick === KIND_NONE) ? "none" : "layer";
        slot.layer = (slot.kind === "layer") ? findImageLayerByDisplayName(pick) : null;
        slot.dropdown.enabled = true;
      }
      refreshSlotButtonStates();
      repopulateAllSlotDropdowns();
      saveCurrentCompState();
    };

    lowChk.onClick = function(){
      if (lowChk.value){
        topChk.value  = false;
        slot.kind  = "lowest";
        slot.layer = null;
        slot.dropdown.enabled = false;
      } else {
        var pick = slot.dropdown.selection ? slot.dropdown.selection.text : KIND_NONE;
        slot.kind  = (pick === KIND_NONE) ? "none" : "layer";
        slot.layer = (slot.kind === "layer") ? findImageLayerByDisplayName(pick) : null;
        slot.dropdown.enabled = true;
      }
      refreshSlotButtonStates();
      repopulateAllSlotDropdowns();
      saveCurrentCompState();
    };

    // DropDownList onChange — only updates THIS slot, never modifies siblings.
    // Modifying any DropDownList inside a DropDownList onChange triggers the AE 25.4+ bug
    // that silently reverts selections at index 1/2. Keeping onChange atomic avoids it.
    dd.onChange = function(){
      if (_suppressSlotChange) return;
      if (slot.topChk.value || slot.lowChk.value) return;
      var pick = dd.selection ? dd.selection.text : KIND_NONE;
      if (pick === KIND_NONE){ slot.kind = "none"; slot.layer = null; }
      else {
        slot.kind  = "layer";
        slot.layer = findImageLayerByDisplayName(pick);
        if (slot.layer && slot.layer.source && typeof slot.layer.source.numLayers === "number")
          slot.fx.value = true;
      }
      refreshSlotButtonStates();
      saveCurrentCompState();
    };

    return slot;
  }

  function findImageLayerByName(name){
    var c = activeComp();
    if (!c) return null;
    var imageLayers = getImageLayers(c);
    for (var i = 0; i < imageLayers.length; i++){
      if (imageLayers[i].name === name) return imageLayers[i];
    }
    return null;
  }

  function layerDisplayName(L){
    return L.index + ". " + L.name;
  }

  function findImageLayerByDisplayName(text){
    return findImageLayerByName(text.replace(/^\d+\. /, ""));
  }

  function populateSlotDropdown(slot, comp){
    _suppressSlotChange = true;
    try {
      // Capture the named-layer we want to restore (top/lowest are driven by checkboxes, not dropdown).
      // _pendingLayerName is set by applyCompState to avoid calling activeComp() at switch time.
      var prev;
      try {
        if (slot.kind === "layer" && slot._pendingLayerName) {
          prev = slot._pendingLayerName;
          slot._pendingLayerName = null;
        } else {
          prev = (slot.kind === "layer" && slot.layer) ? slot.layer.name : KIND_NONE;
        }
      } catch(_){ prev = KIND_NONE; slot.kind = "none"; slot.layer = null; slot._pendingLayerName = null; }

      // Sync checkbox visual state from slot.kind
      slot.topChk.value        = (slot.kind === "top");
      slot.lowChk.value        = (slot.kind === "lowest");
      slot.dropdown.enabled    = (slot.kind !== "top" && slot.kind !== "lowest");

      // Build named-layer list, excluding layers already claimed by other slots
      var usedLayerNames = {};
      for (var i = 0; i < slots.length; i++){
        if (slots[i] === slot) continue;
        if (slots[i].kind === "layer" && slots[i].layer){
          try { usedLayerNames[slots[i].layer.name] = true; } catch(_){}
        }
      }
      var c = comp || activeComp();
      var imageLayers = c ? getImageLayers(c) : [];

      slot.dropdown.removeAll();
      slot.dropdown.add("item", KIND_NONE);
      for (var j = 0; j < imageLayers.length; j++){
        if (!usedLayerNames[imageLayers[j].name])
          slot.dropdown.add("item", layerDisplayName(imageLayers[j]));
      }

      // Restore named-layer selection.
      // Use the intended text (items[selIdx].text) — never read back dropdown.selection
      // because AE 25.4+ silently reverts the property at indices 1/2.
      var selIdx = 0;
      for (var k = 0; k < slot.dropdown.items.length; k++){
        if (slot.dropdown.items[k].text.replace(/^\d+\. /, "") === prev){ selIdx = k; break; }
      }
      var targetText = slot.dropdown.items[selIdx].text;
      slot.dropdown.selection = selIdx;

      // Only reconcile kind/layer from the dropdown when not in top/lowest checkbox mode
      if (slot.kind !== "top" && slot.kind !== "lowest"){
        if (targetText === KIND_NONE){ slot.kind = "none"; slot.layer = null; }
        else { slot.kind = "layer"; slot.layer = findImageLayerByDisplayName(targetText); }
      }
    } finally {
      _suppressSlotChange = false;
    }
  }

  function repopulateAllSlotDropdowns(comp){
    for (var i = 0; i < slots.length; i++) populateSlotDropdown(slots[i], comp);
    refreshSlotButtonStates();
  }

  function refreshSlotButtonStates(){
    var topTaken = false, lowTaken = false;
    for (var i = 0; i < slots.length; i++){
      if (slots[i].kind === "top")    topTaken = true;
      if (slots[i].kind === "lowest") lowTaken = true;
    }
    for (var j = 0; j < slots.length; j++){
      slots[j].topChk.enabled  = (slots[j].kind === "top")    || !topTaken;
      slots[j].lowChk.enabled  = (slots[j].kind === "lowest") || !lowTaken;
      slots[j].dropdown.enabled = (slots[j].kind !== "top" && slots[j].kind !== "lowest");
    }
  }

  function relabelSlots(){
    for (var i = 0; i < slots.length; i++){
      var lbl = slots[i].group.children[0];
      lbl.text = "Slot " + (i+1) + ":";
    }
  }

  function addSlot(){
    var model = getModel(MODEL_KEYS[modelDrop.selection.index]);
    var cap = model.refCap;
    if (slots.length >= cap){
      alert("Maximum " + cap + " reference slots for " + model.displayName + ".");
      return;
    }
    var s = buildSlotUI(slots.length);
    slots.push(s);
    populateSlotDropdown(s);
    refreshAddButton();
    win.layout.layout(true);
    saveCurrentCompState();
  }

  function removeSlot(slot){
    if (slots.length <= 1){
      // Reset to (none) instead of removing the last slot
      slot.kind = "none"; slot.layer = null;
      slot.topChk.value = false; slot.lowChk.value = false;
      slot.dropdown.enabled = true; slot.dropdown.selection = 0;
      slot.fx.value = false;
      repopulateAllSlotDropdowns();
      saveCurrentCompState();
      return;
    }
    var idx = arrIndexOf(slots, slot);
    if (idx < 0) return;
    try { slotsContainer.remove(slot.group); } catch(_){}
    slots.splice(idx, 1);
    relabelSlots();
    repopulateAllSlotDropdowns();
    refreshAddButton();
    win.layout.layout(true);
    saveCurrentCompState();
  }

  function refreshAddButton(){
    var model = getModel(MODEL_KEYS[modelDrop.selection.index]);
    addSlotBtn.enabled = (slots.length < model.refCap);
    addSlotBtn.text = "+ Add reference (" + slots.length + "/" + model.refCap + ")";
  }

  function setSlotsVisible(visible){
    refPanel.visible = visible;
  }

  // ============================================================
  // ASPECT / RESOLUTION DROPDOWN POPULATION
  // ============================================================
  function populateAspectDropdown(){
    var model = getModel(MODEL_KEYS[modelDrop.selection.index]);
    var prev = aspectDrop.selection ? aspectDrop.selection.text : null;
    aspectDrop.removeAll();
    aspectDrop.add("item", "Match comp");
    for (var i = 0; i < model.supportedAspects.length; i++) aspectDrop.add("item", model.supportedAspects[i]);

    // Try to restore previous selection
    var restored = false;
    if (prev){
      for (var j = 0; j < aspectDrop.items.length; j++){
        if (aspectDrop.items[j].text === prev){ aspectDrop.selection = j; restored = true; break; }
      }
    }
    if (!restored){
      // Try saved
      var saved = settings.lastAspect || "match_comp";
      for (var k = 0; k < aspectDrop.items.length; k++){
        var t = aspectDrop.items[k].text;
        if ((saved === "match_comp" && t === "Match comp") || t === saved){
          aspectDrop.selection = k; restored = true; break;
        }
      }
    }
    if (!restored) aspectDrop.selection = 0;
  }

  function populateResolutionDropdown(){
    var model = getModel(MODEL_KEYS[modelDrop.selection.index]);
    resDrop.removeAll();
    if (!model.supportsResolution){
      resDrop.add("item", "(N/A)");
      resDrop.selection = 0;
      resDrop.enabled = false;
      resRow.enabled = false;
      return;
    }
    resDrop.enabled = true;
    resRow.enabled = true;
    var prevRes = settings.lastResolution || "1K";
    var selIdx = 0;
    for (var i = 0; i < model.supportedResolutions.length; i++){
      resDrop.add("item", model.supportedResolutions[i]);
      if (model.supportedResolutions[i] === prevRes) selIdx = i;
    }
    resDrop.selection = selIdx;
  }

  function populateRenderTemplateDropdown(){
    var templates = queryRenderTemplates();
    var savedName = settings.renderTemplateName || RENDER_TEMPLATE_NAME;
    renderTmplDrop.removeAll();
    if (templates.length === 0){
      renderTmplDrop.add("item", savedName);
      renderTmplDrop.selection = 0;
      return;
    }
    var selIdx = 0;
    for (var i = 0; i < templates.length; i++){
      renderTmplDrop.add("item", templates[i]);
      if (templates[i] === savedName) selIdx = i;
    }
    renderTmplDrop.selection = selIdx;
    if (renderTmplDrop.selection) settings.renderTemplateName = renderTmplDrop.selection.text;
  }

  // ============================================================
  // PROMPT SOURCE DROPDOWN
  // ============================================================
  function populatePromptSourceDropdown(comp){
    var c = comp || activeComp();

    var prev;
    if (_pendingPromptSrc !== null){
      prev = _pendingPromptSrc.replace(/^\d+\. /, "");
      _pendingPromptSrc = null;
    } else if (promptSrcLayer !== null){
      try { prev = promptSrcLayer.name; } catch(_){ prev = PROMPT_SRC_TYPED; promptSrcLayer = null; }
    } else {
      var selText = promptSrcDrop.selection ? promptSrcDrop.selection.text : PROMPT_SRC_TYPED;
      prev = selText.replace(/^\d+\. /, "");
    }

    promptSrcDrop.removeAll();
    promptSrcDrop.add("item", PROMPT_SRC_TYPED);
    var tls = c ? getTextLayers(c) : [];
    if (tls.length > 0){
      promptSrcDrop.add("item", PROMPT_SRC_TOP_TEXT);
      for (var i = 0; i < tls.length; i++) promptSrcDrop.add("item", layerDisplayName(tls[i]));
    }

    var selIdx = -1;
    for (var j = 0; j < promptSrcDrop.items.length; j++){
      if (promptSrcDrop.items[j].text.replace(/^\d+\. /, "") === prev){ selIdx = j; break; }
    }
    promptSrcDrop.selection = (selIdx >= 0) ? selIdx : 0;

    var nowSrc = promptSrcDrop.selection ? promptSrcDrop.selection.text : PROMPT_SRC_TYPED;
    promptSrcLayer = null;
    if (nowSrc !== PROMPT_SRC_TYPED && nowSrc !== PROMPT_SRC_TOP_TEXT){
      var stripped = nowSrc.replace(/^\d+\. /, "");
      for (var ti = 0; ti < tls.length; ti++){
        if (tls[ti].name === stripped){ promptSrcLayer = tls[ti]; break; }
      }
    }

    promptSrcDrop.onChange = function(){
      var sel = promptSrcDrop.selection ? promptSrcDrop.selection.text : PROMPT_SRC_TYPED;
      promptSrcLayer = null;
      if (sel !== PROMPT_SRC_TYPED && sel !== PROMPT_SRC_TOP_TEXT){
        var c2 = activeComp();
        var tls2 = c2 ? getTextLayers(c2) : [];
        var s2 = sel.replace(/^\d+\. /, "");
        for (var ti2 = 0; ti2 < tls2.length; ti2++){
          if (tls2[ti2].name === s2){ promptSrcLayer = tls2[ti2]; break; }
        }
      }
      updatePromptFieldVisibility();
    };

    updatePromptFieldVisibility();
  }

  function updatePromptFieldVisibility(){
    var src = promptSrcDrop.selection ? promptSrcDrop.selection.text : PROMPT_SRC_TYPED;
    promptField.enabled = (src === PROMPT_SRC_TYPED);
    if (src === PROMPT_SRC_TOP_TEXT){
      promptField.text = "(top text layer at playhead will be used as prompt)";
    } else if (src !== PROMPT_SRC_TYPED){
      promptField.text = "(this layer's text will be used as prompt)";
    } else if (promptField.text.indexOf("(") === 0){
      promptField.text = "";
    }
  }

  // ============================================================
  // EVENT HANDLERS — UI
  // ============================================================
  modelDrop.onChange = function(){
    if (_applyingState) return;
    var model = getModel(MODEL_KEYS[modelDrop.selection.index]);
    // Trim slots beyond new cap
    while (slots.length > model.refCap){
      var last = slots[slots.length - 1];
      try { slotsContainer.remove(last.group); } catch(_){}
      slots.pop();
    }
    relabelSlots();
    populateAspectDropdown();
    populateResolutionDropdown();
    repopulateAllSlotDropdowns();
    refreshAddButton();
    updateApiKeyFields();
    win.layout.layout(true);
    saveCurrentCompState();
  };

  function updateApiKeyFields(){
    var model = getModel(MODEL_KEYS[modelDrop.selection.index]);
    var isGoogle = model.apiKeyType === "google";
    comfyKeyRow.enabled  = !isGoogle;
    googleKeyRow.enabled =  isGoogle;
  }


  promptSrcDrop.onChange = function(){ updatePromptFieldVisibility(); saveCurrentCompState(); };

  addSlotBtn.onClick = function(){ addSlot(); };

  hostEdit.onChange           = function(){ settings.host           = hostEdit.text;           saveSettings(settings); };
  portEdit.onChange           = function(){ settings.port           = portEdit.text;           saveSettings(settings); };
  apiKeyEdit.onChange         = function(){ settings.apiKey         = apiKeyEdit.text;         saveSettings(settings); };
  googleApiKeyEdit.onChange   = function(){ settings.googleApiKey   = googleApiKeyEdit.text;   saveSettings(settings); };
  filePrefixEdit.onChange     = function(){ settings.filenamePrefix = filePrefixEdit.text;     saveSettings(settings); };

  renderTmplDrop.onChange = function(){
    if (renderTmplDrop.selection){
      settings.renderTemplateName = renderTmplDrop.selection.text;
      saveSettings(settings);
    }
  };
  renderTmplRefreshBtn.onClick = function(){ populateRenderTemplateDropdown(); };

  pingBtn.onClick = function(){
    try {
      var q = httpGetQueue(hostEdit.text, portEdit.text);
      if (q){ connStatus.text = "Status: connected"; }
      else { connStatus.text = "Status: HTTP error"; }
    } catch(e){ connStatus.text = "Status: not reachable"; }
  };

  varSlider.onChanging = function(){ varEdit.text = String(Math.round(varSlider.value)); };
  varSlider.onChange = function(){ varEdit.text = String(Math.round(varSlider.value)); saveCurrentCompState(); };
  varEdit.onChanging = function(){
    var n = parseInt(varEdit.text, 10);
    if (!isNaN(n) && n >= 1 && n <= 10) varSlider.value = n;
  };
  varEdit.onChange = function(){ saveCurrentCompState(); };

  aspectDrop.onChange = function(){ saveCurrentCompState(); };
  resDrop.onChange = function(){ saveCurrentCompState(); };

  outputFolderEdit.onChange = function(){ saveCurrentCompState(); };
  aeFolderEdit.onChange = function(){ saveCurrentCompState(); };

  chooseFolderBtn.onClick = function(){
    var folder = Folder.selectDialog("Choose output folder");
    if (folder){ outputFolderEdit.text = folder.fsName; saveCurrentCompState(); }
  };

  pickAEFolderBtn.onClick = function(){
    var sel = app.project.selection;
    if (!sel || sel.length === 0){ alert("Select a folder in the Project panel first."); return; }
    var item = sel[0];
    if (!(item instanceof FolderItem)){ alert("Selected item is not a folder."); return; }
    aeFolderEdit.text = getAEFolderPath(item);
    saveCurrentCompState();
  };

  viewLogBtn.onClick = function(){
    if (LOG.exists) LOG.execute();
    else alert("No log yet at: " + LOG.fsName);
  };

  clearSessionBtn.onClick = function(){
    settings.sessionCount = 0;
    settings.sessionCost = 0;
    refreshSessionCounter();
    persistAllSettings();
  };

  clearCompMemBtn.onClick = function(){
    if (lastCompId === null){ alert("No active composition."); return; }
    if (!confirm("Clear all saved settings for this composition?\nSlots, model, folders and output settings will reset to defaults.")) return;
    delete compStateCache[lastCompId];
    resetAllUI();
  };

  clearAllMemBtn.onClick = function(){
    if (!confirm("Clear saved settings for ALL compositions?\nThe UI will reset to defaults. This cannot be undone.")) return;
    compStateCache = {};
    resetAllUI();
  };

  function resetAllUI(){
    // Reset generation settings under _applyingState so onChange handlers don't re-save
    _applyingState = true;
    try {
      outputFolderEdit.text = "";
      aeFolderEdit.text = "";
      promptField.text = "";
      promptSrcLayer = null;
      if (promptSrcDrop.items.length > 0) promptSrcDrop.selection = 0;
      var defModelIdx = arrIndexOf(MODEL_KEYS, "nano_banana_pro");
      modelDrop.selection = (defModelIdx >= 0) ? defModelIdx : 0;
      populateAspectDropdown();
      populateResolutionDropdown();
      aspectDrop.selection = 0;
      if (resDrop.enabled){
        for (var ri = 0; ri < resDrop.items.length; ri++){
          if (resDrop.items[ri].text === "1K"){ resDrop.selection = ri; break; }
        }
      }
      varSlider.value = 1;
      varEdit.text = "1";
    } finally {
      _applyingState = false;
    }
    // Reset slots to one empty slot
    while (slots.length > 1){
      var last = slots[slots.length - 1];
      try { slotsContainer.remove(last.group); } catch(_){}
      slots.splice(slots.length - 1, 1);
    }
    relabelSlots();
    if (slots.length === 1){
      slots[0].kind = "none";
      slots[0].layer = null;
      slots[0]._pendingLayerName = null;
      slots[0].topChk.value = false;
      slots[0].lowChk.value = false;
      slots[0].fx.value = false;
      slots[0].dropdown.enabled = true;
    }
    _pendingPromptSrc = null;
    updatePromptFieldVisibility();
    repopulateAllSlotDropdowns();
    setSlotsVisible(true);
    refreshAddButton();
    win.layout.layout(true);
  }

  stopBtn.onClick = function(){
    stopRequested = true;
    statusTxt.text = "Stopping after current image…";
  };

  // ============================================================
  // COMPOSITION MONITORING
  // ============================================================
  var _applyingState = false;

  function saveCurrentCompState(){
    if (_applyingState) return;
    if (lastCompId !== null) saveCompState(lastCompId);
  }

  function saveCompState(compId){
    if (!compId) return;
    var slotData = [];
    for (var i = 0; i < slots.length; i++){
      slotData.push({
        kind:      slots[i].kind,
        layerName: slots[i].layer ? slots[i].layer.name : null,
        fx:        slots[i].fx.value
      });
    }
    compStateCache[compId] = {
      slots:        slotData,
      promptSrc:    promptSrcDrop.selection ? promptSrcDrop.selection.text : null,
      promptText:   promptField.text,
      outputFolder: outputFolderEdit.text,
      aeFolder:     aeFolderEdit.text,
      model:        MODEL_KEYS[modelDrop.selection.index],
      aspect:       aspectDrop.selection ? aspectDrop.selection.text : "Match comp",
      resolution:   (resDrop.enabled && resDrop.selection) ? resDrop.selection.text : null,
      variations:   Math.round(varSlider.value)
    };
  }

  function applyCompState(compId){
    var state = compStateCache[compId];
    if (!state) {
      // No saved state for this comp — trim back to one empty slot
      while (slots.length > 1){
        var last = slots[slots.length - 1];
        try { slotsContainer.remove(last.group); } catch(_){}
        slots.splice(slots.length - 1, 1);
      }
      relabelSlots();
      if (slots.length === 1){
        slots[0].kind = "none";
        slots[0].layer = null;
        slots[0]._pendingLayerName = null;
        slots[0].topChk.value = false;
        slots[0].lowChk.value = false;
        slots[0].fx.value = false;
        slots[0].dropdown.enabled = true;
      }
      return;
    }
    // Adjust slot count — slotsContainer ops safe here (refPanel hidden by caller)
    while (slots.length > state.slots.length && slots.length > 1){
      var last = slots[slots.length - 1];
      try { slotsContainer.remove(last.group); } catch(_){}
      slots.splice(slots.length - 1, 1);
    }
    while (slots.length < state.slots.length){
      var s = buildSlotUI(slots.length);
      slots.push(s);
    }
    relabelSlots();
    // Pre-set kind and a pending name so populateSlotDropdown resolves the layer
    // from its explicitly-passed comp rather than calling activeComp() here,
    // which is unreliable at comp-switch time.
    for (var i = 0; i < slots.length && i < state.slots.length; i++){
      var sd = state.slots[i];
      slots[i].kind  = sd.kind;
      slots[i].layer = null;
      slots[i]._pendingLayerName = (sd.kind === "layer") ? sd.layerName : null;
      slots[i].fx.value = sd.fx;
    }
    // Signal populatePromptSourceDropdown to use saved source text as restore target
    _pendingPromptSrc = state.promptSrc;
    // Restore prompt text (updatePromptFieldVisibility cleans up placeholder if needed)
    if (typeof state.promptText === "string") promptField.text = state.promptText;
    // Restore per-comp output/AE folder and generation settings
    _applyingState = true;
    try {
      if (typeof state.outputFolder === "string") outputFolderEdit.text = state.outputFolder;
      if (typeof state.aeFolder     === "string") aeFolderEdit.text     = state.aeFolder;
      if (state.model) {
        for (var mi = 0; mi < MODEL_KEYS.length; mi++){
          if (MODEL_KEYS[mi] === state.model){ modelDrop.selection = mi; break; }
        }
        // Re-populate dependent dropdowns for the restored model
        populateAspectDropdown();
        populateResolutionDropdown();
        updateApiKeyFields();
      }
      if (state.aspect) {
        for (var ai = 0; ai < aspectDrop.items.length; ai++){
          if (aspectDrop.items[ai].text === state.aspect){ aspectDrop.selection = ai; break; }
        }
      }
      if (state.resolution && resDrop.enabled) {
        for (var ri = 0; ri < resDrop.items.length; ri++){
          if (resDrop.items[ri].text === state.resolution){ resDrop.selection = ri; break; }
        }
      }
      var sv = parseInt(state.variations, 10);
      if (!isNaN(sv) && sv >= 1 && sv <= 10){
        varSlider.value = sv;
        varEdit.text = String(sv);
      }
    } finally {
      _applyingState = false;
    }
  }

  function compLayerFingerprint(comp){
    if (!comp) return "";
    var parts = [];
    for (var i = 1; i <= comp.numLayers; i++){
      var L = comp.layer(i);
      parts.push(L.name + ":" + (L.enabled ? "1" : "0"));
    }
    return parts.join("|");
  }

  function refreshForComp(){
    if (generating) return;
    var c = activeComp();
    var cid   = c ? c.id   : null;
    var cname = c ? c.name : null;
    var fp    = c ? compLayerFingerprint(c) : "";

    var compChanged   = (cid !== lastCompId || cname !== lastCompName);
    var layersChanged = !compChanged && (fp !== lastLayerFingerprint);

    if (compChanged || layersChanged){
      var prevId = lastCompId;
      lastCompId           = cid;
      lastCompName         = cname;
      lastLayerFingerprint = fp;
      if (c){
        if (compChanged){
          log("Active comp changed: " + (cname || "(none)"));
          saveCompState(prevId);
          applyCompState(cid);   // run while slotsContainer is visible so new groups render
        } else {
          log("Layers changed in: " + (cname || "(none)"));
        }
        slotsContainer.visible = false;
        promptSrcRow.visible   = false;
        try {
          populatePromptSourceDropdown(c);
          repopulateAllSlotDropdowns(c);
          refreshAddButton();
        } finally {
          promptSrcRow.visible   = true;
          slotsContainer.visible = true;
          refPanel.visible       = true;
        }
        win.layout.layout(true);
      }
    }
  }

  function scheduleMonitor(){
    try {
      app.scheduleTask("$._comfyCloudGenPanel.tick && $._comfyCloudGenPanel.tick()", POLL_MS, false);
    } catch(_){}
  }
  $._comfyCloudGenPanel.tick = function(){
    if ($._comfyCloudGenPanel._sessionId !== sessionId) return;
    try { refreshForComp(); } catch(e){ log("Monitor tick error: " + e); }
    scheduleMonitor();
  };

  // ============================================================
  // SETTINGS PERSISTENCE FROM UI
  // ============================================================
  function persistAllSettings(){
    settings.host = hostEdit.text;
    settings.port = portEdit.text;
    settings.outputFolder = outputFolderEdit.text;
    settings.apiKey          = apiKeyEdit.text;
    settings.googleApiKey    = googleApiKeyEdit.text;
    settings.aeProjectFolder = aeFolderEdit.text;
    settings.filenamePrefix  = filePrefixEdit.text;
    settings.lastModel = MODEL_KEYS[modelDrop.selection.index];
    var asp = aspectDrop.selection ? aspectDrop.selection.text : "Match comp";
    settings.lastAspect = (asp === "Match comp") ? "match_comp" : asp;
    if (resDrop.enabled && resDrop.selection) settings.lastResolution = resDrop.selection.text;
    settings.lastVariations = Math.round(varSlider.value);
    if (renderTmplDrop.selection) settings.renderTemplateName = renderTmplDrop.selection.text;
    saveSettings(settings);
  }

  // ============================================================
  // ENSURE OUTPUT FOLDER
  // ============================================================
  function resolveOutputFolder(){
    var path = outputFolderEdit.text;
    if (!path || path.length === 0){
      var projFile = app.project ? app.project.file : null;
      if (projFile && projFile.exists){
        path = projFile.parent.fsName;
      } else {
        path = Folder.temp.fsName;
      }
      outputFolderEdit.text = path;
    }
    var f = new Folder(path);
    if (!f.exists && !f.create()) die("Cannot create output folder:\n" + path);
    return f;
  }

  // ============================================================
  // COST CONFIRMATION DIALOG
  // ============================================================
  function showCostDialog(plan, totalCredits, model, resolution, resolvedAspect){

    // Group plan items by segIndex to collapse variation duplicates into one row
    var segments = [];
    var segMap   = {};
    for (var i = 0; i < plan.length; i++) {
      var pItem = plan[i];
      var key   = String(pItem.segIndex);
      if (!segMap[key]) {
        segMap[key] = { item: pItem, varCount: 0 };
        segments.push(segMap[key]);
      }
      segMap[key].varCount++;
    }

    // How many ref columns to show (cap at 3)
    var maxRefs = 0;
    for (var pi = 0; pi < plan.length; pi++) {
      var rlen = (plan[pi].refs && plan[pi].refs.length) ? plan[pi].refs.length : 0;
      if (rlen > maxRefs) maxRefs = rlen;
    }
    var showRefCols = (maxRefs > 3) ? 3 : maxRefs;

    // --- Pass 1: build display strings for every row ---
    var rowData = [];
    var fullPrompts = [];
    for (var si = 0; si < segments.length; si++) {
      var seg   = segments[si];
      var sItem = seg.item;

      fullPrompts.push(sItem.prompt || "");

      var promptStr = (sItem.prompt || "").replace(/[\r\n]+/g, " ");
      if (promptStr.length > 50) promptStr = promptStr.substring(0, 49) + "...";
      if (!promptStr || promptStr.replace(/\s/g, "") === "") promptStr = "(layer text)";

      var refTexts = [];
      for (var ri = 0; ri < showRefCols; ri++) {
        var refTxt = "-";
        if (sItem.refs && sItem.refs[ri]) {
          try {
            var rLayer = sItem.refs[ri].layer;
            if (rLayer) refTxt = rLayer.index + ". " + rLayer.name;
          } catch(_){ refTxt = "-"; }
          var fxOn = false;
          try { fxOn = !!sItem.refs[ri].useRenderFX; } catch(_){}
          if (fxOn) refTxt += " [FX]";
          if (refTxt.length > 50) refTxt = refTxt.substring(0, 49) + "...";
        }
        refTexts.push(refTxt);
      }
      rowData.push({
        num:       String(si + 1),
        promptStr: promptStr,
        refTexts:  refTexts,
        aspectStr: resolvedAspect || "auto",
        resStr:    model.supportsResolution ? (resolution || "-") : null,
        varStr:    String(seg.varCount)
      });
    }

    // --- Column titles (order must match subItems assignment below) ---
    var colTitles = ["#", "Prompt"];
    for (var rc = 0; rc < showRefCols; rc++) {
      colTitles.push("Ref " + (rc + 1));
    }
    colTitles.push("Aspect");
    if (model.supportsResolution) colTitles.push("Res.");
    colTitles.push("Vars");

    // --- Pass 2: auto-size each column to its widest content ---
    var CHAR_PX = 7.5, COL_PAD = 16, MAX_COL = 260;
    function colW(str){ return str ? Math.ceil(str.length * CHAR_PX) + COL_PAD : COL_PAD; }

    var colWidths = [];
    colWidths.push(Math.max(28,  colW("#")));
    colWidths.push(Math.max(130, colW("Prompt")));
    for (var rc2 = 0; rc2 < showRefCols; rc2++) {
      colWidths.push(Math.max(90, colW("Ref " + (rc2+1))));
    }
    colWidths.push(Math.max(55,  colW("Aspect")));
    if (model.supportsResolution) colWidths.push(Math.max(40, colW("Res.")));
    colWidths.push(Math.max(34,  colW("Vars")));

    for (var di = 0; di < rowData.length; di++) {
      var d = rowData[di];
      var aspIdx = 2 + showRefCols;
      colWidths[0] = Math.max(colWidths[0], colW(d.num));
      colWidths[1] = Math.max(colWidths[1], colW(d.promptStr));
      for (var ri2 = 0; ri2 < showRefCols; ri2++)
        colWidths[2 + ri2] = Math.max(colWidths[2 + ri2], colW(d.refTexts[ri2]));
      colWidths[aspIdx] = Math.max(colWidths[aspIdx], colW(d.aspectStr));
      if (model.supportsResolution) colWidths[aspIdx + 1] = Math.max(colWidths[aspIdx + 1], colW(d.resStr));
      colWidths[colWidths.length - 1] = Math.max(colWidths[colWidths.length - 1], colW(d.varStr));
    }
    for (var ci = 0; ci < colWidths.length; ci++)
      if (colWidths[ci] > MAX_COL) colWidths[ci] = MAX_COL;

    var totalW = 0;
    for (var cw = 0; cw < colWidths.length; cw++) totalW += colWidths[cw];
    totalW += 28; // scrollbar + border
    if (totalW < 380) totalW = 380;

    // --- Build the resizable dialog ---
    var dlg = new Window("dialog", "Confirm Generation", undefined, {resizeable: true});
    dlg.orientation   = "column";
    dlg.alignChildren = ["fill", "top"];
    dlg.margins       = 14;
    dlg.spacing       = 8;

    var modelLbl = dlg.add("statictext", undefined, model.displayName);
    modelLbl.alignment = ["left", "top"];

    var lbHeight = (segments.length * 22) + 30;
    if (lbHeight < 60)  lbHeight = 60;
    if (lbHeight > 300) lbHeight = 300;

    var lb = dlg.add("listbox", undefined, undefined, {
      numberOfColumns: colTitles.length,
      showHeaders:     true,
      columnTitles:    colTitles,
      columnWidths:    colWidths
    });
    lb.preferredSize = [totalW, lbHeight];
    lb.alignment     = ["fill", "fill"];

    // --- Populate rows from pre-built rowData ---
    for (var ri3 = 0; ri3 < rowData.length; ri3++) {
      var d2     = rowData[ri3];
      var row    = lb.add("item", d2.num);
      var subIdx = 0;
      row.subItems[subIdx++].text = d2.promptStr;
      for (var rk = 0; rk < showRefCols; rk++) {
        row.subItems[subIdx++].text = d2.refTexts[rk];
      }
      row.subItems[subIdx++].text = d2.aspectStr;
      if (model.supportsResolution) row.subItems[subIdx++].text = d2.resStr;
      row.subItems[subIdx++].text = d2.varStr;
    }

    // Full prompt preview pane (listbox cells are single-line only)
    var prevLbl = dlg.add("statictext", undefined, "Full prompt:");
    prevLbl.alignment = ["left", "top"];
    var prevField = dlg.add("edittext", undefined, "", {multiline: true});
    prevField.preferredSize = [totalW, 60];
    prevField.alignment = ["fill", "top"];

    lb.onChange = function(){
      var sel = lb.selection;
      prevField.text = sel ? (fullPrompts[sel.index] || "") : "";
    };

    if (fullPrompts.length > 0){
      lb.selection = 0;
      prevField.text = fullPrompts[0];
    }

    // Footer summary
    var footerLbl = dlg.add("statictext", undefined,
      "Total generations: " + plan.length +
      "   |   Estimated cost: " + totalCredits.toFixed(1) + " credits");
    footerLbl.alignment = ["left", "top"];

    // Buttons
    var btnRow    = dlg.add("group");
    btnRow.orientation = "row";
    btnRow.alignment   = ["right", "top"];
    var cancelBtn = btnRow.add("button", undefined, "Cancel",   {name: "cancel"});
    var goBtn     = btnRow.add("button", undefined, "Generate", {name: "ok"});
    cancelBtn.onClick = function(){ dlg.close(0); };
    goBtn.onClick     = function(){ dlg.close(1); };

    dlg.onResizing = dlg.onResize = function(){ this.layout.resize(); };

    return dlg.show() === 1;
  }

  // ============================================================
  // POLL TO COMPLETION
  // ============================================================
  function pollUntilDone(promptId, host, port, timeoutMs){
    var t0 = new Date().getTime();
    while (true){
      if (stopRequested) return null;
      var hist = httpHistoryMaybe(promptId, host, port);
      if (hist && hist[promptId]){
        return hist[promptId];
      }
      if ((new Date().getTime() - t0) > timeoutMs){
        die("Timeout waiting for generation to complete (prompt " + promptId + ")");
      }
      sleep(POLL_MS);
    }
  }

  function findOutputFilenamesInHistory(histEntry, saveNodeId){
    var out = [];
    if (!histEntry || !histEntry.outputs) return out;
    var nodeOutputs = histEntry.outputs[saveNodeId];
    if (nodeOutputs && nodeOutputs.images){
      for (var i = 0; i < nodeOutputs.images.length; i++){
        out.push(nodeOutputs.images[i]);
      }
    } else {
      // Fallback: search all output nodes for images
      for (var k in histEntry.outputs){
        if (!histEntry.outputs.hasOwnProperty(k)) continue;
        var n = histEntry.outputs[k];
        if (n && n.images){
          for (var j = 0; j < n.images.length; j++) out.push(n.images[j]);
        }
      }
    }
    return out;
  }

  // Returns a human-readable error string if ComfyUI reported an execution_error, else null.
  function extractComfyError(histEntry){
    try {
      var status = histEntry && histEntry.status;
      if (!status) return null;
      var msgs = status.messages;
      if (!msgs) return null;
      for (var i = 0; i < msgs.length; i++){
        var m = msgs[i];
        if (m && m[0] === "execution_error" && m[1]){
          var d = m[1];
          var nodeInfo = d.node_type ? (" [node: " + d.node_type + "]") : "";
          return (d.exception_message || "Unknown ComfyUI error") + nodeInfo;
        }
      }
    } catch(e){}
    return null;
  }

  // ============================================================
  // GENERATE ORCHESTRATOR
  // ============================================================
  genBtn.onClick = function(){
    try { runGenerate(); } catch(e){
      statusTxt.text = "Error";
      log("Generate error: " + e.toString());
      alert("Error: " + e.message + "\n\nLog: " + LOG.fsName);
    } finally {
      generating = false;
      stopRequested = false;
      genBtn.enabled = true;
      stopBtn.enabled = false;
    }
  };

  function runGenerate(){
    if (generating){ alert("Generation already in progress."); return; }
    persistAllSettings();

    var comp = activeComp();
    if (!comp){ alert("No active composition."); return; }

    var modelKey = MODEL_KEYS[modelDrop.selection.index];
    var model = getModel(modelKey);
    var hasActiveSlot = false;
    for (var i = 0; i < slots.length; i++){
      if (slots[i].kind !== "none"){ hasActiveSlot = true; break; }
    }
    var mode = hasActiveSlot ? "i2i" : "t2i";

    var promptSource = promptSrcDrop.selection ? promptSrcDrop.selection.text : PROMPT_SRC_TYPED;
    if (promptSource !== PROMPT_SRC_TYPED && promptSource !== PROMPT_SRC_TOP_TEXT){
      promptSource = promptSource.replace(/^\d+\. /, "");
    }
    var typedPrompt = promptField.text;
    if (promptSource === PROMPT_SRC_TYPED && (!typedPrompt || typedPrompt.replace(/\s/g,"") === "")){
      alert("Prompt is empty.");
      return;
    }

    var variations = Math.max(1, Math.round(varSlider.value));

    // Slot config
    var slotConfigs = [];
    if (mode === "i2i"){
      for (var i = 0; i < slots.length; i++){
        slotConfigs.push({ kind: slots[i].kind, layer: slots[i].layer, useRenderFX: !!slots[i].fx.value });
      }
    }

    var planResult = planGenerations({
      comp: comp,
      model: model,
      mode: mode,
      variations: variations,
      promptSource: promptSource,
      typedPrompt: typedPrompt,
      slots: slotConfigs
    });
    var plan = planResult.plan;
    var skips = planResult.skips;

    if (skips.length > 0){
      for (var sk = 0; sk < skips.length; sk++) log("SKIP: " + skips[sk]);
    }

    if (plan.length === 0){
      var msg = "Nothing to generate.";
      if (skips.length > 0) msg += "\n\nSkips:\n- " + skips.join("\n- ");
      alert(msg);
      return;
    }

    // Aspect / resolution
    var aspChoice = aspectDrop.selection ? aspectDrop.selection.text : "Match comp";
    var resolvedAspect = aspChoice;
    if (aspChoice === "Match comp"){
      var compRatio = comp.width / comp.height;
      resolvedAspect = chooseClosestAspect(model, compRatio);
      log("Match comp: comp ratio " + compRatio.toFixed(3) + " → " + resolvedAspect);
    }
    var resolution = (model.supportsResolution && resDrop.selection) ? resDrop.selection.text : null;

    // Cost estimate
    var perImg = estimateCreditsPerImage(model, resolution);
    var totalCredits = plan.length * perImg;

    if (!showCostDialog(plan, totalCredits, model, resolution, resolvedAspect)){
      log("Cost dialog cancelled by user");
      return;
    }

    // Resolve output folder
    var outFolder = resolveOutputFolder();

    generating = true;
    stopRequested = false;
    genBtn.enabled = false;
    stopBtn.enabled = true;

    var host = hostEdit.text, port = portEdit.text;
    var successCount = 0, failCount = 0, skipCount = 0;
    var errorMessages = [];

    for (var p = 0; p < plan.length; p++){
      if (stopRequested){
        log("Stop requested; halting after " + p + " of " + plan.length);
        break;
      }
      var item = plan[p];
      statusTxt.text = "Generating " + (p+1) + " of " + plan.length + "…";
      log("Item " + (p+1) + "/" + plan.length + " — prompt='" + (item.prompt||"").substring(0,60) + "' refs=" + (item.refs?item.refs.length:0));
      try {
        runSingleGeneration(model, mode, item, resolvedAspect, resolution, outFolder, comp, host, port, settings.apiKey || "", settings.googleApiKey || "");
        successCount++;
        settings.sessionCount = (settings.sessionCount||0) + 1;
        settings.sessionCost = (settings.sessionCost||0) + perImg;
        refreshSessionCounter();
        persistAllSettings();
        try { app.project.save(); } catch(saveErr){ log("Project save failed: " + saveErr); }
      } catch(itemErr){
        failCount++;
        var msg = itemErr.message || String(itemErr);
        errorMessages.push("Item " + (p+1) + ": " + msg);
        log("Item " + (p+1) + " failed: " + msg);
      }
    }

    statusTxt.text = "Done";
    var summary = "Generated " + successCount + " image(s)";
    if (failCount > 0) summary += "\n" + failCount + " failed:\n" + errorMessages.join("\n");
    if (skips.length > 0) summary += "\n" + skips.length + " plan-time skips (see log)";
    if (stopRequested) summary += "\nStopped early at user request";
    alert(summary);
  }

  // ============================================================
  // SINGLE GENERATION
  // ============================================================
  function runSingleGeneration(model, mode, item, aspect, resolution, outFolder, comp, host, port, apiKey, googleApiKey){
    // 1. For I2I: materialize each ref layer (raw source or render-with-effects), upload to ComfyUI
    var uploadedNames = [];
    if (mode === "i2i" && item.refs && item.refs.length > 0){
      // Move comp playhead to the key frame so Render FX and precomp renders capture the right frame
      var savedCompTime = comp.time;
      try { comp.time = item.segStart; } catch(_){}
      try {
        for (var i = 0; i < item.refs.length; i++){
          var ref = item.refs[i];
          if (!ref || !ref.layer) die("Internal error: ref " + i + " has no layer at submit time");
          var srcFile = materializeRefLayer(ref.layer, comp, outFolder, ref.useRenderFX);
          var uploadedName = httpUploadImage(srcFile, host, port);
          uploadedNames.push(uploadedName);
          // Clean up temp files: render-FX renders AND precomp renders (both produce temp PNGs)
          var isPrecompRef = ref.layer && ref.layer.source && typeof ref.layer.source.numLayers === "number";
          if ((ref.useRenderFX || isPrecompRef) && srcFile && srcFile.exists){
            try { srcFile.remove(); } catch(_){}
          }
        }
      } finally {
        try { comp.time = savedCompTime; } catch(_){}
      }
    }

    // 2. Build the workflow with prompt/seed/aspect/resolution/slots resolved
    var wf = buildWorkflow(model, mode, {
      prompt: item.prompt,
      seed: rand32(),
      aspect: aspect,
      resolution: resolution,
      uploadedSlotFilenames: uploadedNames,
      filenamePrefix: settings.filenamePrefix || "CloudGen",
      googleApiKey: googleApiKey || ""
    });

    // 3. Submit
    var submitResp = httpPostPrompt(wf, host, port, apiKey);
    if (!submitResp || !submitResp.prompt_id) die("ComfyUI did not return a prompt_id");
    var promptId = submitResp.prompt_id;
    log("Submitted prompt_id=" + promptId);

    // 4. Poll until done (timeout 5 min)
    var hist = pollUntilDone(promptId, host, port, 5 * 60 * 1000);
    if (!hist){
      log("Cancelled mid-poll for prompt " + promptId);
      return;
    }

    // 5. Get output filename(s) from history
    var images = findOutputFilenamesInHistory(hist, model.saveNodeId);
    if (images.length === 0){
      var comfyErr = extractComfyError(hist);
      if (comfyErr) die("ComfyUI node error: " + comfyErr);
      die("No image output found in history for " + promptId);
    }

    // 6. Download each
    var downloaded = [];
    for (var im = 0; im < images.length; im++){
      var info = images[im];
      var viewPath = "/view?filename=" + encodeURIComponent(info.filename)
                   + "&subfolder=" + encodeURIComponent(info.subfolder || "")
                   + "&type=" + encodeURIComponent(info.type || "output");
      var localFile = new File(outFolder.fsName + "/" + info.filename);
      httpDownloadToFile(viewPath, localFile, host, port);
      downloaded.push(localFile);
    }

    // 7. Import into AE and add to comp
    app.beginUndoGroup("CloudGen import");
    try {
      for (var d = 0; d < downloaded.length; d++){
        var lf = downloaded[d];
        var io = new ImportOptions(lf);
        var footage = app.project.importFile(io);
        var aeFolder = findOrCreateAEProjectFolder(settings.aeProjectFolder || "");
        if (aeFolder) try { footage.parentFolder = aeFolder; } catch(_){}
        var L = comp.layers.add(footage);

        // Time placement: matched to segment range (or playhead frame for typed mode)
        if (item.segStart !== undefined && item.segEnd !== undefined && item.segEnd > item.segStart){
          setLayerInOut(L, item.segStart, item.segEnd, comp);
        }
        fitLayerToComp(L, comp);

        // Rename layer with batch context
        var baseLabel = item.textLayer ? item.textLayer.name : ((item.prompt||"").substring(0,24) || "CloudGen");
        var renamed = baseLabel + " | seg" + (item.segIndex+1) + " | var" + (item.varIndex+1);
        try { L.name = renamed; } catch(_){}
      }
    } finally {
      app.endUndoGroup();
    }
    try { comp.openInViewer(); } catch(_){}
  }

  // ============================================================
  // INITIAL UI POPULATION & MONITORING START
  // ============================================================
  populateAspectDropdown();
  populateResolutionDropdown();
  populateRenderTemplateDropdown();
  populatePromptSourceDropdown();
  updateApiKeyFields();
  // Start with one slot
  if (slots.length === 0) addSlot();
  // Reference panel always visible
  setSlotsVisible(true);
  refreshAddButton();

  // Initial comp snapshot
  lastCompId = activeComp() ? activeComp().id : null;
  lastCompName = activeComp() ? activeComp().name : null;

  // Start scheduled task
  scheduleMonitor();

  // Layout and show
  win.onResizing = win.onResize = function(){ this.layout.resize(); };
  if (win instanceof Window){
    win.center();
    win.show();
  } else {
    win.layout.layout(true);
    win.layout.resize();
  }

})(this);
