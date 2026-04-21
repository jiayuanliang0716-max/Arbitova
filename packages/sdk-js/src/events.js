// Arbitova — SSE event stream client.
// Consumes the /events?address=0x... endpoint and yields typed events.
//
// Usage:
//   import { subscribeEvents } from '@arbitova/sdk/events';
//   const unsub = subscribeEvents({ address: '0x...', onEvent: (ev) => console.log(ev) });

export function subscribeEvents({
  address,
  baseUrl = 'https://arbitova.com',
  fromBlock = null,
  onEvent,
  onOpen,
  onError,
  fetchImpl,
}) {
  if (!address) throw new Error('address is required');
  if (!onEvent) throw new Error('onEvent callback is required');

  const url = new URL('/events', baseUrl);
  url.searchParams.set('address', address);
  if (fromBlock) url.searchParams.set('fromBlock', String(fromBlock));

  const isBrowser = typeof window !== 'undefined' && typeof window.EventSource !== 'undefined';
  if (isBrowser) {
    const es = new window.EventSource(url.toString());
    es.onopen = () => onOpen && onOpen();
    es.onmessage = (e) => {
      try { onEvent(JSON.parse(e.data)); }
      catch (err) { onError && onError(err); }
    };
    es.onerror = (err) => onError && onError(err);
    return () => es.close();
  }

  // Node fallback — manual SSE parsing over fetch streams.
  const controller = new AbortController();
  const _fetch = fetchImpl || globalThis.fetch;
  if (!_fetch) throw new Error('No fetch implementation available. Pass fetchImpl or run on Node 18+.');

  (async () => {
    try {
      const res = await _fetch(url.toString(), {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`SSE stream failed: ${res.status}`);
      if (onOpen) onOpen();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ')) {
              try { onEvent(JSON.parse(line.slice(6))); }
              catch (err) { onError && onError(err); }
            }
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') onError && onError(err);
    }
  })();

  return () => controller.abort();
}
