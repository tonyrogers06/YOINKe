/**
 * VideoGrabber — HLS & DASH Manifest Parser
 * Lightweight, zero-dependency parser for HLS (.m3u8) and DASH (.mpd) manifests.
 */

/**
 * Parse an HLS manifest text.
 * @param {string} text - Raw manifest content
 * @param {string} baseUrl - Base URL of the manifest for resolving relative URLs
 * @returns {{ isMaster: boolean, variants: Array, audioGroups: Array, segments: Array }}
 */
function parseHLSManifest(text, baseUrl) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const variants = [];
  const audioGroups = [];
  const segments = [];
  let currentStreamInfo = null;
  let isMaster = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      isMaster = true;
      const res = /RESOLUTION=(\d+x\d+)/i.exec(line)?.[1] || null;
      const bw  = /BANDWIDTH=(\d+)/i.exec(line)?.[1] || '0';
      const fps = /FRAME-RATE=([\d.]+)/i.exec(line)?.[1] || null;
      const codecs = /CODECS="([^"]+)"/i.exec(line)?.[1] || null;
      const audioGroup = /AUDIO="([^"]+)"/i.exec(line)?.[1] || null;
      currentStreamInfo = {
        res,
        bw: parseInt(bw),
        fps: fps ? parseFloat(fps) : null,
        codecs,
        audioGroup,
        label: res
          ? `${res}${fps ? ' @' + Math.round(parseFloat(fps)) + 'fps' : ''} (${Math.round(parseInt(bw)/1000)}k)`
          : `${Math.round(parseInt(bw)/1000)}k`
      };
    } else if (currentStreamInfo && !line.startsWith('#')) {
      variants.push({ ...currentStreamInfo, url: resolveUrl(line, baseUrl) });
      currentStreamInfo = null;
    } else if (line.startsWith('#EXT-X-MEDIA') && /TYPE=["']?AUDIO/i.test(line)) {
      const lang    = /LANGUAGE="([^"]+)"/i.exec(line)?.[1] || 'und';
      const name    = /NAME="([^"]+)"/i.exec(line)?.[1]     || lang;
      const id      = /GROUP-ID="([^"]+)"/i.exec(line)?.[1] || 'audio';
      const isDefault = /DEFAULT=YES/i.test(line);
      const uri     = /URI="([^"]+)"/i.exec(line)?.[1] || null;
      const filterExpr = (lang && lang !== 'und') ? `lang=${lang}` : `name=${name}`;
      // Avoid duplicate language+name entries
      if (!audioGroups.some(ag => ag.lang === lang && ag.name === name && ag.id === id)) {
        audioGroups.push({ id, lang, name, filterExpr, isDefault, url: uri ? resolveUrl(uri, baseUrl) : null });
      }
    } else if (!line.startsWith('#') && !isMaster) {
      // Media playlist: collect segments
      segments.push(resolveUrl(line, baseUrl));
    }
  }

  // Sort variants: best quality first
  variants.sort((a, b) => b.bw - a.bw);

  return { isMaster: variants.length > 0, variants, audioGroups, segments };
}

/**
 * Parse a DASH .mpd manifest XML text.
 * @param {string} text - Raw MPD XML content
 * @param {string} baseUrl - Base URL for resolving relative URLs
 * @returns {{ variants: Array, audioGroups: Array }}
 */
function parseDASHManifest(text, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');
  const variants = [];
  const audioGroups = [];

  const getDirectBase = (el, inherited) => {
    const child = Array.from(el.children || []).find(c => c.tagName === 'BaseURL');
    return child ? resolveUrl(child.textContent.trim(), inherited) : inherited;
  };

  const mpdEl = doc.documentElement;
  const mpdBase = mpdEl ? getDirectBase(mpdEl, baseUrl) : baseUrl;

  const periods = mpdEl ? Array.from(mpdEl.children).filter(c => c.tagName === 'Period') : [];
  const periodList = periods.length ? periods : [mpdEl].filter(Boolean);

  periodList.forEach(period => {
    const periodBase = period === mpdEl ? mpdBase : getDirectBase(period, mpdBase);
    const adaptationSets = Array.from(period.children || []).filter(c => c.tagName === 'AdaptationSet');

    adaptationSets.forEach(as => {
      const asBase = getDirectBase(as, periodBase);
      const contentType = as.getAttribute('contentType') ||
        (as.getAttribute('mimeType') || '').split('/')[0];
      const lang = as.getAttribute('lang') || 'und';

      const reps = Array.from(as.children || []).filter(c => c.tagName === 'Representation');
      reps.forEach(rep => {
        const id       = rep.getAttribute('id') || '';
        const bw       = parseInt(rep.getAttribute('bandwidth') || '0');
        const width    = rep.getAttribute('width');
        const height   = rep.getAttribute('height');
        const mimeType = rep.getAttribute('mimeType') || as.getAttribute('mimeType') || '';
        const codecs   = rep.getAttribute('codecs') || '';

        const repBaseUrl = getDirectBase(rep, asBase);

        if (contentType === 'video' || mimeType.startsWith('video')) {
          const res = (width && height) ? `${width}x${height}` : null;
          variants.push({
            id,
            bw,
            res,
            codecs,
            mimeType,
            url: repBaseUrl,
            label: res
              ? `${res} (${Math.round(bw/1000)}k)`
              : `${Math.round(bw/1000)}k`
          });
        } else if (contentType === 'audio' || mimeType.startsWith('audio')) {
          const repLang = rep.getAttribute('lang') || lang || 'und';
          const labelEl = as.querySelector('Label') || rep.querySelector('Label');
          const name = labelEl?.textContent?.trim() || (repLang !== 'und' ? repLang.toUpperCase() : `Track ${audioGroups.length + 1}`);
          const filterExpr = (repLang && repLang !== 'und') ? `lang=${repLang}` : `name=${name}`;
          if (!audioGroups.some(ag => ag.lang === repLang && ag.name === name)) {
            audioGroups.push({ id, lang: repLang, name, filterExpr, url: repBaseUrl });
          }
        }
      });
    });
  });

  variants.sort((a, b) => b.bw - a.bw);
  return { variants, audioGroups };
}

/**
 * Resolve a potentially relative URL against a base URL.
 */
function resolveUrl(url, base) {
  if (!url) return base;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

// Export for use in popup.js via importScripts or script tag
if (typeof module !== 'undefined') {
  module.exports = { parseHLSManifest, parseDASHManifest, resolveUrl };
}
