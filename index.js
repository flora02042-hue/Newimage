/**
 * PictureCraft — Inline Image Generation Extension for SillyTavern
 * Catches [IMG:GEN:{json}] tags and <img data-iig-instruction> in AI messages.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
 * Features: Fullscreen viewer, per-image regeneration, SillyWardrobe outfit manager.
 */

const PLUGIN_ID = 'inline_image_gen';

// ─── Constants ───────────────────────────────────────────────────────────────

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

// ─── Diagnostics ─────────────────────────────────────────────────────────────

const diag = (() => {
    const _buf = [];
    const MAX = 200;
    const _log = (lvl, args) => {
        const ts = new Date().toISOString();
        const txt = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        _buf.push(`[${ts}] [${lvl}] ${txt}`);
        if (_buf.length > MAX) _buf.shift();
        const fn = lvl === 'ERROR' ? console.error : lvl === 'WARN' ? console.warn : console.log;
        fn('[PC]', ...args);
    };
    return {
        info: (...a) => _log('INFO', a),
        warn: (...a) => _log('WARN', a),
        error: (...a) => _log('ERROR', a),
        download: () => {
            const blob = new Blob([_buf.join('\n')], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `pc-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
            a.click();
            URL.revokeObjectURL(url);
            toastr.success('Логи экспортированы', 'PictureCraft');
        },
    };
})();

// ─── Configuration Manager ───────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
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
    // Vision API for wardrobe outfit detection from images
    visionEndpointUrl: '',
    visionSecret: '',
    visionModel: '',
    // Descriptor API for prompt enhancement via text LLM
    descriptorEndpointUrl: '',
    descriptorSecret: '',
    descriptorModel: '',
    descriptorEnabled: false,
});

class ConfigManager {
    static load() {
        const ctx = SillyTavern.getContext();
        if (!ctx.extensionSettings[PLUGIN_ID]) {
            ctx.extensionSettings[PLUGIN_ID] = structuredClone(DEFAULTS);
        }
        const s = ctx.extensionSettings[PLUGIN_ID];
        for (const k of Object.keys(DEFAULTS)) {
            if (!Object.hasOwn(s, k)) s[k] = DEFAULTS[k];
        }
        return s;
    }
    static persist() {
        const ctx = SillyTavern.getContext();
        ctx.saveSettingsDebounced();
    }
    /** Force immediate save — use for critical fields like API keys */
    static forceSave() {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.saveSettings === 'function') {
            ctx.saveSettings();
        } else {
            ctx.saveSettingsDebounced();
        }
    }
    static verify() {
        const cfg = this.load();
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

function isNanoBanana(id) { return id.toLowerCase().includes('nano-banana'); }

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
    } catch (e) { diag.error('Base64 conversion failed:', e); return null; }
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
        body: JSON.stringify({ image: parts[2], format: parts[1], ch_name: folder, filename: `pc_${stamp}` }),
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
    try { return (await fetch(path, { method: 'HEAD' })).ok; } catch { return false; }
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
        if (ch?.avatar) return await blobToBase64(`/characters/${encodeURIComponent(ch.avatar)}`);
        return null;
    } catch (e) { diag.error('Char avatar fetch error:', e); return null; }
}

async function grabPlayerPicture() {
    try {
        const cfg = ConfigManager.load();
        if (!cfg.playerPicFilename) return null;
        return await blobToBase64(`/User Avatars/${encodeURIComponent(cfg.playerPicFilename)}`);
    } catch (e) { diag.error('Player avatar fetch error:', e); return null; }
}

// ─── Model & Avatar List Fetchers ────────────────────────────────────────────

async function queryAvailableModels() {
    const cfg = ConfigManager.load();
    if (!cfg.endpointUrl || !cfg.secret) return [];
    const endpoint = `${cfg.endpointUrl.replace(/\/$/, '')}/v1/models`;
    try {
        const resp = await fetch(endpoint, { headers: { 'Authorization': `Bearer ${cfg.secret}` } });
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
        const resp = await fetch('/api/avatars/get', { method: 'POST', headers: ctx.getRequestHeaders() });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } catch (e) { diag.error('Avatar list fetch error:', e); return []; }
}

// ─── Prompt Composer ─────────────────────────────────────────────────────────

class PromptComposer {
    static async assemble(baseText, styleHint) {
        const segments = [];
        if (styleHint) segments.push(`[Style: ${styleHint}]`);

        // Inject active wardrobe outfits
        try {
            const outfitText = SillyWardrobe?.getActiveOutfits?.();
            if (outfitText) {
                segments.push(`[Current Clothing: ${outfitText}]`);
                diag.info(`Wardrobe injected: ${outfitText.slice(0, 80)}`);
            }
        } catch { /* wardrobe not ready yet */ }

        segments.push(baseText);
        let composed = segments.join('\n\n');

        // Enhance via Descriptor API (text LLM) if enabled
        try {
            composed = await DescriptorAPI.enhance(composed);
        } catch (e) {
            diag.warn('Descriptor enhancement skipped:', e.message);
        }

        diag.info(`Composed prompt: ${composed.length} chars, ${segments.length} segments`);
        return composed;
    }
}

// ─── Image Generation Backends ───────────────────────────────────────────────

class ArtworkBackend {
    static async callOpenAI(description, styleHint, refs = [], opts = {}) {
        const cfg = ConfigManager.load();
        const apiUrl = `${cfg.endpointUrl.replace(/\/$/, '')}/v1/images/generations`;
        const composed = await PromptComposer.assemble(description, styleHint);

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

        if (refs.length > 0) payload.image = `data:image/png;base64,${refs[0]}`;

        const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${cfg.secret}`, 'Content-Type': 'application/json' },
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

        let composed = await PromptComposer.assemble(description, styleHint);
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
            headers: { 'Authorization': `Bearer ${cfg.secret}`, 'Content-Type': 'application/json' },
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

            // Add Vision wardrobe reference image if available
            try {
                const ctx = SillyTavern.getContext();
                const charName = ctx.characters?.[ctx.characterId]?.name || '__global__';
                const wardrobeKey = `${PLUGIN_ID}_wardrobe`;
                const stored = ctx.extensionSettings[wardrobeKey];
                const visionRef = stored?.[charName]?._visionRefImage;
                if (visionRef) {
                    const visionB64 = await blobToBase64(visionRef);
                    if (visionB64) {
                        refs.push(visionB64);
                        diag.info('Vision wardrobe reference image added');
                    }
                }
            } catch (e) { diag.warn('Could not load vision ref:', e.message); }

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

// ─── Vision API — Outfit Detection from Images ──────────────────────────────

class VisionAPI {
    static async detectOutfit(imageBase64) {
        const cfg = ConfigManager.load();
        if (!cfg.visionEndpointUrl || !cfg.visionSecret || !cfg.visionModel) {
            throw new Error('Vision API не настроен (URL / ключ / модель)');
        }
        const url = `${cfg.visionEndpointUrl.replace(/\/$/, '')}/v1/chat/completions`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${cfg.visionSecret}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: cfg.visionModel,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
                        { type: 'text', text: 'Describe in detail what each person in this image is wearing. List clothing items separately for each character. Be specific about colors, styles, and accessories. Answer in English.' },
                    ],
                }],
                max_tokens: 500,
            }),
        });
        if (!resp.ok) { const t = await resp.text(); throw new Error(`Vision API (${resp.status}): ${t}`); }
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || 'No description';
    }
}

// ─── Descriptor API — Prompt Enhancement via Text LLM ────────────────────────

class DescriptorAPI {
    static async enhance(rawPrompt) {
        const cfg = ConfigManager.load();
        if (!cfg.descriptorEnabled || !cfg.descriptorEndpointUrl || !cfg.descriptorSecret || !cfg.descriptorModel) {
            return rawPrompt;
        }
        try {
            const url = `${cfg.descriptorEndpointUrl.replace(/\/$/, '')}/v1/chat/completions`;
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${cfg.descriptorSecret}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: cfg.descriptorModel,
                    messages: [
                        { role: 'system', content: 'You are an expert image prompt writer. Rewrite the given prompt to be more detailed and vivid for image generation. Keep the same scene and characters. Add artistic details, lighting, composition. Output ONLY the enhanced prompt, nothing else.' },
                        { role: 'user', content: rawPrompt },
                    ],
                    max_tokens: 600,
                    temperature: 0.7,
                }),
            });
            if (!resp.ok) { diag.warn(`Descriptor API error: ${resp.status}`); return rawPrompt; }
            const data = await resp.json();
            const enhanced = data.choices?.[0]?.message?.content?.trim();
            if (enhanced && enhanced.length > 10) {
                diag.info(`Prompt enhanced: ${enhanced.slice(0, 100)}...`);
                return enhanced;
            }
            return rawPrompt;
        } catch (e) { diag.warn('Descriptor API failed:', e.message); return rawPrompt; }
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
        return s.replace(/"/g, '"').replace(/'/g, "'").replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&/g, '&');
    }

    static async extract(text, opts = {}) {
        const { verifyPaths = false, includeAll = false } = opts;
        const results = [];

        // ── Pass 1: Modern format <img data-iig-instruction='{...}' src="[IMG:GEN]"> ──
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

            if (isErrorImg && !includeAll) { cursor = closeAngle + 1; continue; }

            let needsWork = false;
            if (includeAll) {
                needsWork = true;
            } else if (hasGenMarker || !srcVal) {
                needsWork = true;
            } else if (hasFilePath && verifyPaths) {
                const exists = await probeFileExists(srcVal);
                if (!exists) { diag.warn(`Path not found (hallucination?): ${srcVal}`); needsWork = true; }
            } else if (hasFilePath) {
                cursor = closeAngle + 1; continue;
            }

            if (!needsWork) { cursor = closeAngle + 1; continue; }

            try {
                const decoded = this._decodeEntities(rawJson);
                const obj = JSON.parse(decoded);
                results.push({
                    raw: fullTag, offset: openTag,
                    style: obj.style || '', prompt: obj.prompt || '',
                    aspectRatio: obj.aspect_ratio || obj.aspectRatio || null,
                    imageSize: obj.image_size || obj.imageSize || null,
                    quality: obj.quality || null, modern: true,
                    prevSrc: hasFilePath ? srcVal : null,
                });
                diag.info(`Modern tag found: "${(obj.prompt || '').slice(0, 50)}…"`);
            } catch (e) {
                diag.warn(`JSON parse error in modern tag: ${rawJson.slice(0, 100)}`, e.message);
            }
            cursor = closeAngle + 1;
        }

        // ── Pass 2: Legacy format [IMG:GEN:{...}] ──
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
                    raw: snippet, offset: start,
                    style: obj.style || '', prompt: obj.prompt || '',
                    aspectRatio: obj.aspect_ratio || obj.aspectRatio || null,
                    imageSize: obj.image_size || obj.imageSize || null,
                    quality: obj.quality || null, modern: false,
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
 * Create an image wrapper with per-image regen button overlay.
 * Uses event delegation-friendly approach — regen handler is self-contained.
 */
function wrapWithRegenOverlay(imgEl, tag, messageId) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pc-img-wrap';

    const regenBtn = document.createElement('div');
    regenBtn.className = 'pc-img-regen-btn';
    regenBtn.title = 'Перегенерировать эту картинку';
    regenBtn.innerHTML = '<i class="fa-solid fa-rotate"></i>';

    const doRegen = async () => {
        const ctx = SillyTavern.getContext();
        const msg = ctx.chat[messageId];
        if (!msg) return;

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
                const iMatch = tag.raw.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (iMatch) newImg.setAttribute('data-iig-instruction', iMatch[2]);
            }

            const newWrap = wrapWithRegenOverlay(newImg, tag, messageId);
            spinner.replaceWith(newWrap);

            if (tag.modern) {
                const oldSrc = imgEl.src;
                const escaped = oldSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                msg.mes = msg.mes.replace(new RegExp(`src=["']${escaped}["']`, 'i'), `src="${filePath}"`);
            }
            await ctx.saveChat();
            toastr.success('Картинка перегенерирована', 'PictureCraft', { timeOut: 2000 });
        } catch (err) {
            diag.error('Single regen failed:', err.message);
            const failW = buildFailureWidget(uid, err.message, tag);
            spinner.replaceWith(failW);
            toastr.error(`Ошибка: ${err.message}`, 'PictureCraft');
        }
    };

    regenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        doRegen();
    });

    // Click on image itself → fullscreen viewer
    imgEl.addEventListener('click', (e) => {
        e.stopPropagation();
        FullscreenViewer.open(imgEl.src, tag, messageId);
    });
    imgEl.style.cursor = 'zoom-in';

    imgEl.parentNode?.insertBefore(wrapper, imgEl);
    wrapper.appendChild(imgEl);
    wrapper.appendChild(regenBtn);
    return wrapper;
}

// ─── Fullscreen Viewer ───────────────────────────────────────────────────────

const FullscreenViewer = (() => {
    let overlay = null;
    let currentZoom = 1;
    let panX = 0, panY = 0;
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;

    function _ensure() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.className = 'pc-fullscreen-overlay';
        overlay.innerHTML = `
            <div class="pc-fs-toolbar">
                <div class="pc-fs-btn pc-fs-zoom-in" title="Увеличить"><i class="fa-solid fa-magnifying-glass-plus"></i></div>
                <div class="pc-fs-btn pc-fs-zoom-out" title="Уменьшить"><i class="fa-solid fa-magnifying-glass-minus"></i></div>
                <div class="pc-fs-btn pc-fs-zoom-reset" title="Сброс"><i class="fa-solid fa-expand"></i></div>
                <div class="pc-fs-btn pc-fs-regen" title="Перегенерировать"><i class="fa-solid fa-rotate"></i></div>
                <div class="pc-fs-btn pc-fs-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="pc-fs-img-container">
                <img class="pc-fs-image" src="" alt="">
            </div>
        `;
        document.body.appendChild(overlay);

        // Event handlers
        overlay.querySelector('.pc-fs-close').addEventListener('click', () => close());
        overlay.querySelector('.pc-fs-zoom-in').addEventListener('click', () => _zoom(0.25));
        overlay.querySelector('.pc-fs-zoom-out').addEventListener('click', () => _zoom(-0.25));
        overlay.querySelector('.pc-fs-zoom-reset').addEventListener('click', () => _resetZoom());

        // Close on backdrop click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.classList.contains('pc-fs-img-container')) close();
        });

        // Scroll to zoom
        overlay.addEventListener('wheel', (e) => {
            e.preventDefault();
            _zoom(e.deltaY < 0 ? 0.15 : -0.15);
        }, { passive: false });

        // Pan with drag
        const container = overlay.querySelector('.pc-fs-img-container');
        container.addEventListener('mousedown', (e) => {
            if (currentZoom <= 1) return;
            isDragging = true;
            dragStartX = e.clientX - panX;
            dragStartY = e.clientY - panY;
            container.style.cursor = 'grabbing';
        });
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panX = e.clientX - dragStartX;
            panY = e.clientY - dragStartY;
            _applyTransform();
        });
        document.addEventListener('mouseup', () => {
            isDragging = false;
            if (overlay) {
                const container = overlay.querySelector('.pc-fs-img-container');
                if (container) container.style.cursor = currentZoom > 1 ? 'grab' : 'default';
            }
        });

        // ESC to close
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay?.classList.contains('pc-fs-active')) close();
        });
    }

    function _zoom(delta) {
        currentZoom = Math.max(0.25, Math.min(5, currentZoom + delta));
        _applyTransform();
    }

    function _resetZoom() {
        currentZoom = 1;
        panX = 0;
        panY = 0;
        _applyTransform();
    }

    function _applyTransform() {
        const img = overlay.querySelector('.pc-fs-image');
        img.style.transform = `translate(${panX}px, ${panY}px) scale(${currentZoom})`;
        const container = overlay.querySelector('.pc-fs-img-container');
        container.style.cursor = currentZoom > 1 ? 'grab' : 'default';
    }

    function open(src, tag, messageId) {
        _ensure();
        currentZoom = 1;
        panX = 0;
        panY = 0;
        const img = overlay.querySelector('.pc-fs-image');
        img.src = src;
        img.style.transform = '';
        overlay.classList.add('pc-fs-active');
        document.body.style.overflow = 'hidden';

        // Wire regen button
        const regenBtn = overlay.querySelector('.pc-fs-regen');
        const newRegen = regenBtn.cloneNode(true);
        regenBtn.replaceWith(newRegen);
        newRegen.addEventListener('click', async () => {
            close();
            // Find the image in DOM and trigger regen
            const allWraps = document.querySelectorAll('.pc-img-wrap');
            for (const wrap of allWraps) {
                const wrapImg = wrap.querySelector('.pc-result-img');
                if (wrapImg && wrapImg.src === src) {
                    const btn = wrap.querySelector('.pc-img-regen-btn');
                    if (btn) btn.click();
                    return;
                }
            }
            toastr.warning('Не удалось найти картинку для перегенерации', 'PictureCraft');
        });
    }

    function close() {
        if (!overlay) return;
        overlay.classList.remove('pc-fs-active');
        document.body.style.overflow = '';
    }

    return { open, close };
})();

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
                if (cs.display === 'flex' || cs.display === 'grid') spinner.style.alignSelf = 'center';
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

            // Wrap image with regen overlay + fullscreen click
            const wrapped = wrapWithRegenOverlay(pic, tag, messageId);
            spinner.replaceWith(wrapped);

            // Persist path
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
                const parentWrap = existing.closest('.pc-img-wrap');
                const spinner = buildSpinner(uid);
                if (parentWrap) parentWrap.replaceWith(spinner);
                else existing.replaceWith(spinner);

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

                const wrap = wrapWithRegenOverlay(pic, tag, messageId);
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

// ─── SillyWardrobe — Outfit Manager ─────────────────────────────────────────

const SillyWardrobe = (() => {
    let modal = null;
    const STORAGE_KEY = `${PLUGIN_ID}_wardrobe`;

    function _getOutfits() {
        const ctx = SillyTavern.getContext();
        const charName = ctx.characters?.[ctx.characterId]?.name || '__global__';
        const stored = ctx.extensionSettings[STORAGE_KEY] || {};
        if (!stored[charName]) stored[charName] = { char: [], user: [] };
        ctx.extensionSettings[STORAGE_KEY] = stored;
        return stored[charName];
    }

    function _save() {
        SillyTavern.getContext().saveSettingsDebounced();
    }

    function _buildModal() {
        if (modal) { modal.remove(); modal = null; }

        const ctx = SillyTavern.getContext();
        const charName = ctx.characters?.[ctx.characterId]?.name || 'Персонаж';
        const userName = ctx.name1 || 'Пользователь';
        const outfits = _getOutfits();

        modal = document.createElement('div');
        modal.className = 'pc-wardrobe-overlay';
        modal.innerHTML = `
            <div class="pc-wardrobe-modal">
                <div class="pc-wardrobe-header">
                    <h3><i class="fa-solid fa-shirt"></i> Гардероб</h3>
                    <div class="pc-wardrobe-close" title="Закрыть"><i class="fa-solid fa-xmark"></i></div>
                </div>
                <div class="pc-wardrobe-body">
                    <div class="pc-wardrobe-section">
                        <h4><i class="fa-solid fa-user-pen"></i> ${escapeHtmlText(charName)}</h4>
                        <div class="pc-wardrobe-list" data-who="char"></div>
                        <div class="pc-wardrobe-add-row">
                            <input type="text" class="text_pole pc-wardrobe-input" data-who="char" placeholder="Новый аутфит: кимоно, красные сандалии...">
                            <div class="menu_button pc-wardrobe-add-btn" data-who="char" title="Добавить"><i class="fa-solid fa-plus"></i></div>
                        </div>
                    </div>
                    <hr>
                    <div class="pc-wardrobe-section">
                        <h4><i class="fa-solid fa-user"></i> ${escapeHtmlText(userName)}</h4>
                        <div class="pc-wardrobe-list" data-who="user"></div>
                        <div class="pc-wardrobe-add-row">
                            <input type="text" class="text_pole pc-wardrobe-input" data-who="user" placeholder="Новый аутфит: джинсы, белая футболка...">
                            <div class="menu_button pc-wardrobe-add-btn" data-who="user" title="Добавить"><i class="fa-solid fa-plus"></i></div>
                        </div>
                    </div>
                    <hr>
                    <div class="pc-wardrobe-section">
                        <h4><i class="fa-solid fa-eye"></i> Определить по картинке (Vision)</h4>
                        <p class="pc-hint">Загрузите скриншот или картинку — Vision-модель определит одежду и добавит в гардероб.</p>
                        <div class="pc-wardrobe-vision-preview-wrap" style="display:none;margin:8px 0;text-align:center;">
                            <img class="pc-wardrobe-vision-preview" style="max-width:200px;max-height:200px;border-radius:8px;border:2px solid var(--SmartThemeBorderColor);">
                            <p class="pc-hint" style="margin-top:4px;"><i class="fa-solid fa-check-circle" style="color:#7f7;"></i> Картинка будет использована как референс</p>
                        </div>
                        <div class="pc-wardrobe-add-row" style="gap:8px;">
                            <label class="menu_button pc-wardrobe-file-label" style="flex:1;text-align:center;cursor:pointer;position:relative;overflow:hidden;">
                                <i class="fa-solid fa-image"></i> Выбрать картинку
                                <input type="file" class="pc-wardrobe-vision-file" accept="image/*" style="position:absolute;opacity:0;width:100%;height:100%;left:0;top:0;cursor:pointer;">
                            </label>
                            <div class="menu_button pc-wardrobe-vision-btn" title="Распознать"><i class="fa-solid fa-wand-magic-sparkles"></i> Распознать</div>
                        </div>
                        <div class="pc-wardrobe-vision-results"></div>
                    </div>
                    <hr>
                    <div class="pc-wardrobe-section">
                        <h4><i class="fa-solid fa-magnifying-glass"></i> Анализ из чата</h4>
                        <p class="pc-hint">Поиск упоминаний одежды в последних сообщениях чата.</p>
                        <div class="pc-wardrobe-add-row">
                            <label>Глубина:</label>
                            <input type="number" class="text_pole pc-wardrobe-depth" value="5" min="1" max="30" style="width:60px;">
                            <div class="menu_button pc-wardrobe-scan-btn" title="Сканировать"><i class="fa-solid fa-radar"></i> Сканировать</div>
                        </div>
                        <div class="pc-wardrobe-scan-results"></div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Render lists
        _renderList('char', outfits.char);
        _renderList('user', outfits.user);

        // Event handlers
        modal.querySelector('.pc-wardrobe-close').addEventListener('click', close);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) close();
        });

        // Add outfit buttons
        for (const btn of modal.querySelectorAll('.pc-wardrobe-add-btn')) {
            btn.addEventListener('click', () => {
                const who = btn.dataset.who;
                const input = modal.querySelector(`.pc-wardrobe-input[data-who="${who}"]`);
                const text = input.value.trim();
                if (!text) return;
                const outfits = _getOutfits();
                outfits[who].push({ description: text, active: false, timestamp: Date.now() });
                _save();
                _renderList(who, outfits[who]);
                input.value = '';
                toastr.success('Аутфит добавлен', 'Гардероб');
            });
        }

        // Enter key in inputs
        for (const input of modal.querySelectorAll('.pc-wardrobe-input')) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const who = input.dataset.who;
                    modal.querySelector(`.pc-wardrobe-add-btn[data-who="${who}"]`).click();
                }
            });
        }

        // File input — show preview when file selected
        modal.querySelector('.pc-wardrobe-vision-file')?.addEventListener('change', (e) => {
            const previewWrap = modal.querySelector('.pc-wardrobe-vision-preview-wrap');
            const previewImg = modal.querySelector('.pc-wardrobe-vision-preview');
            const fileLabel = modal.querySelector('.pc-wardrobe-file-label');
            if (e.target.files?.length) {
                const file = e.target.files[0];
                const url = URL.createObjectURL(file);
                previewImg.src = url;
                previewWrap.style.display = 'block';
                if (fileLabel) fileLabel.innerHTML = `<i class="fa-solid fa-check"></i> ${escapeHtmlText(file.name.slice(0, 30))}`;
            } else {
                previewWrap.style.display = 'none';
                if (fileLabel) fileLabel.innerHTML = '<i class="fa-solid fa-image"></i> Выбрать картинку';
            }
        });

        // Vision button — detect outfits from uploaded image, auto-add & activate
        modal.querySelector('.pc-wardrobe-vision-btn')?.addEventListener('click', async () => {
            const fileInput = modal.querySelector('.pc-wardrobe-vision-file');
            const resultsDiv = modal.querySelector('.pc-wardrobe-vision-results');
            
            if (!fileInput?.files?.length) {
                toastr.warning('Выберите изображение', 'Гардероб');
                return;
            }

            const file = fileInput.files[0];
            resultsDiv.innerHTML = '<p class="pc-hint"><i class="fa-solid fa-spinner fa-spin"></i> Анализ изображения через Vision API...</p>';

            try {
                // Convert file to base64
                const base64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                // Save the image as a reference for future generations
                const dataUrl = `data:image/${file.type.split('/')[1] || 'png'};base64,${base64}`;
                try {
                    const refPath = await uploadGeneratedImage(dataUrl);
                    // Store reference image path in wardrobe storage
                    const ctx = SillyTavern.getContext();
                    const charName = ctx.characters?.[ctx.characterId]?.name || '__global__';
                    const stored = ctx.extensionSettings[STORAGE_KEY] || {};
                    if (!stored[charName]) stored[charName] = { char: [], user: [] };
                    stored[charName]._visionRefImage = refPath;
                    ctx.extensionSettings[STORAGE_KEY] = stored;
                    _save();
                    diag.info(`Vision reference image saved: ${refPath}`);
                } catch (e) {
                    diag.warn('Could not save vision reference image:', e.message);
                }

                const description = await VisionAPI.detectOutfit(base64);
                diag.info(`Vision detected: ${description.slice(0, 300)}`);

                // Parse into lines
                const lines = description.split(/[\n\r]+/).filter(l => l.trim().length > 5);
                
                if (!lines.length) {
                    resultsDiv.innerHTML = '<p class="pc-hint">Vision не смогла определить одежду.</p>';
                    return;
                }

                // Auto-add ALL detected items to CHAR wardrobe and ACTIVATE them
                const outfits = _getOutfits();
                const addedItems = [];
                for (const line of lines) {
                    const text = line.trim();
                    // Avoid duplicates
                    const exists = outfits.char.some(o => o.description.toLowerCase() === text.toLowerCase());
                    if (!exists) {
                        outfits.char.push({ description: text, active: true, timestamp: Date.now() });
                        addedItems.push(text);
                    }
                }
                _save();
                _renderList('char', outfits.char);

                // Show results with indication they were auto-added
                resultsDiv.innerHTML = `
                    <p class="pc-hint" style="margin-bottom:6px;color:#7f7;">✅ Распознано и добавлено в гардероб {{char}} (${addedItems.length} шт.):</p>
                    ${addedItems.map(item => `
                        <div class="pc-wardrobe-scan-item" style="border-left:3px solid #7f7;padding-left:8px;">
                            <span>✓ ${escapeHtmlText(item)}</span>
                        </div>
                    `).join('')}
                    <p class="pc-hint" style="margin-top:8px;">Аутфиты активированы и будут добавлены в промпт генерации. Для переноса в {{user}} — используйте списки выше.</p>
                `;

                toastr.success(`Распознано ${addedItems.length} аутфитов и активировано`, 'Гардероб');
            } catch (err) {
                diag.error('Vision outfit detection failed:', err.message);
                resultsDiv.innerHTML = `<p class="pc-hint" style="color: #ff6666;">Ошибка Vision: ${escapeHtmlText(err.message)}</p>`;
                toastr.error(`Vision: ${err.message}`, 'Гардероб');
            }
        });

        // Scan button
        modal.querySelector('.pc-wardrobe-scan-btn')?.addEventListener('click', () => {
            const depth = parseInt(modal.querySelector('.pc-wardrobe-depth')?.value) || 5;
            const found = _scanChatForClothing(depth);
            const container = modal.querySelector('.pc-wardrobe-scan-results');
            if (!found.length) {
                container.innerHTML = '<p class="pc-hint">Ничего не найдено.</p>';
                return;
            }
            container.innerHTML = found.map((item, i) => `
                <div class="pc-wardrobe-scan-item">
                    <span class="pc-wardrobe-scan-who">${escapeHtmlText(item.speaker)}:</span>
                    <span>${escapeHtmlText(item.text)}</span>
                    <div class="menu_button pc-wardrobe-adopt-btn" data-scan-idx="${i}" title="Добавить в гардероб"><i class="fa-solid fa-plus"></i></div>
                </div>
            `).join('');

            for (const adoptBtn of container.querySelectorAll('.pc-wardrobe-adopt-btn')) {
                adoptBtn.addEventListener('click', () => {
                    const idx = parseInt(adoptBtn.dataset.scanIdx);
                    const item = found[idx];
                    if (!item) return;
                    const who = item.isUser ? 'user' : 'char';
                    const outfits = _getOutfits();
                    outfits[who].push({ description: item.text, active: false, timestamp: Date.now() });
                    _save();
                    _renderList(who, outfits[who]);
                    adoptBtn.remove();
                    toastr.success(`Добавлено для ${item.speaker}`, 'Гардероб');
                });
            }
        });

        // ESC to close
        const escHandler = (e) => {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
        };
        document.addEventListener('keydown', escHandler);
    }

    function _renderList(who, items) {
        const container = modal?.querySelector(`.pc-wardrobe-list[data-who="${who}"]`);
        if (!container) return;

        if (!items.length) {
            container.innerHTML = '<p class="pc-hint">Пусто. Добавьте аутфит.</p>';
            return;
        }

        container.innerHTML = items.map((item, i) => `
            <div class="pc-wardrobe-item ${item.active ? 'pc-wardrobe-active' : ''}" data-idx="${i}">
                <label class="checkbox_label">
                    <input type="checkbox" class="pc-wardrobe-toggle" data-who="${who}" data-idx="${i}" ${item.active ? 'checked' : ''}>
                    <span>${escapeHtmlText(item.description)}</span>
                </label>
                <div class="pc-wardrobe-item-actions">
                    <div class="menu_button pc-wardrobe-del-btn" data-who="${who}" data-idx="${i}" title="Удалить"><i class="fa-solid fa-trash"></i></div>
                </div>
            </div>
        `).join('');

        // Toggle active
        for (const toggle of container.querySelectorAll('.pc-wardrobe-toggle')) {
            toggle.addEventListener('change', (e) => {
                const w = e.target.dataset.who;
                const idx = parseInt(e.target.dataset.idx);
                const outfits = _getOutfits();
                outfits[w][idx].active = e.target.checked;
                _save();
                _renderList(w, outfits[w]);
            });
        }

        // Delete
        for (const del of container.querySelectorAll('.pc-wardrobe-del-btn')) {
            del.addEventListener('click', () => {
                const w = del.dataset.who;
                const idx = parseInt(del.dataset.idx);
                const outfits = _getOutfits();
                outfits[w].splice(idx, 1);
                _save();
                _renderList(w, outfits[w]);
                toastr.info('Аутфит удалён', 'Гардероб');
            });
        }
    }

    function _scanChatForClothing(depth) {
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!chat?.length) return [];

        const charName = ctx.characters?.[ctx.characterId]?.name || 'Character';
        const userName = ctx.name1 || 'User';
        const patterns = [
            /(?:wearing|wears?|dressed\s+in|clothed\s+in|puts?\s+on|changed?\s+into)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:outfit|clothes|clothing|attire|garment|dress|costume)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:a|an|the|his|her|their|my)\s+([\w\s\-]+(?:dress|shirt|jacket|coat|pants|jeans|skirt|blouse|sweater|hoodie|uniform|suit|armor|robe|gown|outfit|costume|clothes))/gi,
            /(?:одет[аоы]?|носит|оделс?я?|переодел[аи]?сь?)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:одежда|наряд|костюм|форма)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:платье|халат|мантия|униформа|доспех|рубашк|блузк|куртк|пальто|свитер|худи|футболк|майк|брюк|джинс|шорт|юбк|штан)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
        ];

        const found = [];
        const seen = new Set();
        const start = Math.max(0, chat.length - depth);

        for (let i = chat.length - 1; i >= start; i--) {
            const msg = chat[i];
            if (!msg?.mes) continue;
            const speaker = msg.is_user ? userName : charName;

            for (const pat of patterns) {
                pat.lastIndex = 0;
                for (const m of msg.mes.matchAll(pat)) {
                    const txt = (m[1] || m[0]).trim();
                    if (txt.length < 4 || seen.has(txt.toLowerCase())) continue;
                    seen.add(txt.toLowerCase());
                    found.push({ text: txt, speaker, isUser: msg.is_user, msgIdx: i });
                }
            }
        }
        return found;
    }

    /** Get currently active outfit descriptions for prompt injection */
    function getActiveOutfits() {
        try {
            const outfits = _getOutfits();
            const ctx = SillyTavern.getContext();
            const charName = ctx.characters?.[ctx.characterId]?.name || 'Character';
            const userName = ctx.name1 || 'User';
            const parts = [];

            const charActive = outfits.char.filter(o => o.active).map(o => o.description);
            const userActive = outfits.user.filter(o => o.active).map(o => o.description);

            if (charActive.length) parts.push(`${charName} is wearing: ${charActive.join(', ')}`);
            if (userActive.length) parts.push(`${userName} is wearing: ${userActive.join(', ')}`);

            return parts.length ? parts.join('. ') + '.' : null;
        } catch { return null; }
    }

    function open() { _buildModal(); }
    function close() { if (modal) { modal.remove(); modal = null; } }

    return { open, close, getActiveOutfits };
})();

// ─── Wardrobe Chat Button ────────────────────────────────────────────────────

function injectWardrobeButton() {
    if (document.getElementById('pc-wardrobe-chat-btn')) return;

    const sendArea = document.getElementById('send_but_sheld');
    if (!sendArea) {
        diag.warn('send_but_sheld not found, wardrobe button not injected');
        return;
    }

    const btn = document.createElement('div');
    btn.id = 'pc-wardrobe-chat-btn';
    btn.className = 'menu_button interactable';
    btn.title = 'Гардероб (PictureCraft)';
    btn.innerHTML = '<i class="fa-solid fa-shirt"></i>';
    btn.addEventListener('click', () => SillyWardrobe.open());

    sendArea.appendChild(btn);
    diag.info('Wardrobe chat button injected');
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
                <h4>🔍 Vision API (определение одежды)</h4>
                <p class="pc-hint">Vision-модель для распознавания одежды по картинкам в гардеробе.</p>
                <div class="pc-row">
                    <label for="pc_vision_endpoint">URL</label>
                    <input type="text" id="pc_vision_endpoint" class="text_pole pc-grow" value="${cfg.visionEndpointUrl || ''}" placeholder="https://api.example.com">
                </div>
                <div class="pc-row">
                    <label for="pc_vision_secret">Ключ</label>
                    <input type="password" id="pc_vision_secret" class="text_pole pc-grow" value="${cfg.visionSecret || ''}">
                </div>
                <div class="pc-row">
                    <label for="pc_vision_model">Модель</label>
                    <input type="text" id="pc_vision_model" class="text_pole pc-grow" value="${cfg.visionModel || ''}" placeholder="gpt-4o / gemini-pro-vision">
                </div>
                <hr>
                <h4>✨ Descriptor API (улучшение промпта)</h4>
                <p class="pc-hint">Текстовая LLM для автоматического улучшения промпта перед генерацией.</p>
                <label class="checkbox_label">
                    <input type="checkbox" id="pc_desc_enabled" ${cfg.descriptorEnabled ? 'checked' : ''}>
                    <span>Включить улучшение промпта</span>
                </label>
                <div class="pc-row">
                    <label for="pc_desc_endpoint">URL</label>
                    <input type="text" id="pc_desc_endpoint" class="text_pole pc-grow" value="${cfg.descriptorEndpointUrl || ''}" placeholder="https://api.example.com">
                </div>
                <div class="pc-row">
                    <label for="pc_desc_secret">Ключ</label>
                    <input type="password" id="pc_desc_secret" class="text_pole pc-grow" value="${cfg.descriptorSecret || ''}">
                </div>
                <div class="pc-row">
                    <label for="pc_desc_model">Модель</label>
                    <input type="text" id="pc_desc_model" class="text_pole pc-grow" value="${cfg.descriptorModel || ''}" placeholder="gpt-4o-mini / claude-3-haiku">
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
                <h4>Гардероб</h4>
                <div class="pc-row">
                    <div id="pc_open_wardrobe" class="menu_button" style="width:100%"><i class="fa-solid fa-shirt"></i> Открыть гардероб</div>
                </div>
                <p class="pc-hint">Управление аутфитами персонажей. Активные аутфиты добавляются в промпт генерации.</p>
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

    $('pc_endpoint')?.addEventListener('change', e => { cfg.endpointUrl = e.target.value; ConfigManager.forceSave(); });
    $('pc_endpoint')?.addEventListener('input', e => { cfg.endpointUrl = e.target.value; ConfigManager.persist(); });
    $('pc_secret')?.addEventListener('change', e => { cfg.secret = e.target.value; ConfigManager.forceSave(); });
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
    $('pc_open_wardrobe')?.addEventListener('click', () => SillyWardrobe.open());

    // Vision API fields
    $('pc_vision_endpoint')?.addEventListener('change', e => { cfg.visionEndpointUrl = e.target.value; ConfigManager.forceSave(); });
    $('pc_vision_endpoint')?.addEventListener('input', e => { cfg.visionEndpointUrl = e.target.value; ConfigManager.persist(); });
    $('pc_vision_secret')?.addEventListener('change', e => { cfg.visionSecret = e.target.value; ConfigManager.forceSave(); });
    $('pc_vision_secret')?.addEventListener('input', e => { cfg.visionSecret = e.target.value; ConfigManager.persist(); });
    $('pc_vision_model')?.addEventListener('change', e => { cfg.visionModel = e.target.value; ConfigManager.forceSave(); });
    $('pc_vision_model')?.addEventListener('input', e => { cfg.visionModel = e.target.value; ConfigManager.persist(); });

    // Descriptor API fields
    $('pc_desc_enabled')?.addEventListener('change', e => { cfg.descriptorEnabled = e.target.checked; ConfigManager.persist(); });
    $('pc_desc_endpoint')?.addEventListener('change', e => { cfg.descriptorEndpointUrl = e.target.value; ConfigManager.forceSave(); });
    $('pc_desc_endpoint')?.addEventListener('input', e => { cfg.descriptorEndpointUrl = e.target.value; ConfigManager.persist(); });
    $('pc_desc_secret')?.addEventListener('change', e => { cfg.descriptorSecret = e.target.value; ConfigManager.forceSave(); });
    $('pc_desc_secret')?.addEventListener('input', e => { cfg.descriptorSecret = e.target.value; ConfigManager.persist(); });
    $('pc_desc_model')?.addEventListener('change', e => { cfg.descriptorModel = e.target.value; ConfigManager.forceSave(); });
    $('pc_desc_model')?.addEventListener('input', e => { cfg.descriptorModel = e.target.value; ConfigManager.persist(); });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

(function bootstrap() {
    const ctx = SillyTavern.getContext();

    diag.info('Available events:', ctx.event_types);
    ConfigManager.load();

    ctx.eventSource.on(ctx.event_types.APP_READY, () => {
        assemblePanel();
        injectButtonsIntoChat();
        injectWardrobeButton();
        diag.info('PictureCraft extension loaded');
    });

    ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
        diag.info('Chat changed — injecting buttons');
        setTimeout(() => {
            injectButtonsIntoChat();
            injectWardrobeButton();
        }, 100);
    });

    ctx.eventSource.makeLast(ctx.event_types.CHARACTER_MESSAGE_RENDERED, async (id) => {
        diag.info('CHARACTER_MESSAGE_RENDERED:', id);
        await onRendered(id);
    });

    diag.info('PictureCraft bootstrap complete');
})();
