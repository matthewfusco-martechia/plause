import { ModelCallError } from '../../contracts/src/index';

export type ResearchCommand = { type: 'search'; query: string } | { type: 'help' } | { type: 'invalid'; reason: string };
export interface ResearchResult { title: string; url: string; snippet: string }
export const RESEARCH_HELP = 'Search public information with search: <query> or research: <query>. Send one unquoted command on one line, up to 300 characters. Only that query is sent to the search provider; chat history and saved facts are not included. Results are source snippets with links, not independently verified facts. Research is off until an operator configures and enables it.';

export function parseResearchCommand(text: string): ResearchCommand | null {
  const command = text.trim();
  if (!/^(?:search[ \t]*:|research(?:[ \t]*:|[ \t]+help\b|$))/i.test(command)) return null;
  if (/[\r\n\u0085\u2028\u2029]/.test(text)) return { type: 'invalid', reason: 'Send one research command on one line, without quoted examples or additional lines.' };
  if (/^research[ \t]+help$/i.test(command)) return { type: 'help' };
  const match = /^(?:search|research):[ \t]+(.+)$/i.exec(command);
  const query = match?.[1]?.trim();
  if (!query || query.length > 300 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(query)) {
    return { type: 'invalid', reason: 'Use search: <public query> with 1-300 plain-text characters.' };
  }
  return { type: 'search', query };
}

const ENDPOINT = 'https://api.tavily.com/search';
const MAX_BYTES = 128 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only public-looking HTTPS domain links are emitted. No result URL is fetched. */
export function safeResearchUrl(value: string): string | null {
  if (!value || value.length > 500 || /[\s\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !host.includes('.') || /[:\[\]]/.test(host) || /^[0-9.]+$/.test(host)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|home|lan|corp)$/.test(host)
      || host === 'localtest.me' || host.endsWith('.localtest.me') || host === 'lvh.me' || host.endsWith('.lvh.me')) return null;
    return url.href.length <= 500 ? url.href : null;
  } catch { return null; }
}

function plainSnippet(value: string, length: number): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
}

function parseResults(value: unknown): ResearchResult[] {
  if (!object(value) || !Array.isArray(value.results) || value.results.length > 5) throw new ModelCallError('research_response_invalid', true);
  const results: ResearchResult[] = [];
  const seen = new Set<string>();
  for (const item of value.results) {
    if (!object(item) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 1000
      || typeof item.url !== 'string' || typeof item.content !== 'string' || item.content.length > 30_000) {
      throw new ModelCallError('research_response_invalid', true);
    }
    const url = safeResearchUrl(item.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({ title: plainSnippet(item.title, 100), url, snippet: plainSnippet(item.content, 160) });
  }
  return results;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('aborted'));
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) { cleanup(); abort(); }
  });
}

async function limitedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && /^[0-9]+$/.test(length) && Number(length) > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new ModelCallError('research_response_too_large', true);
  }
  if (!response.body) throw new ModelCallError('research_response_invalid', true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let finished = false;
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('aborted');
      const chunk = await abortable(reader.read(), signal);
      if (signal.aborted) throw new Error('aborted');
      if (chunk.done) { finished = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw new ModelCallError('research_response_too_large', true);
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
    catch { throw new ModelCallError('research_response_invalid', true); }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

export interface TavilySearchOptions { apiKey: string; timeoutMs?: number; fetchImpl?: typeof fetch }

/** Official POST /search contract reviewed 2026-10-30. No SDK retries or followups. */
export class TavilySearchProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(private readonly options: TavilySearchOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!options.apiKey || /\s/.test(options.apiKey) || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 10_000) {
      throw new ModelCallError('research_config_invalid');
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(query: string, upstream?: AbortSignal): Promise<ResearchResult[]> {
    if (!query.trim() || query.length > 300 || /[\x00-\x1f\x7f-\x9f]/.test(query)) throw new ModelCallError('research_query_invalid');
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    upstream?.addEventListener('abort', abort, { once: true });
    if (upstream?.aborted) controller.abort();
    let timedOut = false;
    let started = false;
    const deadline = Date.now() + this.timeoutMs;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const active = (): void => {
      if (Date.now() >= deadline) { timedOut = true; controller.abort(); }
      if (controller.signal.aborted) throw new Error('aborted');
    };
    try {
      active();
      started = true;
      const response = await abortable(this.fetchImpl(ENDPOINT, { method: 'POST', redirect: 'manual',
        headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        signal: controller.signal, body: JSON.stringify({ query, topic: 'general', search_depth: 'basic', max_results: 5,
          auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false,
          include_image_descriptions: false, include_favicon: false }) }), controller.signal);
      active();
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        // A redirected POST may already have been processed. Never follow it or release its charge hold.
        const uncertain = (response.status >= 300 && response.status < 400) || response.status >= 500 || response.status === 429 || response.status === 408;
        throw new ModelCallError(response.status === 401 || response.status === 403 ? 'research_auth_failed'
          : response.status === 429 ? 'research_rate_limited' : response.status >= 500 ? 'research_unavailable' : 'research_request_rejected', uncertain);
      }
      const value = await limitedJson(response, controller.signal);
      active();
      return parseResults(value);
    } catch (error) {
      if (controller.signal.aborted) throw new ModelCallError(timedOut ? 'research_timeout' : 'research_aborted', started);
      if (error instanceof ModelCallError) throw error;
      throw new ModelCallError('research_network_error', started);
    } finally {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', abort);
    }
  }
}

export function formatResearchResults(results: ResearchResult[]): string {
  if (!results.length) return 'The search returned no usable public HTTPS source links. No result pages were opened.';
  const text = 'Web results (source snippets, not verified facts):\n' + results.map((result, index) =>
    `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`).join('\n\n');
  if (text.length > 4000) throw new ModelCallError('research_response_too_large', true);
  return text;
}
