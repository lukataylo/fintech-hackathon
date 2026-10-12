// Shared helpers for the portal pages.
window.FH = (() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = v => { try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };

  async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(path, {
      method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    if (!res.ok) { const e = new Error(data?.error || `Request failed (${res.status})`); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
    el.textContent = msg; el.classList.toggle('err', isError); el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // YouTube / Loom / Vimeo / Google Drive links -> embeddable player URL.
  function embedUrl(raw) {
    let u; try { u = new URL(raw); } catch { return null; }
    const host = u.hostname.replace(/^www\.|^m\./, '');
    let id;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host.endsWith('youtube.com')) id = u.searchParams.get('v') || (u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]+)/) || [])[1];
    if (id) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0&modestbranding=1`;
    if (host.endsWith('loom.com')) { const m = u.pathname.match(/\/(?:share|embed)\/([\w-]+)/); if (m) return `https://www.loom.com/embed/${m[1]}?hide_owner=true&hide_share=true&hideEmbedTopBar=true`; }
    if (host === 'vimeo.com') { const m = u.pathname.match(/\/(\d+)/); if (m) return `https://player.vimeo.com/video/${m[1]}`; }
    if (host === 'drive.google.com') { const m = u.pathname.match(/\/file\/d\/([\w-]+)/); if (m) return `https://drive.google.com/file/d/${m[1]}/preview`; }
    return null;
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  return { esc, safeUrl, api, toast, embedUrl, store };
})();
