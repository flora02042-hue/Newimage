/**
 * PictureCraft — SillyTavern Extension
 * Intercepts [IMG:GEN:{...}] markers in AI responses and produces images via API.
 * Compatible with OpenAI-style and Gemini-style (nano-banana) backends.
 */

// ─── Constants & Configuration ───────────────────────────────────────────────

const PLUGIN_ID = 'picture_craft';

const ARTWORK_MODELS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen',
];

const CLIP_MODELS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo',
];

const RATIO_OPTIONS = ['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'];
const RESOLUTION_OPTIONS = ['1K','2K','4K'];

const FALLBACK_IMG = '/scripts/extensions/third-party/sillyimages/error.svg';

// ─── Diagnostic Logger ───────────────────────────────────────────────────────

class DiagnosticLog {
    constructor(capacity = 200) {
        this._entries = [];
        this._cap = capacity;
    }

    _append(severity, args) {
        const ts = new Date().toISOString();
        const body = args.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ');
        this._entries.push(`[${ts}] [${severity}] ${body}`);
        if (this._entries.length > this._cap) this._entries.shift();
        const fn = severity === 'ERROR' ? console.error : severity === 'WARN' ? console.warn : console.log;
        fn('[PicCraft]', ...args);
    }

    info(...a)  { this._append('INFO', a); }
    warn(...a)  { this._append('WARN', a); }
    error(...a) { this._append('ERROR', a); }

    download() {
        const blob = new Blob([this._entries.join('\n')], { type: 'text/plain' });
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob);
        anchor.download = `piccraft-log-${Date.now()}.txt`;
        anchor.click();
        URL.revokeObjectURL(anchor.href);
        toastr.success('Логи сохранены', 'PictureCraft');
    }
}

const diag = new DiagnosticLog();

// ─── Defaults ────────────────────────────────────────────────────────────────

const INITIAL_CONFIG = Object.freeze({
    active: true,
    backend: 'openai',
    endpointUrl: '',
    secret: '',
    selectedModel: '',
    dimensions: '1024x1024',
    fidelity: 'standard',
    maxAttempts: 0,
    pauseBetween: 1000,
    includeCharPic: false,
    includePlayerPic: false,
    playerPicFilename: '',
    ratio: '1:1',
    resolution: '1K',
});

// ─── Settings Manager ────────────────────────────────────────────────────────

class ConfigManager {
    static load() {
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings[PLUGIN_ID]) {
            ctx.extensionSettings[PLUGIN_ID] = structuredClone(INITIAL_CONFIG);
        }
        const cfg = ctx.extensionSettings[PLUGIN_ID];
        for (const [k, v] of Object.entries(INITIAL_CONFIG)) {
            if (!(k in cfg)) cfg[k] = v;
        }
        return cfg;
    }

    static persist() {
        const ctx = SillyTavern.getContext();
        ctx.saveSettingsDebounced();
        diag.info('Config saved');
    }

    static verify() {
        const cfg = ConfigManager.load();
        const issues = [];
        if (!cfg.endpointUrl) issues.push('URL не задан');
        if (!cfg.secret) issues.push('API-ключ не задан');
        if (!cfg.selectedModel) issues.push('Модель не выбрана');
        if (issues.length) throw new Error(`Проблемы конфигурации: ${issues.join(', ')}`);
    }
}

// ─── Utility Helpers ─────────────────────────────────────────────────────────

function classifyModel(id) {
    const lower = id.toLowerCase();
    for (const kw of CLIP_MODELS) { if (lower.includes(kw)) return 'video'; }
    if (lower.includes('vision') && lower.includes('preview')) return 'vision';
    for (const kw of ARTWORK_MODELS) { if (lower.includes(kw)) return 'artwork'; }
    return 'unknown';
}

function isNanoBanana(id) {
    return id.toLowerCase().includes('nano-banana');
}

function escapeHtmlText(raw) {
    const node = document.createElement('span');
    node.textContent = raw;
    return node.innerHTML;
}

async function blobToBase64(url) {
    try {
        const resp = await fetch(url);
        const bl = await resp.blob();
        return await new Promise((ok, fail) => {
            const rd = new FileReader();
            rd.onloadend = () => ok(rd.result.split(',')[1]);
            rd.onerror = fail;
            rd.readAsDataURL(bl);
        });
    } catch (e) {
        diag.error('Base64 conversion failed:', e);
        return null;
    }
}

async function uploadGeneratedImage(dataUri) {
    const ctx = SillyTavern.getContext();
    const parts = dataUri.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!parts) throw new Error('Некорректный data URI');

    let folder = 'generated';
    if (ctx.characterId != null && ctx.characters?.[ctx.characterId]) {
        folder = ctx.characters[ctx.characterId].name || 'generated';
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({
            image: parts[2],
            format: parts[1],
            ch_name: folder,
            filename: `pc_${stamp}`,
        }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Неизвестная ошибка' }));
        throw new Error(err.error || `Загрузка не удалась: ${res.status}`);
    }
    const json = await res.json();
    diag.info('Файл сохранён:', json.path);
    return json.path;
}

async function probeFileExists(path) {
    try { return (await fetch(path, { method: 'HEAD' })).ok; }
    catch { return false; }
}

// ─── Avatar Retrieval ────────────────────────────────────────────────────────

async function grabCharacterPicture() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId == null) return null;

        if (typeof ctx.getCharacterAvatar === 'function') {
            const url = ctx.getCharacterAvatar(ctx.characterId);
            if (url) return await blobToBase64(url);
        }

        const ch = ctx.characters?.[ctx.characterId];
        if (ch?.avatar) {
            return await blobToBase64(`/characters/${encodeURIComponent(ch.avatar)}`);
        }
        return null;
    } catch (e) {
        diag.error('Char avatar fetch error:', e);
        return null;
    }
}

async function grabPlayerPicture() {
    try {
        const cfg = ConfigManager.load();
        if (!cfg.playerPicFilename) return null;
        return await blobToBase64(`/User Avatars/${encodeURIComponent(cfg.playerPicFilename)}`);
    } catch (e) {
        diag.error('Player avatar fetch error:', e);
        return null;
    }
}

// ─── Model List Fetcher ─────────────────────────────────────────────────────

async function queryAvailableModels() {
    const cfg = ConfigManager.load();
    if (!cfg.endpointUrl || !cfg.secret) return [];

    const endpoint = `${cfg.endpointUrl.replace(/\/$/, '')}/v1/models`;
    try {
        const resp = await fetch(endpoint, {
            headers: { 'Authorization': `Bearer ${cfg.secret}` },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const payload = await resp.json();
        return (payload.data || []).filter(m => classifyModel(m.id) === 'artwork').map(m => m.id);
    } catch (e) {
        diag.error('Model query failed:', e);
        toastr.error(`Не удалось получить модели: ${e.message}`, 'PictureCraft');
        return [];
    }
}

async function queryPlayerAvatarList() {
    try {
        const ctx = SillyTavern.getContext();
        const resp = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } catch (e) {
        diag.error('Avatar list fetch error:', e);
        return [];
    }
}

// ─── Prompt Composer (simplified — no extra features) ────────────────────────

class PromptComposer {
    static assemble(baseText, styleHint) {
        const segments = [];

        // Tag-level style
        if (styleHint) {
            segments.push(`[Style: ${styleHint}]`);
        }

        // Core prompt
        segments.push(baseText);

        const composed = segments.join('\n\n');
        diag.info(`Composed prompt: ${composed.length} chars, ${segments.length} segments`);
        return composed;
    }
}

// ─── Image Generation Backends ───────────────────────────────────────────────

class ArtworkBackend {
    static async callOpenAI(description, styleHint, refs = [], opts = {}) {
        const cfg = ConfigManager.load();
        const apiUrl = `${cfg.endpointUrl.replace(/\/$/, '')}/v1/images/generations`;
        const composed = PromptComposer.assemble(description, styleHint);

        let dim = cfg.dimensions;
        if (opts.aspectRatio === '16:9') dim = '1792x1024';
        else if (opts.aspectRatio === '9:16') dim = '1024x1792';
        else if (opts.aspectRatio === '1:1') dim = '1024x1024';

        const payload = {
            model: cfg.selectedModel,
            prompt: composed,
            n: 1,
            size: dim,
            quality: opts.quality || cfg.fidelity,
            response_format: 'b64_json',
        };

        if (refs.length > 0) {
            payload.image = `data:image/png;base64,${refs[0]}`;
        }

        const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${cfg.secret}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });

        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`API ошибка (${resp.status}): ${txt}`);
        }

        const result = await resp.json();
        const items = result.data || [];
        if (!items.length) {
            if (result.url) return result.url;
            throw new Error('Ответ API не содержит изображений');
        }

        const first = items[0];
        return first.b64_json ? `data:image/png;base64,${first.b64_json}` : first.url;
    }

    static async callGemini(description, styleHint, refs = [], opts = {}) {
        const cfg = ConfigManager.load();
        const model = cfg.selectedModel;
        const apiUrl = `${cfg.endpointUrl.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;

        let ar = opts.aspectRatio || cfg.ratio || '1:1';
        if (!RATIO_OPTIONS.includes(ar)) {
            diag.warn(`Bad aspect ratio "${ar}", using fallback`);
            ar = RATIO_OPTIONS.includes(cfg.ratio) ? cfg.ratio : '1:1';
        }

        let res = opts.imageSize || cfg.resolution || '1K';
        if (!RESOLUTION_OPTIONS.includes(res)) {
            diag.warn(`Bad resolution "${res}", using fallback`);
            res = RESOLUTION_OPTIONS.includes(cfg.resolution) ? cfg.resolution : '1K';
        }

        diag.info(`Gemini call — ratio: ${ar}, resolution: ${res}`);

        const contentParts = [];

        for (const b64 of refs.slice(0, 4)) {
            contentParts.push({ inlineData: { mimeType: 'image/png', data: b64 } });
        }

        let composed = PromptComposer.assemble(description, styleHint);

        if (refs.length > 0) {
            const refNote = '[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]';
            composed = `${refNote}\n\n${composed}`;
        }

        contentParts.push({ text: composed });

        const body = {
            contents: [{ role: 'user', parts: contentParts }],
            generationConfig: {
                responseModalities: ['TEXT', 'IMAGE'],
                imageConfig: { aspectRatio: ar, imageSize: res },
            },
        };

        diag.info(`Gemini request: model=${model}, ratio=${ar}, res=${res}, promptLen=${composed.length}, refs=${refs.length}`);

        const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${cfg.secret}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(`API ошибка (${resp.status}): ${txt}`);
        }

        const result = await resp.json();
        const candidates = result.candidates || [];
        if (!candidates.length) throw new Error('Пустой ответ от Gemini');

        for (const part of (candidates[0].content?.parts || [])) {
            if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
        }

        throw new Error('Изображение не найдено в ответе Gemini');
    }

    static async produce(description, styleHint, statusCb, opts = {}) {
        ConfigManager.verify();
        const cfg = ConfigManager.load();

        const refs = [];
        const useGemini = cfg.backend === 'gemini' || isNanoBanana(cfg.selectedModel);

        if (useGemini) {
            if (cfg.includeCharPic) {
                const pic = await grabCharacterPicture();
                if (pic) refs.push(pic);
            }
            if (cfg.includePlayerPic) {
                const pic = await grabPlayerPicture();
                if (pic) refs.push(pic);
            }
            diag.info(`Reference images collected: ${refs.length}`);
        }

        let lastErr;
        const tries = cfg.maxAttempts;
        const wait = cfg.pauseBetween;

        for (let attempt = 0; attempt <= tries; attempt++) {
            try {
                statusCb?.(`Создание${attempt > 0 ? ` (попытка ${attempt}/${tries})` : ''}...`);

                return useGemini
                    ? await this.callGemini(description, styleHint, refs, opts)
                    : await this.callOpenAI(description, styleHint, refs, opts);
            } catch (e) {
                lastErr = e;
                diag.error(`Attempt ${attempt + 1} failed:`, e.message);

                const retryable = /429|503|502|504|timeout|network/i.test(e.message);
                if (!retryable || attempt === tries) break;

                const delay = wait * Math.pow(2, attempt);
                statusCb?.(`Повтор через ${delay / 1000}с...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }

        throw lastErr;
    }
}

// ─── Tag Scanner ─────────────────────────────────────────────────────────────

class TagScanner {
    static _findJsonEnd(src, from) {
        let depth = 0, inStr = false, esc = false;
        for (let i = from; i < src.length; i++) {
            const c = src[i];
            if (esc) { esc = false; continue; }
            if (c === '\\' && inStr) { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (!inStr) {
                if (c === '{') depth++;
                else if (c === '}') { depth--; if (depth === 0) return i + 1; }
            }
        }
        return -1;
    }

    static _decodeEntities(s) {
        return s
            .replace(/"/g, '"')
            .replace(/'/g, "'")
            .replace(/&#39;/g, "'")
            .replace(/&#34;/g, '"')
            .replace(/&/g, '&');
    }

    static async extract(text, opts = {}) {
        const { verifyPaths = false, includeAll = false } = opts;
        const results = [];

        // ── Pass 1: Modern format  <img data-iig-instruction='{...}' src="[IMG:GEN]"> ──
        const ATTR_KEY = 'data-iig-instruction=';
        let cursor = 0;

        while (cursor < text.length) {
            const attrPos = text.indexOf(ATTR_KEY, cursor);
            if (attrPos < 0) break;

            const openTag = text.lastIndexOf('<img', attrPos);
            if (openTag < 0 || attrPos - openTag > 500) { cursor = attrPos + 1; continue; }

            const jsonIdx = text.indexOf('{', attrPos + ATTR_KEY.length);
            if (jsonIdx < 0 || jsonIdx > attrPos + ATTR_KEY.length + 10) { cursor = attrPos + 1; continue; }

            const jsonStop = this._findJsonEnd(text, jsonIdx);
            if (jsonStop < 0) { cursor = attrPos + 1; continue; }

            const closeAngle = text.indexOf('>', jsonStop);
            if (closeAngle < 0) { cursor = attrPos + 1; continue; }
            const fullTag = text.substring(openTag, closeAngle + 1);
            const rawJson = text.substring(jsonIdx, jsonStop);

            const srcRx = /src\s*=\s*["']?([^"'\s>]+)/i;
            const srcHit = fullTag.match(srcRx);
            const srcVal = srcHit ? srcHit[1] : '';

            const isErrorImg = srcVal.includes('error.svg');
            const hasGenMarker = srcVal.includes('[IMG:GEN]') || srcVal.includes('[IMG:');
            const hasFilePath = srcVal && srcVal.startsWith('/') && srcVal.length > 5;

            if (isErrorImg && !includeAll) {
                cursor = closeAngle + 1;
                continue;
            }

            let needsWork = false;
            if (includeAll) {
                needsWork = true;
            } else if (hasGenMarker || !srcVal) {
                needsWork = true;
            } else if (hasFilePath && verifyPaths) {
                const exists = await probeFileExists(srcVal);
                if (!exists) {
                    diag.warn(`Path not found (hallucination?): ${srcVal}`);
                    needsWork = true;
                }
            } else if (hasFilePath) {
                cursor = closeAngle + 1;
                continue;
            }

            if (!needsWork) { cursor = closeAngle + 1; continue; }

            try {
                const decoded = this._decodeEntities(rawJson);
                const obj = JSON.parse(decoded);
                results.push({
                    raw: fullTag,
                    offset: openTag,
                    style: obj.style || '',
                    prompt: obj.prompt || '',
                    aspectRatio: obj.aspect_ratio || obj.aspectRatio || null,
                    imageSize: obj.image_size || obj.imageSize || null,
                    quality: obj.quality || null,
                    modern: true,
                    prevSrc: hasFilePath ? srcVal : null,
                });
                diag.info(`Modern tag found: "${(obj.prompt || '').slice(0, 50)}…"`);
            } catch (e) {
                diag.warn(`JSON parse error in modern tag: ${rawJson.slice(0, 100)}`, e.message);
            }

            cursor = closeAngle + 1;
        }

        // ── Pass 2: Legacy format  [IMG:GEN:{...}] ──
        const LEGACY = '[IMG:GEN:';
        cursor = 0;

        while (cursor < text.length) {
            const start = text.indexOf(LEGACY, cursor);
            if (start < 0) break;

            const jBegin = start + LEGACY.length;
            const jEnd = this._findJsonEnd(text, jBegin);
            if (jEnd < 0) { cursor = jBegin; continue; }

            if (text[jEnd] !== ']') { cursor = jEnd; continue; }

            const snippet = text.substring(start, jEnd + 1);
            const jsonPart = text.substring(jBegin, jEnd);

            try {
                const obj = JSON.parse(jsonPart.replace(/'/g, '"'));
                results.push({
                    raw: snippet,
                    offset: start,
                    style: obj.style || '',
                    prompt: obj.prompt || '',
                    aspectRatio: obj.aspect_ratio || obj.aspectRatio || null,
                    imageSize: obj.image_size || obj.imageSize || null,
                    quality: obj.quality || null,
                    modern: false,
                });
                diag.info(`Legacy tag found: "${(obj.prompt || '').slice(0, 50)}…"`);
            } catch (e) {
                diag.warn(`JSON parse error in legacy tag: ${jsonPart.slice(0, 100)}`, e.message);
            }

            cursor = jEnd + 1;
        }

        return results;
    }
}

// ─── DOM Widgets ─────────────────────────────────────────────────────────────

function buildSpinner(uid) {
    const wrap = document.createElement('div');
    wrap.className = 'pc-progress-box';
    wrap.dataset.uid = uid;
    const ring = document.createElement('div');
    ring.className = 'pc-ring';
    const label = document.createElement('div');
    label.className = 'pc-progress-label';
    label.textContent = 'Создание изображения...';
    wrap.append(ring, label);
    return wrap;
}

function buildFailureWidget(uid, reason, tagData) {
    const el = document.createElement('img');
    el.className = 'pc-fail-img';
    el.src = FALLBACK_IMG;
    el.alt = 'Ошибка генерации';
    el.title = `Ошибка: ${reason}`;
    el.dataset.uid = uid;
    if (tagData.raw) {
        const instrMatch = tagData.raw.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instrMatch) el.setAttribute('data-iig-instruction', instrMatch[2]);
    }
    return el;
}

/**
 * Wrap a generated image in a container with an individual regen button in the corner.
 */
function wrapImageWithRegenButton(imgEl, tag, messageId) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pc-img-wrap';

    const regenBtn = document.createElement('div');
    regenBtn.className = 'pc-img-regen-btn';
    regenBtn.title = 'Перегенерировать эту картинку';
    regenBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
    regenBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        const ctx = SillyTavern.getContext();
        const message = ctx.chat[messageId];
        if (!message) return;

        const uid = `pc-single-${messageId}-${Date.now()}`;
        const spinner = buildSpinner(uid);
        wrapper.replaceWith(spinner);

        try {
            const statusEl = spinner.querySelector('.pc-progress-label');
            const dataUri = await ArtworkBackend.produce(
                tag.prompt, tag.style,
                s => { statusEl.textContent = s; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality },
            );

            statusEl.textContent = 'Сохранение...';
            const filePath = await uploadGeneratedImage(dataUri);

            const newImg = document.createElement('img');
            newImg.className = 'pc-result-img';
            newImg.src = filePath;
            newImg.alt = tag.prompt;
            newImg.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;

            if (tag.modern) {
                const instrMatch = tag.raw.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (instrMatch) newImg.setAttribute('data-iig-instruction', instrMatch[2]);
            }

            const newWrapper = wrapImageWithRegenButton(newImg, tag, messageId);
            spinner.replaceWith(newWrapper);

            // Update message.mes with new path
            if (tag.modern) {
                const oldSrc = imgEl.src;
                // Find the tag in mes and update src
                const srcPattern = oldSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                message.mes = message.mes.replace(new RegExp(`src=["']${srcPattern}["']`, 'i'), `src="${filePath}"`);
            }

            await ctx.saveChat();
            toastr.success('Картинка перегенерирована', 'PictureCraft', { timeOut: 2000 });
        } catch (err) {
            diag.error('Single regen failed:', err.message);
            const failWidget = buildFailureWidget(uid, err.message, tag);
            spinner.replaceWith(failWidget);
            toastr.error(`Ошибка: ${err.message}`, 'PictureCraft');
        }
    });

    // Move the image inside wrapper
    imgEl.parentNode?.insertBefore(wrapper, imgEl);
    wrapper.appendChild(imgEl);
    wrapper.appendChild(regenBtn);

    return wrapper;
}

// ─── Message Processor ───────────────────────────────────────────────────────

const _busyMessages = new Set();

class MessageProcessor {

    static _locateTarget(mesTextEl, tag, uid) {
        if (tag.modern) {
            const candidates = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            const needle = tag.prompt.slice(0, 30);
            diag.info(`Searching ${candidates.length} instruction-img elements for "${needle}"`);

            for (const img of candidates) {
                const attr = img.getAttribute('data-iig-instruction') || '';
                const decoded = TagScanner._decodeEntities(attr);
                if (decoded.includes(needle)) return img;
                try {
                    const parsed = JSON.parse(decoded.replace(/'/g, '"'));
                    if (parsed.prompt?.slice(0, 30) === needle) return img;
                } catch { /* skip */ }
                if (attr.includes(needle)) return img;
            }

            for (const img of candidates) {
                const s = img.getAttribute('src') || '';
                if (s.includes('[IMG:GEN]') || s.includes('[IMG:') || s === '' || s === '#') return img;
            }

            for (const img of mesTextEl.querySelectorAll('img')) {
                const s = img.getAttribute('src') || '';
                if (s.includes('[IMG:GEN]') || s.includes('[IMG:ERROR]')) return img;
            }
        } else {
            const escaped = tag.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '(?:"|")');
            const before = mesTextEl.innerHTML;
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(
                new RegExp(escaped, 'g'),
                `<span data-pc-slot="${uid}"></span>`,
            );
            if (before !== mesTextEl.innerHTML) {
                const slot = mesTextEl.querySelector(`[data-pc-slot="${uid}"]`);
                if (slot) return slot;
            }
            for (const img of mesTextEl.querySelectorAll('img')) {
                if (img.src?.includes('[IMG:GEN:')) return img;
            }
        }
        return null;
    }

    static async _handleTag(tag, idx, mesTextEl, message, messageId) {
        const uid = `pc-${messageId}-${idx}`;
        diag.info(`Processing tag ${idx}: "${tag.raw.slice(0, 50)}"`);

        const spinner = buildSpinner(uid);
        const target = this._locateTarget(mesTextEl, tag, uid);

        if (target) {
            const parent = target.parentElement;
            if (parent) {
                const cs = getComputedStyle(parent);
                if (cs.display === 'flex' || cs.display === 'grid') {
                    spinner.style.alignSelf = 'center';
                }
            }
            target.replaceWith(spinner);
        } else {
            diag.warn('No DOM target found, appending spinner at end');
            mesTextEl.appendChild(spinner);
        }

        const statusEl = spinner.querySelector('.pc-progress-label');

        try {
            const dataUri = await ArtworkBackend.produce(
                tag.prompt, tag.style,
                s => { statusEl.textContent = s; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality },
            );

            statusEl.textContent = 'Сохранение...';
            const filePath = await uploadGeneratedImage(dataUri);

            const pic = document.createElement('img');
            pic.className = 'pc-result-img';
            pic.src = filePath;
            pic.alt = tag.prompt;
            pic.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;

            if (tag.modern) {
                const instrMatch = tag.raw.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (instrMatch) pic.setAttribute('data-iig-instruction', instrMatch[2]);
            }

            // Wrap image with individual regen button
            const wrapped = document.createElement('div');
            wrapped.className = 'pc-img-wrap';
            const regenBtn = document.createElement('div');
            regenBtn.className = 'pc-img-regen-btn';
            regenBtn.title = 'Перегенерировать эту картинку';
            regenBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';
            regenBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                e.preventDefault();
                // Re-use single image regeneration
                const ctx = SillyTavern.getContext();
                const msg = ctx.chat[messageId];
                if (!msg) return;

                const reUid = `pc-single-${messageId}-${Date.now()}`;
                const reSpinner = buildSpinner(reUid);
                wrapped.replaceWith(reSpinner);

                try {
                    const reStatusEl = reSpinner.querySelector('.pc-progress-label');
                    const reDataUri = await ArtworkBackend.produce(
                        tag.prompt, tag.style,
                        s => { reStatusEl.textContent = s; },
                        { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality },
                    );
                    reStatusEl.textContent = 'Сохранение...';
                    const reFilePath = await uploadGeneratedImage(reDataUri);

                    const newPic = document.createElement('img');
                    newPic.className = 'pc-result-img';
                    newPic.src = reFilePath;
                    newPic.alt = tag.prompt;
                    if (tag.modern) {
                        const iMatch = tag.raw.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                        if (iMatch) newPic.setAttribute('data-iig-instruction', iMatch[2]);
                    }

                    // Create new wrapper
                    const newWrap = document.createElement('div');
                    newWrap.className = 'pc-img-wrap';
                    const newBtn = regenBtn.cloneNode(true);
                    // Re-attach event (clone doesn't copy listeners) — use same logic
                    newBtn.addEventListener('click', regenBtn.onclick);
                    newWrap.appendChild(newPic);
                    newWrap.appendChild(newBtn);
                    reSpinner.replaceWith(newWrap);

                    // Update mes
                    if (tag.modern) {
                        const updated = tag.raw.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${reFilePath}"`);
                        msg.mes = msg.mes.replace(tag.raw, updated);
                    }
                    await ctx.saveChat();
                    toastr.success('Картинка перегенерирована', 'PictureCraft', { timeOut: 2000 });
                } catch (err) {
                    diag.error('Single regen failed:', err.message);
                    const failW = buildFailureWidget(reUid, err.message, tag);
                    reSpinner.replaceWith(failW);
                    toastr.error(`Ошибка: ${err.message}`, 'PictureCraft');
                }
            });

            wrapped.appendChild(pic);
            wrapped.appendChild(regenBtn);
            spinner.replaceWith(wrapped);

            // Persist path into message.mes
            if (tag.modern) {
                const updated = tag.raw.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${filePath}"`);
                message.mes = message.mes.replace(tag.raw, updated);
            } else {
                message.mes = message.mes.replace(tag.raw, `[IMG:✓:${filePath}]`);
            }

            diag.info(`Tag ${idx} complete`);
            return true;
        } catch (err) {
            diag.error(`Tag ${idx} failed:`, err.message);
            const failWidget = buildFailureWidget(uid, err.message, tag);
            spinner.replaceWith(failWidget);

            if (tag.modern) {
                const errTag = tag.raw.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${FALLBACK_IMG}"`);
                message.mes = message.mes.replace(tag.raw, errTag);
            } else {
                message.mes = message.mes.replace(tag.raw, `[IMG:ERROR:${err.message.slice(0, 50)}]`);
            }

            toastr.error(`Ошибка: ${err.message}`, 'PictureCraft');
            return false;
        }
    }

    static async processMessage(messageId) {
        const ctx = SillyTavern.getContext();
        const cfg = ConfigManager.load();
        if (!cfg.active) return;

        if (_busyMessages.has(messageId)) {
            diag.warn(`Message ${messageId} already in progress`);
            return;
        }

        const message = ctx.chat[messageId];
        if (!message || message.is_user) return;

        const tags = await TagScanner.extract(message.mes, { verifyPaths: true });
        diag.info(`TagScanner returned ${tags.length} tags for msg ${messageId}`);
        if (!tags.length) return;

        _busyMessages.add(messageId);
        toastr.info(`Найдено ${tags.length} изображений. Генерация...`, 'PictureCraft', { timeOut: 3000 });

        const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!mesEl) { _busyMessages.delete(messageId); return; }
        const mesText = mesEl.querySelector('.mes_text');
        if (!mesText) { _busyMessages.delete(messageId); return; }

        try {
            const jobs = tags.map((t, i) => this._handleTag(t, i, mesText, message, messageId));
            const results = await Promise.all(jobs);
            const ok = results.filter(Boolean).length;
            if (ok) toastr.success(`${ok}/${tags.length} изображений готово`, 'PictureCraft', { timeOut: 2000 });
        } finally {
            _busyMessages.delete(messageId);
            diag.info(`Message ${messageId} processing complete`);
        }

        await ctx.saveChat();

        if (typeof ctx.messageFormatting === 'function') {
            const formatted = ctx.messageFormatting(message.mes, message.name, message.is_system, message.is_user, messageId);
            mesText.innerHTML = formatted;
        }
    }

    static async regenerate(messageId) {
        const ctx = SillyTavern.getContext();
        const message = ctx.chat[messageId];
        if (!message) { toastr.error('Сообщение не найдено', 'PictureCraft'); return; }

        const tags = await TagScanner.extract(message.mes, { includeAll: true });
        if (!tags.length) { toastr.warning('Нет тегов для перегенерации', 'PictureCraft'); return; }

        diag.info(`Regenerating ${tags.length} images in msg ${messageId}`);
        toastr.info(`Перегенерация ${tags.length} изображений...`, 'PictureCraft');
        _busyMessages.add(messageId);

        const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!mesEl) { _busyMessages.delete(messageId); return; }
        const mesText = mesEl.querySelector('.mes_text');
        if (!mesText) { _busyMessages.delete(messageId); return; }

        for (let i = 0; i < tags.length; i++) {
            const tag = tags[i];
            const uid = `pc-re-${messageId}-${i}`;

            try {
                const existing = mesText.querySelector('img[data-iig-instruction]');
                if (!existing) continue;

                const instrAttr = existing.getAttribute('data-iig-instruction');
                // Remove wrapper if exists
                const parentWrap = existing.closest('.pc-img-wrap');
                const spinner = buildSpinner(uid);
                if (parentWrap) {
                    parentWrap.replaceWith(spinner);
                } else {
                    existing.replaceWith(spinner);
                }

                const statusEl = spinner.querySelector('.pc-progress-label');
                const dataUri = await ArtworkBackend.produce(
                    tag.prompt, tag.style,
                    s => { statusEl.textContent = s; },
                    { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality },
                );

                statusEl.textContent = 'Сохранение...';
                const filePath = await uploadGeneratedImage(dataUri);

                const pic = document.createElement('img');
                pic.className = 'pc-result-img';
                pic.src = filePath;
                pic.alt = tag.prompt;
                if (instrAttr) pic.setAttribute('data-iig-instruction', instrAttr);

                // Wrap with regen button
                const wrap = document.createElement('div');
                wrap.className = 'pc-img-wrap';
                wrap.appendChild(pic);
                // Note: individual regen button will be re-added via processMessage flow
                spinner.replaceWith(wrap);

                const updated = tag.raw.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${filePath}"`);
                message.mes = message.mes.replace(tag.raw, updated);

                toastr.success(`Картинка ${i + 1}/${tags.length} готова`, 'PictureCraft', { timeOut: 2000 });
            } catch (err) {
                diag.error(`Regen tag ${i} failed:`, err.message);
                toastr.error(`Ошибка: ${err.message}`, 'PictureCraft');
            }
        }

        _busyMessages.delete(messageId);
        await ctx.saveChat();
        diag.info(`Regeneration done for msg ${messageId}`);
    }
}

// ─── Regenerate Button Injection (message menu) ──────────────────────────────

function injectRegenButton(mesElement, mesId) {
    if (mesElement.querySelector('.pc-regen-btn')) return;
    const extra = mesElement.querySelector('.extraMesButtons');
    if (!extra) return;

    const btn = document.createElement('div');
    btn.className = 'mes_button pc-regen-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать все изображения';
    btn.tabIndex = 0;
    btn.addEventListener('click', e => {
        e.stopPropagation();
        MessageProcessor.regenerate(mesId);
    });
    extra.appendChild(btn);
}

function injectButtonsIntoChat() {
    const ctx = SillyTavern.getContext();
    if (!ctx.chat?.length) return;

    let count = 0;
    for (const el of document.querySelectorAll('#chat .mes')) {
        const id = el.getAttribute('mesid');
        if (id == null) continue;
        const num = parseInt(id, 10);
        const msg = ctx.chat[num];
        if (msg && !msg.is_user) {
            injectRegenButton(el, num);
            count++;
        }
    }
    diag.info(`Regen buttons added to ${count} messages`);
}

// ─── Event Handler ───────────────────────────────────────────────────────────

async function onRendered(messageId) {
    diag.info(`onRendered: ${messageId}`);
    const cfg = ConfigManager.load();
    if (!cfg.active) return;

    const mesEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!mesEl) return;

    injectRegenButton(mesEl, messageId);
    await MessageProcessor.processMessage(messageId);
}

// ─── Settings Panel Builder ──────────────────────────────────────────────────

function assemblePanel() {
    const cfg = ConfigManager.load();
    const root = document.getElementById('extensions_settings');
    if (!root) { diag.error('Settings container missing'); return; }

    const avatarPreviewSrc = cfg.playerPicFilename
        ? `/User Avatars/${encodeURIComponent(cfg.playerPicFilename)}`
        : '';
    const avatarPreviewHidden = cfg.playerPicFilename ? '' : 'pc-hidden';

    const markup = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>PictureCraft — Генерация</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="pc-panel">
                <label class="checkbox_label">
                    <input type="checkbox" id="pc_active" ${cfg.active ? 'checked' : ''}>
                    <span>Включить генерацию</span>
                </label>
                <hr>
                <h4>Подключение к API</h4>
                <div class="pc-row">
                    <label for="pc_backend">Тип бэкенда</label>
                    <select id="pc_backend" class="pc-grow">
                        <option value="openai" ${cfg.backend === 'openai' ? 'selected' : ''}>OpenAI-совместимый</option>
                        <option value="gemini" ${cfg.backend === 'gemini' ? 'selected' : ''}>Gemini / nano-banana</option>
                    </select>
                </div>
                <div class="pc-row">
                    <label for="pc_endpoint">URL</label>
                    <input type="text" id="pc_endpoint" class="text_pole pc-grow" value="${cfg.endpointUrl}" placeholder="https://api.example.com">
                </div>
                <div class="pc-row">
                    <label for="pc_secret">Ключ</label>
                    <input type="password" id="pc_secret" class="text_pole pc-grow" value="${cfg.secret}">
                    <div id="pc_eye" class="menu_button pc-eye-btn" title="Показать/скрыть"><i class="fa-solid fa-eye"></i></div>
                </div>
                <div class="pc-row">
                    <label for="pc_model">Модель</label>
                    <select id="pc_model" class="pc-grow">
                        ${cfg.selectedModel ? `<option value="${cfg.selectedModel}" selected>${cfg.selectedModel}</option>` : '<option value="">— выберите —</option>'}
                    </select>
                    <div id="pc_reload_models" class="menu_button pc-sync-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
                </div>
                <hr>
                <h4>Параметры картинки</h4>
                <div class="pc-row">
                    <label for="pc_dim">Размер</label>
                    <select id="pc_dim" class="pc-grow">
                        <option value="1024x1024" ${cfg.dimensions==='1024x1024'?'selected':''}>1024×1024</option>
                        <option value="1792x1024" ${cfg.dimensions==='1792x1024'?'selected':''}>1792×1024</option>
                        <option value="1024x1792" ${cfg.dimensions==='1024x1792'?'selected':''}>1024×1792</option>
                        <option value="512x512" ${cfg.dimensions==='512x512'?'selected':''}>512×512</option>
                    </select>
                </div>
                <div class="pc-row">
                    <label for="pc_fidelity">Качество</label>
                    <select id="pc_fidelity" class="pc-grow">
                        <option value="standard" ${cfg.fidelity==='standard'?'selected':''}>Стандарт</option>
                        <option value="hd" ${cfg.fidelity==='hd'?'selected':''}>HD</option>
                    </select>
                </div>
                <hr>
                <div id="pc_nano_block" class="pc-nano-block ${cfg.backend !== 'gemini' ? 'pc-hidden' : ''}">
                    <h4>Настройки Nano-Banana</h4>
                    <div class="pc-row">
                        <label for="pc_ratio">Пропорции</label>
                        <select id="pc_ratio" class="pc-grow">
                            ${RATIO_OPTIONS.map(r => `<option value="${r}" ${cfg.ratio===r?'selected':''}>${r}</option>`).join('')}
                        </select>
                    </div>
                    <div class="pc-row">
                        <label for="pc_resolution">Разрешение</label>
                        <select id="pc_resolution" class="pc-grow">
                            ${RESOLUTION_OPTIONS.map(r => `<option value="${r}" ${cfg.resolution===r?'selected':''}>${r}</option>`).join('')}
                        </select>
                    </div>
                    <hr>
                    <h5>Референсы</h5>
                    <p class="pc-hint">Аватарки отправляются как образцы для соблюдения внешности.</p>
                    <label class="checkbox_label"><input type="checkbox" id="pc_char_pic" ${cfg.includeCharPic?'checked':''}><span>Аватар {{char}}</span></label>
                    <label class="checkbox_label"><input type="checkbox" id="pc_player_pic" ${cfg.includePlayerPic?'checked':''}><span>Аватар {{user}}</span></label>
                    <div id="pc_avatar_row" class="pc-row ${!cfg.includePlayerPic?'pc-hidden':''}" style="margin-top:5px;align-items:flex-start;">
                        <label for="pc_avatar_file">Файл аватара</label>
                        <div class="pc-grow" style="display:flex;flex-direction:column;gap:6px;">
                            <div style="display:flex;gap:6px;align-items:center;">
                                <select id="pc_avatar_file" class="pc-grow">
                                    <option value="">— нет —</option>
                                    ${cfg.playerPicFilename ? `<option value="${cfg.playerPicFilename}" selected>${cfg.playerPicFilename}</option>` : ''}
                                </select>
                                <div id="pc_reload_avatars" class="menu_button pc-sync-btn" title="Обновить"><i class="fa-solid fa-sync"></i></div>
                            </div>
                            <img id="pc_avatar_preview" class="pc-avatar-thumb ${avatarPreviewHidden}" src="${avatarPreviewSrc}" alt="Превью аватара">
                        </div>
                    </div>
                </div>
                <hr>
                <h4>Повторные попытки</h4>
                <div class="pc-row">
                    <label for="pc_attempts">Макс. повторов</label>
                    <input type="number" id="pc_attempts" class="text_pole pc-grow" value="${cfg.maxAttempts}" min="0" max="5">
                </div>
                <div class="pc-row">
                    <label for="pc_pause">Пауза (мс)</label>
                    <input type="number" id="pc_pause" class="text_pole pc-grow" value="${cfg.pauseBetween}" min="500" max="10000" step="500">
                </div>
                <hr>
                <h4>Отладка</h4>
                <div class="pc-row">
                    <div id="pc_dump_logs" class="menu_button" style="width:100%"><i class="fa-solid fa-download"></i> Скачать логи</div>
                </div>
                <p class="pc-hint">Экспорт диагностических записей для анализа проблем.</p>
            </div>
        </div>
    </div>`;

    root.insertAdjacentHTML('beforeend', markup);
    wireUpPanel();
}

// ─── Panel Event Wiring ──────────────────────────────────────────────────────

function wireUpPanel() {
    const cfg = ConfigManager.load();
    const $ = id => document.getElementById(id);

    $('pc_active')?.addEventListener('change', e => { cfg.active = e.target.checked; ConfigManager.persist(); });

    $('pc_backend')?.addEventListener('change', e => {
        cfg.backend = e.target.value;
        ConfigManager.persist();
        $('pc_nano_block')?.classList.toggle('pc-hidden', e.target.value !== 'gemini');
    });

    $('pc_endpoint')?.addEventListener('input', e => { cfg.endpointUrl = e.target.value; ConfigManager.persist(); });
    $('pc_secret')?.addEventListener('input', e => { cfg.secret = e.target.value; ConfigManager.persist(); });

    $('pc_eye')?.addEventListener('click', () => {
        const inp = $('pc_secret');
        const ico = document.querySelector('#pc_eye i');
        if (inp.type === 'password') { inp.type = 'text'; ico.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { inp.type = 'password'; ico.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    $('pc_model')?.addEventListener('change', e => {
        cfg.selectedModel = e.target.value;
        ConfigManager.persist();
        if (isNanoBanana(e.target.value)) {
            $('pc_backend').value = 'gemini';
            cfg.backend = 'gemini';
            $('pc_nano_block')?.classList.remove('pc-hidden');
        }
    });

    $('pc_reload_models')?.addEventListener('click', async e => {
        const btn = e.currentTarget;
        btn.classList.add('pc-spinning');
        try {
            const list = await queryAvailableModels();
            const sel = $('pc_model');
            const cur = cfg.selectedModel;
            sel.innerHTML = '<option value="">— выберите —</option>';
            for (const m of list) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === cur;
                sel.appendChild(opt);
            }
            toastr.success(`Моделей: ${list.length}`, 'PictureCraft');
        } finally { btn.classList.remove('pc-spinning'); }
    });

    $('pc_dim')?.addEventListener('change', e => { cfg.dimensions = e.target.value; ConfigManager.persist(); });
    $('pc_fidelity')?.addEventListener('change', e => { cfg.fidelity = e.target.value; ConfigManager.persist(); });
    $('pc_ratio')?.addEventListener('change', e => { cfg.ratio = e.target.value; ConfigManager.persist(); });
    $('pc_resolution')?.addEventListener('change', e => { cfg.resolution = e.target.value; ConfigManager.persist(); });

    $('pc_char_pic')?.addEventListener('change', e => { cfg.includeCharPic = e.target.checked; ConfigManager.persist(); });
    $('pc_player_pic')?.addEventListener('change', e => {
        cfg.includePlayerPic = e.target.checked;
        ConfigManager.persist();
        $('pc_avatar_row')?.classList.toggle('pc-hidden', !e.target.checked);
    });

    $('pc_avatar_file')?.addEventListener('change', e => {
        cfg.playerPicFilename = e.target.value;
        ConfigManager.persist();
        // Update avatar preview
        const preview = $('pc_avatar_preview');
        if (preview) {
            if (e.target.value) {
                preview.src = `/User Avatars/${encodeURIComponent(e.target.value)}`;
                preview.classList.remove('pc-hidden');
            } else {
                preview.src = '';
                preview.classList.add('pc-hidden');
            }
        }
    });

    $('pc_reload_avatars')?.addEventListener('click', async e => {
        const btn = e.currentTarget;
        btn.classList.add('pc-spinning');
        try {
            const avatars = await queryPlayerAvatarList();
            const sel = $('pc_avatar_file');
            const cur = cfg.playerPicFilename;
            sel.innerHTML = '<option value="">— нет —</option>';
            for (const a of avatars) {
                const opt = document.createElement('option');
                opt.value = a; opt.textContent = a; opt.selected = a === cur;
                sel.appendChild(opt);
            }
            toastr.success(`Аватаров: ${avatars.length}`, 'PictureCraft');
            // Update preview
            const preview = $('pc_avatar_preview');
            if (preview && cur) {
                preview.src = `/User Avatars/${encodeURIComponent(cur)}`;
                preview.classList.remove('pc-hidden');
            }
        } finally { btn.classList.remove('pc-spinning'); }
    });

    $('pc_attempts')?.addEventListener('input', e => { cfg.maxAttempts = parseInt(e.target.value) || 0; ConfigManager.persist(); });
    $('pc_pause')?.addEventListener('input', e => { cfg.pauseBetween = parseInt(e.target.value) || 1000; ConfigManager.persist(); });
    $('pc_dump_logs')?.addEventListener('click', () => diag.download());
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

(function bootstrap() {
    const ctx = SillyTavern.getContext();

    diag.info('Available events:', ctx.event_types);
    ConfigManager.load();

    ctx.eventSource.on(ctx.event_types.APP_READY, () => {
        assemblePanel();
        injectButtonsIntoChat();
        diag.info('PictureCraft extension loaded');
    });

    ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
        diag.info('Chat changed — injecting buttons');
        setTimeout(injectButtonsIntoChat, 100);
    });

    ctx.eventSource.makeLast(ctx.event_types.CHARACTER_MESSAGE_RENDERED, async (id) => {
        diag.info('CHARACTER_MESSAGE_RENDERED:', id);
        await onRendered(id);
    });

    diag.info('PictureCraft bootstrap complete');
})();
