import { validateBundle } from '../shared/bundle-contract.mjs';

/** A failed fetch, validation or application never commits the new version. */
export function createBundleLoader({ fetch: fetcher = globalThis.fetch, onBundle, onWebChange = () => {}, onError = () => {}, timeoutMs = 10000 }) {
  let busy = false, version = null, webVersion = null, loaded = false;
  const request = async (url, format) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(`${url}?ts=${Date.now()}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return await response[format]();
    } finally { clearTimeout(timer); }
  };
  return {
    async poll() {
      if (busy) return;
      busy = true;
      try {
        const web = await request('/web/meta', 'text');
        if (webVersion !== null && web !== webVersion) { onWebChange(); return; }
        webVersion = web;
        const nextVersion = await request('/data/bundle.meta', 'text');
        if (loaded && nextVersion === version) return;
        const bundle = validateBundle(await request('/data/bundle.json', 'json'));
        if (nextVersion !== await request('/data/bundle.meta', 'text')) throw new Error('Bundle changed during download; retrying');
        await onBundle(bundle, { initial: !loaded });
        version = nextVersion;
        loaded = true;
      } catch (error) { onError(error, { initial: !loaded }); }
      finally { busy = false; }
    },
  };
}
