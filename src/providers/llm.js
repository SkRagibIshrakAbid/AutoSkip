/**
 * AutoSkip — LLM provider. Runs in the service worker ONLY.
 *
 * The service worker is the right home for two reasons: it holds host
 * permissions, and API keys must never reach the MAIN world, which shares
 * scope with YouTube's own scripts.
 */
(function (root) {
  'use strict';

  var SYSTEM_PROMPT = [
    'You identify paid sponsor reads and self-promotion inside a video transcript.',
    '',
    'The transcript is given as numbered lines. You MUST NOT output timestamps —',
    'only line indices, which the caller maps back to times itself.',
    '',
    'Return JSON only, matching exactly:',
    '{"segments":[{"startLine":<int>,"endLine":<int>,"category":"sponsor"|"selfpromo",',
    '"confidence":<0..1>,"quote":"<verbatim text copied from those lines>"}]}',
    '',
    'Rules:',
    '- "sponsor": a paid advertisement for a third-party product or service.',
    '- "selfpromo": the creator promoting their own merch, Patreon, course or channel.',
    '- startLine is the first line of the ad read; endLine is the LAST line of it.',
    '  Do not include surrounding content. Do not extend to the end of the video.',
    '- "quote" MUST be copied verbatim from within startLine..endLine. It is verified',
    '  against the transcript and the segment is discarded if it does not match.',
    '- Only report a segment you are confident about. Discussing or reviewing a',
    '  product is NOT a sponsor read; it must be a paid promotion.',
    '- If there are none, return {"segments":[]}. Do not invent segments.'
  ].join('\n');

  var PROVIDERS = {
    ollama: { label: 'Ollama (local)', defaultBaseUrl: 'http://localhost:11434', defaultModel: 'llama3.1', needsKey: false },
    openai: { label: 'OpenAI-compatible', defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', needsKey: true },
    anthropic: { label: 'Anthropic (Claude)', defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-5', needsKey: true },
    gemini: { label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com', defaultModel: 'gemini-2.0-flash', needsKey: true }
  };

  function userPrompt(promptLines) {
    return 'Transcript:\n\n' + promptLines + '\n\nReturn the JSON now.';
  }

  function trimBase(u) { return String(u || '').replace(/\/+$/, ''); }

  async function withTimeout(fn, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms || 90000);
    try { return await fn(ctrl.signal); }
    finally { clearTimeout(timer); }
  }

  async function failFrom(res) {
    var body = '';
    try { body = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
    return new Error('HTTP ' + res.status + (body ? ': ' + body : ''));
  }

  // ─────────────────────────────────────────────────────────── backends

  async function callOllama(cfg, prompt, signal) {
    var res = await fetch(trimBase(cfg.baseUrl) + '/api/chat', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt(prompt) }
        ]
      })
    });
    if (!res.ok) throw await failFrom(res);
    var j = await res.json();
    return { text: j && j.message ? j.message.content : '', usage: null };
  }

  async function callOpenAI(cfg, prompt, signal, retryWithoutJsonMode) {
    var body = {
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt(prompt) }
      ]
    };
    // Not every OpenAI-compatible server understands response_format; a 400
    // gets one retry without it rather than failing the whole analysis.
    if (!retryWithoutJsonMode) body.response_format = { type: 'json_object' };

    var res = await fetch(trimBase(cfg.baseUrl) + '/chat/completions', {
      method: 'POST', signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body)
    });

    if (res.status === 400 && !retryWithoutJsonMode) {
      return callOpenAI(cfg, prompt, signal, true);
    }
    if (!res.ok) throw await failFrom(res);
    var j = await res.json();
    return {
      text: j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '',
      usage: j && j.usage ? j.usage : null
    };
  }

  async function callAnthropic(cfg, prompt, signal) {
    var res = await fetch(trimBase(cfg.baseUrl) + '/v1/messages', {
      method: 'POST', signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        // Required for any call originating from a browser context.
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 2048,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt(prompt) }]
      })
    });
    if (!res.ok) throw await failFrom(res);
    var j = await res.json();
    var text = (j && Array.isArray(j.content) ? j.content : [])
      .filter(function (c) { return c && c.type === 'text'; })
      .map(function (c) { return c.text; })
      .join('');
    return { text: text, usage: j && j.usage ? j.usage : null };
  }

  async function callGemini(cfg, prompt, signal) {
    var url = trimBase(cfg.baseUrl) + '/v1beta/models/' +
      encodeURIComponent(cfg.model) + ':generateContent?key=' + encodeURIComponent(cfg.apiKey);
    var res = await fetch(url, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt(prompt) }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' }
      })
    });
    if (!res.ok) throw await failFrom(res);
    var j = await res.json();
    var cand = j && j.candidates && j.candidates[0];
    var text = cand && cand.content && Array.isArray(cand.content.parts)
      ? cand.content.parts.map(function (p) { return p.text || ''; }).join('')
      : '';
    return { text: text, usage: j && j.usageMetadata ? j.usageMetadata : null };
  }

  var BACKENDS = {
    ollama: callOllama,
    openai: callOpenAI,
    anthropic: callAnthropic,
    gemini: callGemini
  };

  /** cfg: { provider, baseUrl, apiKey, model, timeoutMs } */
  async function analyze(cfg, promptLines) {
    var backend = BACKENDS[cfg.provider];
    if (!backend) throw new Error('Unknown provider: ' + cfg.provider);
    var meta = PROVIDERS[cfg.provider];
    if (meta.needsKey && !cfg.apiKey) throw new Error(meta.label + ' needs an API key');
    return withTimeout(function (signal) {
      return backend(cfg, promptLines, signal);
    }, cfg.timeoutMs);
  }

  root.ASLlm = {
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    PROVIDERS: PROVIDERS,
    analyze: analyze,
    _userPrompt: userPrompt
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.ASLlm;
})(typeof globalThis !== 'undefined' ? globalThis : this);
