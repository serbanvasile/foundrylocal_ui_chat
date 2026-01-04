import express from 'express';
import { OpenAI } from 'openai';
import { FoundryLocalManager } from 'foundry-local-sdk';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const app = express();
const port = 3000;

// Helper to check service list for alias and return modelId if loaded
async function findModelInService(alias) {
  try {
    const { stdout } = await execAsync('foundry service list');
    const lines = stdout.trim().split('\n');
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('🟢')) {
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          const a = parts[1];
          const id = parts.slice(2).join(' ');
          if (a === alias) return id;
        }
      }
    }
    return null;
  } catch (err) {
    console.error('findModelInService error:', err);
    return null;
  }
}

// Helper: load cached models that are not currently running
async function ensureModelsLoaded() {
  try {
    const cacheResult = await execAsync('foundry cache list');
    const cacheLines = cacheResult.stdout.trim().split('\n');
    const cachedModels = [];
    for (let i = 2; i < cacheLines.length; i++) {
      const line = cacheLines[i].trim();
      if (line.startsWith('💾')) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) cachedModels.push(parts[1]);
      }
    }

    const serviceResult = await execAsync('foundry service list');
    const serviceLines = serviceResult.stdout.trim().split('\n');
    const loadedModels = [];
    for (let i = 2; i < serviceLines.length; i++) {
      const line = serviceLines[i].trim();
      if (line.startsWith('🟢')) {
        const parts = line.split(/\s+/);
        if (parts.length >= 2) loadedModels.push(parts[1]);
      }
    }

    for (const alias of cachedModels) {
      if (!loadedModels.includes(alias)) {
        console.log(`Loading model on startup: ${alias}`);
        await new Promise((resolve, reject) => {
          const child = exec(`foundry model load ${alias}`);
          child.stdout.on('data', (d) => console.log('Model load stdout:', d.toString()));
          child.stderr.on('data', (d) => console.error('Model load stderr:', d.toString()));
          child.on('close', (code) => code === 0 ? resolve() : reject(new Error('code ' + code)));
          child.on('error', reject);
        });
        console.log(`Model ${alias} loaded.`);
      }
    }
  } catch (err) {
    console.error('Error ensuring models loaded:', err);
  }
}

// Start Foundry service first so `foundry service list` works reliably
console.log('Running: foundry service start');
try {
  const startOutput = await execAsync('foundry service start');
  console.log('Start output:', startOutput.stdout || startOutput.stderr);
} catch (err) {
  console.error('Error starting foundry service:', err);
}

console.log('Running: foundry service status');
try {
  const statusOutput = await execAsync('foundry service status');
  console.log('Status output:', statusOutput.stdout);
  const portMatch = statusOutput.stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
  const servicePort = portMatch ? portMatch[1] : '51827';
  console.log('Detected port:', servicePort);
} catch (err) {
  console.error('Error getting service status:', err);
}

// Ensure no models are loaded at server start to avoid preloading everything.
// This will unload any loaded models so the UI starts with no loaded model.
try {
  const { stdout: svcOut } = await execAsync('foundry service list');
  console.log('Initial foundry service list:\n', svcOut);
  const svcLines = svcOut.trim().split('\n');
  const toUnload = [];
  for (let i = 2; i < svcLines.length; i++) {
    const line = svcLines[i].trim();
    if (line.startsWith('🟢')) {
      const parts = line.split(/\s+/);
      if (parts.length >= 3) {
        const loadedModelId = parts.slice(2).join(' '); // Get the Model ID, not alias
        toUnload.push(loadedModelId);
      }
    }
  }
  for (const loadedModelId of toUnload) {
    try {
      console.log(`Unloading at startup: foundry model unload ${loadedModelId}`);
      const child = exec(`foundry model unload ${loadedModelId}`);
      child.stdout.on('data', (d) => console.log('startup unload stdout:', d.toString()));
      child.stderr.on('data', (d) => console.error('startup unload stderr:', d.toString()));
      await new Promise((resolve, reject) => child.on('close', (code) => code === 0 ? resolve() : reject(new Error('code ' + code))));
      console.log(`Startup: unloaded ${loadedModelId}`);
    } catch (e) {
      console.error('Error unloading at startup for', loadedModelId, e);
    }
  }
} catch (e) {
  console.error('Error checking initial service list for unload:', e);
}

// Do NOT auto-load cached models on startup. Models will be loaded on-demand.
// await ensureModelsLoaded();

// Create Foundry manager
const foundryLocalManager = new FoundryLocalManager();

// Store conversation history
let conversation = [];

// Serve static UI files from ./public
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error('Bad JSON:', err.message, 'Raw:', req.rawBody);
    return res.status(400).send({ status: 400, message: err.message });
  }
  next();
});
app.use(express.static('public'));

// API endpoint to get available models (only those loaded in service)
app.get('/models', async (req, res) => {
  try {
    // First, get full model list to build a lookup by Model ID
    // Model list format: Alias, Device, Task, File Size, License, Model ID
    const modelListOut = await execAsync('foundry model list');
    const modelLines = modelListOut.stdout.split('\n');
    const modelInfoByModelId = new Map(); // modelId -> { alias, device, task, fileSize, license }
    let currentAlias = '';
    for (const raw of modelLines) {
      const line = raw.trim();
      if (!line || line.startsWith('-')) continue; // skip empty lines and separators

      // Non-indented lines have the alias at the start
      if (!raw.startsWith(' ')) {
        const parts = line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 6) {
          // Full line: Alias Device Task FileSize License ModelID
          currentAlias = parts[0];
          const device = parts[1] || '';
          const task = parts[2] || '';
          const fileSize = parts[3] || '';
          const license = parts[4] || '';
          const modelId = parts[5] || '';
          if (modelId) {
            modelInfoByModelId.set(modelId, { alias: currentAlias, device, task, fileSize, license });
          }
        }
      } else {
        // Indented variant lines: Device Task FileSize License ModelID
        const parts = line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 5 && currentAlias) {
          const device = parts[0] || '';
          const task = parts[1] || '';
          const fileSize = parts[2] || '';
          const license = parts[3] || '';
          const modelId = parts[4] || '';
          if (modelId) {
            modelInfoByModelId.set(modelId, { alias: currentAlias, device, task, fileSize, license });
          }
        }
      }
    }

    // Build list from cache and mark which are loaded
    const cacheOut = await execAsync('foundry cache list');
    const cacheLines = cacheOut.stdout.trim().split('\n');
    const cached = [];
    for (let i = 2; i < cacheLines.length; i++) {
      const line = cacheLines[i].trim();
      if (line.startsWith('💾')) {
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          const alias = parts[1];
          const modelId = parts.slice(2).join(' ');
          // Look up the model info by modelId to get the correct device/task/size
          const info = modelInfoByModelId.get(modelId) || {};
          // Fallback: extract device from modelId if not found in lookup
          let device = info.device || '';
          if (!device && modelId) {
            const modelIdLower = modelId.toLowerCase();
            if (modelIdLower.includes('-npu')) device = 'NPU';
            else if (modelIdLower.includes('-gpu')) device = 'GPU';
            else if (modelIdLower.includes('-cpu')) device = 'CPU';
          }
          cached.push({
            alias,
            id: modelId,
            loaded: false,
            device: device,
            task: info.task || '',
            fileSize: info.fileSize || '',
            license: info.license || ''
          });
        }
      }
    }

    const serviceOut = await execAsync('foundry service list');
    const serviceLines = serviceOut.stdout.trim().split('\n');
    for (let i = 2; i < serviceLines.length; i++) {
      const line = serviceLines[i].trim();
      if (line.startsWith('🟢')) {
        const parts = line.split(/\s+/);
        if (parts.length >= 3) {
          const alias = parts[1];
          const modelId = parts.slice(2).join(' ');
          // Find the cached entry by modelId (not alias) for correct variant matching
          const entry = cached.find((c) => c.id === modelId);
          if (entry) entry.loaded = true;
          else {
            // if not cached, still expose as loaded
            const info = modelInfoByModelId.get(modelId) || {};
            let device = info.device || '';
            if (!device && modelId) {
              const modelIdLower = modelId.toLowerCase();
              if (modelIdLower.includes('-npu')) device = 'NPU';
              else if (modelIdLower.includes('-gpu')) device = 'GPU';
              else if (modelIdLower.includes('-cpu')) device = 'CPU';
            }
            cached.push({
              alias,
              id: modelId,
              loaded: true,
              device: device,
              task: info.task || '',
              fileSize: info.fileSize || '',
              license: info.license || ''
            });
          }
        }
      }
    }
    res.json({ models: cached });
  } catch (err) {
    console.error('Error listing models:', err);
    res.status(500).json({ error: 'Failed to list models' });
  }
});

// Track currently loaded model
let currentLoadedAlias = null;
let currentLoadedModelId = null;

// SSE endpoint to load a model on-demand. Streams load/unload progress.
app.get('/load', async (req, res) => {
  const modelId = req.query.modelId; // Full model ID for loading specific variant
  const alias = req.query.alias;
  if (!modelId || !alias) return res.status(400).json({ error: 'modelId and alias required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function sendEvent(obj) {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      console.error('Failed to write SSE event, client may have disconnected:', e);
    }
  }

  try {
    console.log('/load called for modelId:', modelId, 'alias:', alias);
    // Check if the specific modelId is already loaded in service
    let alreadyLoadedId = await findModelInService(alias);

    // Unload any loaded models other than the requested modelId to free memory
    try {
      const { stdout: svcOut } = await execAsync('foundry service list');
      console.log('foundry service list (before unload):\n', svcOut);
      const svcLines = svcOut.trim().split('\n');
      const loadedModels = []; // { alias, loadedModelId }
      for (let i = 2; i < svcLines.length; i++) {
        const line = svcLines[i].trim();
        if (line.startsWith('🟢')) {
          const parts = line.split(/\s+/);
          if (parts.length >= 3) {
            const loadedAlias = parts[1];
            const loadedModelId = parts.slice(2).join(' ');
            loadedModels.push({ alias: loadedAlias, modelId: loadedModelId });
          }
        }
      }
      // Unload all loaded models except the requested one (compare by modelId)
      for (const lm of loadedModels) {
        if (lm.modelId === modelId) continue; // Don't unload the one we want
        sendEvent({ log: `Unloading model present in service: ${lm.modelId}` });
        console.log(`Running: foundry model unload ${lm.modelId}`);
        await new Promise((resolve, reject) => {
          const child = exec(`foundry model unload ${lm.modelId}`);
          child.stdout.on('data', (d) => { sendEvent({ log: d.toString() }); console.log('unload stdout:', d.toString()); });
          child.stderr.on('data', (d) => { sendEvent({ log: d.toString() }); console.error('unload stderr:', d.toString()); });
          child.on('close', (code) => { console.log(`foundry model unload ${lm.modelId} exited with code ${code}`); code === 0 ? resolve() : reject(new Error('unload code ' + code)); });
          child.on('error', (err) => { console.error('unload error:', err); reject(err); });
        });
        sendEvent({ log: `Unloaded ${lm.modelId}` });
        // explicitly tell client which alias was unloaded
        sendEvent({ unloaded: lm.alias });
        console.log(`Unloaded model ${lm.modelId}`);
        if (currentLoadedAlias === lm.alias) currentLoadedAlias = null;
      }
      // Wait until all other aliases are gone from service list (small propagation delay)
      const unloadTimeout = 60000; // 60s
      const unloadInterval = 1000;
      const unloadStart = Date.now();
      while (Date.now() - unloadStart < unloadTimeout) {
        const { stdout: nowOut } = await execAsync('foundry service list');
        const nowLines = nowOut.trim().split('\n');
        let stillPresent = false;
        for (let i = 2; i < nowLines.length; i++) {
          const line = nowLines[i].trim();
          if (line.startsWith('🟢')) {
            const parts = line.split(/\s+/);
            const la = parts[1];
            if (la && la !== alias) { stillPresent = true; break; }
          }
        }
        if (!stillPresent) break;
        await new Promise(r => setTimeout(r, unloadInterval));
      }
    } catch (e) {
      sendEvent({ log: 'Warning: error while unloading previous models: ' + e.message });
    }


    // If the exact model is already present in service, skip load step
    if (alreadyLoadedId === modelId) {
      sendEvent({ log: `Model ${modelId} already loaded` });
      try { await foundryLocalManager.init(alias); } catch (e) { sendEvent({ log: 'Warning: SDK init failed: ' + e.message }); }
      currentLoadedAlias = alias;
      sendEvent({ done: true, modelId: alreadyLoadedId });
      res.end();
      return;
    }

    // Start loading requested model by modelId (to get specific variant)
    sendEvent({ log: `Loading model: ${modelId}` });
    console.log(`Running: foundry model load ${modelId}`);
    await new Promise((resolve, reject) => {
      const child = exec(`foundry model load ${modelId}`);
      child.stdout.on('data', (d) => { sendEvent({ log: d.toString() }); console.log('load stdout:', d.toString()); });
      child.stderr.on('data', (d) => { sendEvent({ log: d.toString() }); console.error('load stderr:', d.toString()); });
      child.on('close', (code) => { console.log(`foundry model load ${modelId} exited with code ${code}`); code === 0 ? resolve() : reject(new Error('load code ' + code)); });
      child.on('error', (err) => { console.error('load error:', err); reject(err); });
    });

    // Poll service list until alias appears
    console.log('Starting to poll service list for alias:', alias);
    const timeoutMs = 120000;
    const intervalMs = 1000;
    const start = Date.now();
    let loadedModelId = null;
    while (Date.now() - start < timeoutMs) {
      const id = await findModelInService(alias).catch(() => null);
      console.log('Poll result:', id);
      if (id) { loadedModelId = id; break; }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    console.log('Polling complete, loadedModelId:', loadedModelId);
    if (!loadedModelId) {
      sendEvent({ error: 'Model did not appear in service after loading' });
      res.end();
      return;
    }

    // Initialize via SDK with a timeout
    console.log('Initializing SDK with alias:', alias);
    try {
      const initTimeout = 10000; // 10 second timeout
      await Promise.race([
        foundryLocalManager.init(alias),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SDK init timed out')), initTimeout))
      ]);
      console.log('SDK init complete');
    } catch (e) {
      console.log('SDK init failed or timed out:', e.message);
      sendEvent({ log: 'Warning: SDK init issue: ' + e.message + ' (continuing anyway)' });
    }

    console.log('Sending done event');
    currentLoadedAlias = alias;
    currentLoadedModelId = loadedModelId;
    sendEvent({ done: true, modelId: loadedModelId });
    res.end();
    console.log('Response ended');
  } catch (e) {
    console.error('Error in /load:', e);
    sendEvent({ error: e.message || String(e) });
    res.end();
  }
});

// API endpoint for chat
app.get('/chat', async (req, res) => {
  const userMessage = req.query.message;
  const selectedModel = req.query.model;
  if (!userMessage || !selectedModel) {
    return res.status(400).json({ error: 'Message and model are required' });
  }

  // Client sends model alias in the request; map alias -> modelId and ensure loaded
  const aliasRequested = selectedModel; // alias from client
  let selectedAlias = aliasRequested;
  let modelId = null;

  // First check if we have a currently loaded model matching the alias
  if (currentLoadedAlias === aliasRequested && currentLoadedModelId) {
    modelId = currentLoadedModelId;
    console.log('Using tracked loaded model:', modelId);
  } else {
    // Helper to check service list for alias and return modelId if loaded
    async function findModelInService(alias) {
      const { stdout } = await execAsync('foundry service list');
      const lines = stdout.trim().split('\n');
      for (let i = 2; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('🟢')) {
          const parts = line.split(/\s+/);
          if (parts.length >= 3) {
            const a = parts[1];
            const id = parts.slice(2).join(' ');
            if (a === alias) return id;
          }
        }
      }
      return null;
    }

    try {
      modelId = await findModelInService(selectedAlias);
    } catch (error) {
      console.error('Error checking service list:', error);
      return res.status(500).json({ error: 'Failed to check service list' });
    }
  }

  // If not loaded, check cache and load
  if (!modelId) {
    try {
      console.log('Model not loaded, checking cache...');
      const { stdout } = await execAsync('foundry cache list');
      const lines = stdout.trim().split('\n');
      let foundInCache = false;
      for (let i = 2; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('💾')) {
          const parts = line.split(/\s+/);
          if (parts.length >= 3) {
            const alias = parts[1];
            const id = parts.slice(2).join(' ');
            if (alias === selectedAlias) {
              foundInCache = true;
              break;
            }
          }
        }
      }
      if (!foundInCache) {
        return res.status(400).json({ error: 'Model alias not found in cache' });
      }

      // Launch load process and wait for it to finish
      console.log(`Loading model: ${selectedAlias}`);
      await new Promise((resolve, reject) => {
        const child = exec(`foundry model load ${selectedAlias}`);
        child.stdout.on('data', (d) => console.log('Model load stdout:', d.toString()));
        child.stderr.on('data', (d) => console.error('Model load stderr:', d.toString()));
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error('code ' + code)));
        child.on('error', reject);
      });

      // After load, poll service list until model shows up (handles small propagation delay)
      const timeoutMs = 120000; // 2 minutes
      const intervalMs = 1000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          modelId = await findModelInService(selectedAlias);
          if (modelId) break;
        } catch (e) {
          console.error('Error polling service list:', e);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      if (!modelId) {
        return res.status(500).json({ error: 'Model did not appear in service after loading' });
      }
    } catch (error) {
      console.error('Error loading model:', error);
      return res.status(500).json({ error: 'Failed to load model' });
    }
  }

  // Init the selected model to get the correct endpoint (with timeout)
  let endpoint = null;
  try {
    const initTimeout = 5000; // 5 second timeout
    await Promise.race([
      foundryLocalManager.init(selectedAlias),
      new Promise((_, reject) => setTimeout(() => reject(new Error('SDK init timed out')), initTimeout))
    ]);
    endpoint = foundryLocalManager.endpoint;
  } catch (error) {
    console.error('Error initializing model (will use fallback endpoint):', error.message);
  }

  // Fallback: use the default Foundry service endpoint
  if (!endpoint) {
    try {
      const statusOutput = await execAsync('foundry service status');
      const portMatch = statusOutput.stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      const servicePort = portMatch ? portMatch[1] : '49808';
      endpoint = `http://127.0.0.1:${servicePort}/v1`;
      console.log('Using fallback endpoint:', endpoint);
    } catch (e) {
      endpoint = 'http://127.0.0.1:49808/v1';
      console.log('Using default endpoint:', endpoint);
    }
  }

  // Create OpenAI client with the model's endpoint
  const openai = new OpenAI({
    baseURL: endpoint,
    apiKey: 'not-needed',
  });

  // Add user message to conversation
  conversation.push({ role: 'user', content: userMessage });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    console.log('Sending chat request:', { modelId, messagesCount: conversation.length });
    const stream = await openai.chat.completions.create({
      model: modelId,
      messages: conversation,
      stream: true,
      max_tokens: 2048, // Increase token limit
    });

    let aiResponse = '';
    let clientClosed = false;
    // when client disconnects, attempt to cancel iterator
    res.on('close', async () => {
      clientClosed = true;
      try {
        if (iterator && iterator.return) await iterator.return();
      } catch (e) {
        // ignore
      }
    });

    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      if (clientClosed) break;
      const { value: chunk, done } = await iterator.next();
      if (done) break;
      // Adjust parsing based on model if needed
      let content = '';
      if (selectedModel.includes('qwen')) {
        content = chunk.choices?.[0]?.delta?.content || chunk.choices?.[0]?.text || '';
      } else {
        content = chunk.choices?.[0]?.delta?.content || '';
      }
      if (content) {
        aiResponse += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    // Add AI response to conversation
    conversation.push({ role: 'assistant', content: aiResponse });

    // Send end signal
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Error:', error);
    res.write(`data: ${JSON.stringify({ error: 'Failed to get response from model' })}\n\n`);
    res.end();
  }
});

app.listen(port, () => {
  console.log(`Chat UI server running at http://localhost:${port}`);
});

// API endpoint to list server-available models (foundry model list)
app.get('/server-models', async (req, res) => {
  try {
    const { stdout } = await execAsync('foundry model list');
    const lines = stdout.split('\n');
    const entries = [];
    // parsing: lines include blocks per alias; look for lines with alias at column start
    let currentAlias = '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('-')) continue; // skip empty and separator lines
      // match lines that start with an alias (non-indented)
      if (!raw.startsWith(' ')) {
        // alias line: Alias Device Task FileSize License ModelID
        const parts = line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 6) {
          currentAlias = parts[0];
          const device = parts[1] || '';
          const task = parts[2] || '';
          const fileSize = parts[3] || '';
          const license = parts[4] || '';
          const modelId = parts[5] || '';
          // Create new entry with first variant from this line
          entries.push({
            alias: currentAlias,
            variants: [{ device, task, fileSize, license, modelId }]
          });
        } else if (parts.length >= 1) {
          // Might be a header or just alias - skip
          currentAlias = parts[0];
        }
      } else {
        // indented variant lines: Device Task FileSize License ModelID
        const parts = line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
        if (parts.length >= 5 && entries.length > 0) {
          const last = entries[entries.length - 1];
          last.variants.push({
            device: parts[0],
            task: parts[1],
            fileSize: parts[2],
            license: parts[3],
            modelId: parts[4] || ''
          });
        }
      }
    }

    // Mark which of these are downloaded by checking cache list
    const cacheOut = await execAsync('foundry cache list');
    const cacheLines = cacheOut.stdout.split('\n');
    const cachedModelIds = new Set();
    for (const l of cacheLines) {
      const li = l.trim();
      if (li.startsWith('💾')) {
        const p = li.split(/\s+/);
        if (p.length >= 3) {
          const cachedModelId = p.slice(2).join(' ');
          cachedModelIds.add(cachedModelId);
        }
      }
    }
    // Expand entries to include variant rows for dropdown display
    const flat = [];
    for (const e of entries) {
      for (const v of e.variants) {
        flat.push({
          alias: e.alias,
          device: v.device,
          task: v.task,
          fileSize: v.fileSize,
          license: v.license,
          modelId: v.modelId,
          downloaded: cachedModelIds.has(v.modelId)
        });
      }
    }

    res.json({ models: flat });
  } catch (e) {
    console.error('Error listing server models:', e);
    res.status(500).json({ error: 'Failed to list server models' });
  }
});

// SSE endpoint to download one or more models sequentially
app.get('/download', (req, res) => {
  const aliasesParam = req.query.aliases || '';
  const aliases = aliasesParam.split(',').map(s => s.trim()).filter(Boolean);
  if (aliases.length === 0) return res.status(400).json({ error: 'aliases required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  function sendEvent(obj) {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {
      console.error('Failed to write SSE event in /download, client may have disconnected:', e);
    }
  }

  (async () => {
    try {
      // Helper to run a download with spawn so we stream output reliably and capture stderr
      async function runDownloadOnce(alias) {
        return await new Promise((resolve) => {
          const child = spawn('foundry', ['model', 'download', alias], { shell: true });
          let stderrAccum = '';
          // buffers to handle partial chunking
          let stdoutBuf = '';
          let stderrBuf = '';
          const percentRegex = /(\d{1,3}(?:\.\d+)?)\s*%/;

          // track latest numeric progress and accumulate non-progress logs to batch for SSE
          let lastProgress = null;
          let lastProgressLine = null;
          let recentLogs = [];

          function processStdoutChunk(chunk) {
            stdoutBuf += chunk;
            const parts = stdoutBuf.split(/\r?\n|\r/);
            // keep last partial
            stdoutBuf = parts.pop();
            for (const p of parts) {
              const line = p.trim();
              if (!line) continue;
              // if line contains a percent, update lastProgress but do not spam SSE
              const m = line.match(percentRegex);
              if (m) {
                const val = parseFloat(m[1]);
                if (!isNaN(val)) {
                  lastProgress = val;
                  // keep the entire console line so the client can show the same visual bar/speed
                  lastProgressLine = line;
                  continue; // do not add to recentLogs
                }
              }
              // otherwise accumulate for batched SSE
              recentLogs.push(line);
            }
          }

          const processStderrChunk = (chunk) => {
            stderrBuf += chunk;
            const parts = stderrBuf.split(/\r?\n|\r/);
            stderrBuf = parts.pop();
            for (const p of parts) {
              const line = p.trim();
              if (!line) continue;
              // capture stderr for final error reporting
              stderrAccum += line + '\n';
              // also accumulate into recentLogs for SSE batching
              recentLogs.push(line);
            }
          };

          // throttle SSE updates to once every 2 seconds
          const flushIntervalMs = 2000;
          const flushTimer = setInterval(() => {
            try {
              if (lastProgress !== null) {
                // include the full progress line when available
                sendEvent({ progress: lastProgress, progressLine: lastProgressLine, alias });
              }
              if (recentLogs.length > 0) {
                sendEvent({ log: recentLogs.join('\n'), alias });
                recentLogs = [];
              }
            } catch (e) {
              console.error('Error flushing download SSE buffer:', e);
            }
          }, flushIntervalMs);

          // Pipe raw child output to the server console so terminal shows live progress exactly
          try { child.stdout.pipe(process.stdout); } catch (e) { /* ignore */ }
          try { child.stderr.pipe(process.stderr); } catch (e) { /* ignore */ }
          child.stdout.on('data', (d) => { try { processStdoutChunk(d.toString()); } catch (e) { console.error('stdout process error', e); } });
          child.stderr.on('data', (d) => { try { processStderrChunk(d.toString()); } catch (e) { console.error('stderr process error', e); } });

          child.on('close', (code, signal) => {
            // stop timer and flush any remaining buffered info
            clearInterval(flushTimer);
            try {
              if (stdoutBuf && stdoutBuf.trim()) {
                const line = stdoutBuf.trim();
                const m = line.match(percentRegex);
                if (m) {
                  const val = parseFloat(m[1]); if (!isNaN(val)) lastProgress = val, lastProgressLine = line;
                } else {
                  recentLogs.push(line);
                }
              }
              if (stderrBuf && stderrBuf.trim()) {
                const sline = stderrBuf.trim();
                stderrAccum += sline + '\n';
                recentLogs.push(sline);
              }
              // final flush (include progressLine)
              if (lastProgress !== null) sendEvent({ progress: lastProgress, progressLine: lastProgressLine, alias });
              if (recentLogs.length > 0) sendEvent({ log: recentLogs.join('\n'), alias });
            } catch (e) { console.error('flush buffer error', e); }

            if (code === 0) {
              sendEvent({ log: `Download completed: ${alias}` });
              resolve({ ok: true });
            } else {
              const msg = code !== null && code !== undefined ? `exit code ${code}` : `signal ${signal}`;
              // include captured stderr to help diagnose
              sendEvent({ error: `Download failed for ${alias} (${msg})`, stderr: stderrAccum });
              console.error(`Download failed for ${alias}: ${msg}`);
              console.error('Captured stderr:', stderrAccum);
              resolve({ ok: false, code, stderr: stderrAccum });
            }
          });
          child.on('error', (err) => {
            sendEvent({ error: `Download error for ${alias}: ${err.message}`, stderr: err.message });
            console.error(`Download error for ${alias}:`, err);
            resolve({ ok: false, code: null, stderr: err.message });
          });
        });
      }

      for (const alias of aliases) {
        sendEvent({ log: `Starting download for ${alias}` });
        // Try once, with multiple retries on detected 500/internal server errors
        const first = await runDownloadOnce(alias);
        if (first.ok) continue;

        const stderrFirst = (first.stderr || '').toLowerCase();
        const is500first = stderrFirst.includes('response status code does not indicate success: 500') || stderrFirst.includes('internal server error') || stderrFirst.includes('500 (internal server error)');
        if (!is500first) {
          // not a transient 500-like error; log and continue
          sendEvent({ error: `Download failed for ${alias}`, stderr: first.stderr });
          continue;
        }

        // Detected 500-like error; attempt several retries with backoff and a cache-list check
        const maxRetries = 3;
        let attempt = 1;
        let succeeded = false;
        while (attempt <= maxRetries && !succeeded) {
          sendEvent({ log: `Detected server 500 for ${alias}, retry attempt ${attempt} of ${maxRetries}...` });
          // run a quick 'foundry cache list' to surface any immediate service errors
          try {
            const cacheCheck = await execAsync('foundry cache list');
            sendEvent({ log: `Cache check OK (len ${String(cacheCheck.stdout || '').length})` });
          } catch (e) {
            sendEvent({ log: `Cache check failed: ${e.message || String(e)}` });
          }
          // backoff: 2000ms * attempt
          await new Promise(r => setTimeout(r, 2000 * attempt));
          const retry = await runDownloadOnce(alias);
          if (retry.ok) { succeeded = true; sendEvent({ log: `Retry succeeded for ${alias}` }); break; }
          attempt++;
        }
        if (!succeeded) {
          sendEvent({ error: `Download failed for ${alias} after ${maxRetries} retries`, stderr: first.stderr });
          console.error(`Download failed for ${alias} after retries. First stderr:\n`, first.stderr);
        }
      }

      // after all downloads, refresh cached list so client can refresh local models
      sendEvent({ done: true });
      res.end();
    } catch (err) {
      console.error('Unexpected error in /download:', err);
      try { sendEvent({ error: err.message || String(err) }); } catch (e) { console.error('Failed to send SSE error:', e); }
      try { res.end(); } catch (e) { console.error('Failed to end SSE response:', e); }
    }
  })();
});

// Endpoint to remove a model from the cache (safe, requires modelId or alias in body)
app.post('/cache-remove', async (req, res) => {
  try {
    console.log('/cache-remove received body:', req.body);
    const modelId = req.body && req.body.modelId;
    const alias = req.body && req.body.alias;
    const target = modelId || alias;

    if (!target) return res.status(400).json({ error: 'modelId required' });
    console.log(`Cache remove requested for: ${target}`);

    // First, unload this specific model from the service if loaded
    try {
      const { stdout: svcOut } = await execAsync('foundry service list');
      if (svcOut.includes(target)) {
        console.log(`Unloading ${target} before cache remove`);
        await execAsync(`foundry model unload ${target}`);
        console.log(`Unloaded ${target}`);
        // Clear tracked model if it matches
        if (currentLoadedModelId === target) {
          currentLoadedAlias = null;
          currentLoadedModelId = null;
        }
      }
    } catch (unloadErr) {
      console.log('Warning: error unloading before cache remove:', unloadErr.message);
    }

    // Now remove from cache using target (modelId)
    // Note: Use exact ID to remove specific variant if supported, otherwise alias removes all
    const cmd = `foundry cache remove ${target} --yes`;
    try {
      const { stdout, stderr } = await execAsync(cmd);
      console.log('cache remove stdout:', stdout);
      if (stderr) console.error('cache remove stderr:', stderr);
      res.json({ ok: true, stdout: stdout || '', stderr: stderr || '' });
    } catch (e) {
      console.error('Error running cache remove:', e);
      const stdout = e.stdout || '';
      // Check if it actually deleted the model despite the error
      if (stdout.includes('Deleted model') || stdout.includes('from the cache')) {
        console.log('Model appeared to be deleted despite error. Treating as success.');
        res.json({ ok: true, stdout: stdout, stderr: e.stderr || e.message, warning: 'Partial error during removal' });
      } else {
        res.status(500).json({ ok: false, error: e.message || String(e), stdout: stdout, stderr: e.stderr || '' });
      }
    }
  } catch (err) {
    console.error('Error in /cache-remove:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});