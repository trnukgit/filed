import { useState, useEffect, useMemo, useRef, useCallback } from 'react';

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

if (!window.storage) {
  window.storage = {
    get: async (key) => {
      const { data } = await supabase.from('entries').select('value').eq('key', key).single()
      return data ? { value: JSON.stringify(data.value) } : null
    },
    set: async (key, value) => {
      await supabase.from('entries').upsert({ key, value: JSON.parse(value) })
    },
    delete: async (key) => {
      await supabase.from('entries').delete().eq('key', key)
    },
    list: async (prefix) => {
      const { data } = await supabase.from('entries').select('key').ilike('key', `${prefix}%`)
      return { keys: data ? data.map(d => d.key) : [] }
    }
  }
}

const MONTH_COLORS = ['#88C0D0', '#D08770', '#A3BE8C'];
const MAX_MEDIA_BYTES = 4 * 1024 * 1024;

function pad2(n) { return String(n).padStart(2, '0'); }

function toLocalDateTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromLocalDateTime(s) {
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? Date.now() : t;
}

function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatBytes(b) {
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + 'KB';
  return (b / (1024 * 1024)).toFixed(1) + 'MB';
}

function dataURLSize(dataURL) {
  const base64 = (dataURL.split(',')[1] || '');
  return Math.ceil(base64.length * 0.75);
}

// Language detection: /en path = English locked view
// Base URL from Vite (e.g. '/' in dev, '/filed/' on GitHub Pages)
const BASE_URL = (import.meta.env?.BASE_URL || '/').replace(/\/+$/, '/');

// Language detection: pathname ends with /en (with optional trailing slash)
// Works regardless of whether the app is served from / or /filed/
const IS_EN = typeof window !== 'undefined' && (() => {
  const path = window.location.pathname.replace(/\/+$/, '');
  return path.endsWith('/en');
})();

// URL builder: returns '/en/' or '/filed/en/' depending on BASE_URL
const enUrl = `${BASE_URL}en/`;

// UI strings per locale
const STRINGS = {
  ja: {
    entry: 'entry',
    entries: 'entries',
    translatePending: '// (translation pending)',
    translateAll: 'translate pending',
    translating: 'translating',
  },
  en: {
    entry: 'entry',
    entries: 'entries',
    translatePending: '// (translation pending)',
    translateAll: 'translate pending',
    translating: 'translating',
  },
};
const T = IS_EN ? STRINGS.en : STRINGS.ja;

const API_KEY_STORAGE = 'filed_anthropic_api_key';

async function translateToEnglish(text) {
  if (!text || !text.trim()) return '';
  const key = localStorage.getItem(API_KEY_STORAGE);
  if (!key) throw new Error('NO_API_KEY');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Translate the following Japanese journal entry to natural, fluent English. Preserve the tone exactly — including any informal, fragmentary, thinking-aloud, or unfinished quality. Do not smooth out incomplete thoughts. Do not add commentary, headings, or explanation. Output ONLY the translation, nothing else.\n\n---\n${text}`,
      }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const out = data?.content?.[0]?.text;
  if (!out) throw new Error('Empty response');
  return out.trim();
}

async function translateToJapanese(text) {
  if (!text || !text.trim()) return '';
  const key = localStorage.getItem(API_KEY_STORAGE);
  if (!key) throw new Error('NO_API_KEY');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Translate the following English journal entry to natural, casual Japanese (use 普通体, not 丁寧体). Preserve the tone exactly — including any informal, fragmentary, thinking-aloud, or unfinished quality. Do not smooth out incomplete thoughts. Do not add commentary, headings, or explanation. Output ONLY the translation, nothing else.\n\n---\n${text}`,
      }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const out = data?.content?.[0]?.text;
  if (!out) throw new Error('Empty response');
  return out.trim();
}

// Field mapping based on current locale
const PRIMARY = IS_EN ? 'textEn' : 'text';
const SECONDARY = IS_EN ? 'text' : 'textEn';
const TRANSLATE_FN = IS_EN ? translateToJapanese : translateToEnglish;

async function compressImage(file, maxDim = 1280, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * (maxDim / w)); w = maxDim; }
          else { w = Math.round(w * (maxDim / h)); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 3D projection: orbit camera, perspective
function project3D(x, y, z, theta, phi) {
  const cx = x - 0.5;
  const cy = y - 0.5;
  const cz = z - 0.5;

  const cosT = Math.cos(theta), sinT = Math.sin(theta);
  const x1 = cx * cosT - cz * sinT;
  const z1 = cx * sinT + cz * cosT;
  const y1 = cy;

  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const y2 = y1 * cosP - z1 * sinP;
  const z2 = y1 * sinP + z1 * cosP;
  const x2 = x1;

  const distance = 3;
  const factor = distance / (distance + z2);
  return { x: x2 * factor, y: -y2 * factor, z: z2, factor };
}

export default function FiledRecorder() {
  const [entries, setEntries] = useState([]);
  const [draft, setDraft] = useState('');
  const [customDateTime, setCustomDateTime] = useState(toLocalDateTime(Date.now()));
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [mediaCache, setMediaCache] = useState({});

  const [selectedEntry, setSelectedEntry] = useState(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recentId, setRecentId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Edit mode state
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editDateTime, setEditDateTime] = useState('');
  const [editAttachments, setEditAttachments] = useState([]);
  const [editSaving, setEditSaving] = useState(false);

  // Translation state
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [translatingIds, setTranslatingIds] = useState(new Set());
  const [bulkTranslating, setBulkTranslating] = useState(false);

  const [theta, setTheta] = useState(-0.55);
  const [phi, setPhi] = useState(0.35);
  const [containerWidth, setContainerWidth] = useState(720);
  const [isDragging, setIsDragging] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const imageInputRef = useRef(null);
  const audioInputRef = useRef(null);

  // Detect mobile
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 640);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Load JetBrains Mono
  useEffect(() => {
    const link = document.createElement('link');
    link.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,600;1,400&display=swap';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
    return () => { try { document.head.removeChild(link); } catch (e) { } };
  }, []);

  // Inject styles
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      html, body {
        margin: 0;
        padding: 0;
        background-color: #0E0E10;
        overflow-x: hidden;
      }
      #root {
        margin: 0;
        padding: 0;
        border: none;
      }
      @keyframes pointAppear {
        0% { opacity: 0; transform: scale(0); }
        60% { opacity: 1; transform: scale(2); }
        100% { opacity: 1; transform: scale(1); }
      }
      @keyframes blink {
        0%, 49% { opacity: 1; }
        50%, 100% { opacity: 0; }
      }
      .filed-point.recent { animation: pointAppear 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards; transform-origin: center; transform-box: fill-box; }
      .filed-cursor { animation: blink 1.1s steps(1) infinite; }
      .filed-input::placeholder { color: #555248; font-style: normal; }
      .filed-input { caret-color: #88C0D0; }
      input[type="datetime-local"].filed-dt {
        color-scheme: dark;
        background: transparent;
        border: 0.5px solid #2A2A2E;
        color: #D8D5CB;
        font-family: "JetBrains Mono", monospace;
        font-size: 12px;
        padding: 6px 10px;
        outline: none;
        min-width: 0;
      }
      input[type="datetime-local"].filed-dt:focus { border-color: #88C0D0; }
      input[type="datetime-local"].filed-dt::-webkit-calendar-picker-indicator {
        filter: invert(0.7); opacity: 0.5; cursor: pointer;
      }
      .filed-btn { transition: all 0.15s; }
      .filed-btn:hover:not(:disabled) { background: #88C0D0 !important; color: #0E0E10 !important; border-color: #88C0D0 !important; }
      .filed-btn-ghost:hover { color: #D8D5CB !important; border-color: #555248 !important; }
      .filed-scrollbar::-webkit-scrollbar { width: 6px; }
      .filed-scrollbar::-webkit-scrollbar-track { background: transparent; }
      .filed-scrollbar::-webkit-scrollbar-thumb { background: #2A2A2E; border-radius: 0; }
      audio.filed-audio {
        width: 100%;
        height: 32px;
        filter: invert(0.85) hue-rotate(180deg) saturate(0.7);
      }
      audio.filed-audio-sm { width: 180px; height: 28px; }
      @media (hover: none) {
        .filed-hover-preview { display: none !important; }
      }
      @media (max-width: 640px) {
        .filed-root { padding: 18px 12px 60px !important; }
        .filed-header { gap: 6px !important; }
        .filed-header-title { gap: 8px !important; flex-wrap: wrap !important; }
        .filed-header-meta { width: 100% !important; justify-content: space-between !important; }
        .filed-meta-bar { flex-direction: column; align-items: flex-start !important; gap: 4px !important; }
        .filed-composer-meta { gap: 6px !important; }
        .filed-composer-meta input.filed-dt { flex: 1 1 140px; min-width: 0; }
        .filed-modal { padding: 18px 18px !important; max-height: 88vh !important; }
        .filed-overlay { padding: 10px !important; }
        .filed-prompt-prefix { display: none !important; }
        .filed-textarea-wrap { padding-left: 0 !important; }
        .filed-composer-foot { padding-left: 0 !important; }
      }
    `;
    document.head.appendChild(style);
    return () => { try { document.head.removeChild(style); } catch (e) { } };
  }, []);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      if (containerRef.current) setContainerWidth(containerRef.current.offsetWidth);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Load entries
  useEffect(() => {
    async function load() {
      try {
        const result = await window.storage.list('entry:');
        if (result?.keys?.length) {
          const loaded = await Promise.all(
            result.keys.map(async (key) => {
              try {
                const r = await window.storage.get(key);
                return r ? JSON.parse(r.value) : null;
              } catch { return null; }
            })
          );
          const valid = loaded.filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
          setEntries(valid);
        }
      } catch (e) { console.error('Load failed', e); }
      finally { setLoading(false); }
    }
    load();
  }, []);

  // Load media when entry is selected
  useEffect(() => {
    if (!selectedEntry?.attachments?.length) return;
    selectedEntry.attachments.forEach(async (att) => {
      if (mediaCache[att.mediaKey] !== undefined) return;
      try {
        const r = await window.storage.get(att.mediaKey);
        if (r) {
          const parsed = JSON.parse(r.value);
          setMediaCache((prev) => ({ ...prev, [att.mediaKey]: parsed.data }));
        } else {
          setMediaCache((prev) => ({ ...prev, [att.mediaKey]: null }));
        }
      } catch (e) {
        console.error('Media load failed', e);
        setMediaCache((prev) => ({ ...prev, [att.mediaKey]: null }));
      }
    });
  }, [selectedEntry]);

  async function handleImageSelect(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    try {
      const dataURL = await compressImage(file);
      const size = dataURLSize(dataURL);
      if (size > MAX_MEDIA_BYTES) {
        alert(`error: image still too large after compression (${formatBytes(size)})`);
        return;
      }
      setPendingAttachments((prev) => [
        ...prev,
        {
          id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'image',
          name: file.name,
          dataURL,
          size,
        },
      ]);
    } catch (err) {
      console.error(err);
      alert('error: failed to read image');
    }
  }

  async function handleAudioSelect(e) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file) return;
    try {
      const dataURL = await fileToDataURL(file);
      const size = dataURLSize(dataURL);
      if (size > MAX_MEDIA_BYTES) {
        alert(`error: audio file too large (${formatBytes(size)} > ${formatBytes(MAX_MEDIA_BYTES)} limit)`);
        return;
      }
      setPendingAttachments((prev) => [
        ...prev,
        {
          id: `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'audio',
          name: file.name,
          dataURL,
          size,
        },
      ]);
    } catch (err) {
      console.error(err);
      alert('error: failed to read audio');
    }
  }

  function removePendingAttachment(id) {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function save() {
    const text = draft.trim();
    if ((!text && pendingAttachments.length === 0) || saving) return;
    setSaving(true);
    const ms = fromLocalDateTime(customDateTime);
    const id = `entry:${ms}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const attachments = [];
      for (const att of pendingAttachments) {
        const mediaKey = `media:${ms}-${Math.random().toString(36).slice(2, 8)}`;
        await window.storage.set(
          mediaKey,
          JSON.stringify({ data: att.dataURL, type: att.type, name: att.name })
        );
        attachments.push({
          type: att.type,
          name: att.name,
          mediaKey,
          size: att.size,
        });
        // Cache it for instant view
        setMediaCache((prev) => ({ ...prev, [mediaKey]: att.dataURL }));
      }

      const entry = {
        id,
        [PRIMARY]: text,
        [SECONDARY]: '',
        createdAt: ms,
        attachments,
      };
      await window.storage.set(id, JSON.stringify(entry));

      setEntries((prev) => [...prev, entry].sort((a, b) => a.createdAt - b.createdAt));
      setDraft('');
      setPendingAttachments([]);
      setCustomDateTime(toLocalDateTime(Date.now()));
      setRecentId(id);
      setTimeout(() => setRecentId(null), 2000);

      // Background translation (fire and forget)
      if (text) translateAndSave(entry);
    } catch (e) {
      console.error('Save failed', e);
      alert('error: save failed. try again.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteEntry(id) {
    const entry = entries.find((e) => e.id === id);
    try {
      if (entry?.attachments?.length) {
        for (const att of entry.attachments) {
          try {
            await window.storage.delete(att.mediaKey);
          } catch (e) { }
        }
      }
      await window.storage.delete(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      setSelectedEntry(null);
      setConfirmDelete(false);
      setEditing(false);
    } catch (e) { console.error('Delete failed', e); }
  }

  // Initialize API key state
  useEffect(() => {
    const stored = localStorage.getItem(API_KEY_STORAGE) || '';
    setHasApiKey(stored.length > 0);
    setApiKeyInput(stored);
  }, []);

  // Background translation: PRIMARY -> SECONDARY
  // Race condition guard: re-fetch entry just before writing,
  // so we don't clobber any edits the user made while translation was in flight.
  async function translateAndSave(entry) {
    const primaryText = entry[PRIMARY];
    if (!primaryText?.trim()) return;
    if (!localStorage.getItem(API_KEY_STORAGE)) return;
    setTranslatingIds((prev) => new Set(prev).add(entry.id));
    try {
      const translated = await TRANSLATE_FN(primaryText);

      // Re-fetch the latest version of the entry from storage.
      // The user may have edited it (changed date, attachments, etc.)
      // while we were waiting on the translation API.
      let latest;
      try {
        const r = await window.storage.get(entry.id);
        latest = r ? JSON.parse(r.value) : null;
      } catch {
        latest = null;
      }

      // If the entry was deleted while translating, abort.
      if (!latest) return;

      // If the user changed the primary text in the meantime,
      // this translation is stale — don't write it.
      if ((latest[PRIMARY] || '') !== primaryText) return;

      const updated = { ...latest, [SECONDARY]: translated };
      await window.storage.set(entry.id, JSON.stringify(updated));
      setEntries((prev) =>
        prev.map((e) => (e.id === entry.id ? updated : e)).sort((a, b) => a.createdAt - b.createdAt)
      );
      setSelectedEntry((prev) => (prev?.id === entry.id ? updated : prev));
    } catch (e) {
      console.error('Translation failed for', entry.id, e);
    } finally {
      setTranslatingIds((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    }
  }

  async function translateAllPending() {
    if (bulkTranslating) return;
    if (!localStorage.getItem(API_KEY_STORAGE)) {
      setShowSettings(true);
      return;
    }
    const pending = entries.filter((e) => e[PRIMARY]?.trim() && !e[SECONDARY]);
    if (pending.length === 0) return;
    setBulkTranslating(true);
    for (const entry of pending) {
      await translateAndSave(entry);
    }
    setBulkTranslating(false);
  }

  function saveApiKey() {
    const trimmed = apiKeyInput.trim();
    if (trimmed) {
      localStorage.setItem(API_KEY_STORAGE, trimmed);
      setHasApiKey(true);
    } else {
      localStorage.removeItem(API_KEY_STORAGE);
      setHasApiKey(false);
    }
    setShowSettings(false);
  }

  function startEdit() {
    if (!selectedEntry) return;
    setEditText(selectedEntry[PRIMARY] || '');
    setEditDateTime(toLocalDateTime(selectedEntry.createdAt));
    setEditAttachments(selectedEntry.attachments ? [...selectedEntry.attachments] : []);
    setEditing(true);
    setConfirmDelete(false);
  }

  function cancelEdit() {
    setEditing(false);
    setEditText('');
    setEditDateTime('');
    setEditAttachments([]);
  }

  function removeEditAttachment(mediaKey) {
    setEditAttachments((prev) => prev.filter((a) => a.mediaKey !== mediaKey));
  }

  async function saveEdit() {
    if (!selectedEntry || editSaving) return;
    const text = editText.trim();
    if (!text && editAttachments.length === 0) {
      alert('error: entry cannot be empty');
      return;
    }
    setEditSaving(true);
    try {
      const newCreatedAt = fromLocalDateTime(editDateTime);
      const original = selectedEntry;

      const removedKeys = (original.attachments || [])
        .map((a) => a.mediaKey)
        .filter((k) => !editAttachments.some((a) => a.mediaKey === k));

      for (const key of removedKeys) {
        try { await window.storage.delete(key); } catch (e) { }
      }

      const oldPrimary = original[PRIMARY] || '';
      const textChanged = text !== oldPrimary;

      const updated = {
        ...original,
        [PRIMARY]: text,
        [SECONDARY]: textChanged ? '' : (original[SECONDARY] || ''),
        createdAt: newCreatedAt,
        attachments: editAttachments,
      };

      await window.storage.set(original.id, JSON.stringify(updated));

      setEntries((prev) =>
        prev.map((e) => (e.id === original.id ? updated : e)).sort((a, b) => a.createdAt - b.createdAt)
      );
      setSelectedEntry(updated);
      setEditing(false);

      if (textChanged && text) translateAndSave(updated);
    } catch (e) {
      console.error('Edit failed', e);
      alert('error: edit save failed.');
    } finally {
      setEditSaving(false);
    }
  }

  function closeModal() {
    if (editing) {
      const dirty =
        editText !== (selectedEntry?.[PRIMARY] || '') ||
        editDateTime !== toLocalDateTime(selectedEntry?.createdAt || 0) ||
        editAttachments.length !== (selectedEntry?.attachments?.length || 0);
      if (dirty && !window.confirm('discard unsaved changes?')) return;
    }
    setSelectedEntry(null);
    setConfirmDelete(false);
    setEditing(false);
  }

  function exportAll() {
    if (entries.length === 0) return;
    const md = entries
      .map((e) => {
        let s = `## ${formatDate(e.createdAt)}\n\n`;
        const body = e[PRIMARY] || '';
        if (body) s += `${body}\n\n`;
        if (e.attachments?.length) {
          for (const a of e.attachments) {
            s += `[${a.type}: ${a.name} · ${formatBytes(a.size || 0)}]\n`;
          }
          s += '\n';
        }
        return s;
      })
      .join('---\n\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `filed-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function resetDateTime() {
    setCustomDateTime(toLocalDateTime(Date.now()));
  }

  // Drag rotation
  const startDrag = useCallback((e) => {
    const pt = e.touches ? e.touches[0] : e;
    dragRef.current = {
      startX: pt.clientX,
      startY: pt.clientY,
      startTheta: theta,
      startPhi: phi,
      moved: false,
    };
    setIsDragging(true);
  }, [theta, phi]);

  const moveDrag = useCallback((e) => {
    if (!dragRef.current) return;
    const pt = e.touches ? e.touches[0] : e;
    const dx = pt.clientX - dragRef.current.startX;
    const dy = pt.clientY - dragRef.current.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragRef.current.moved = true;
    setTheta(dragRef.current.startTheta + dx * 0.008);
    setPhi(Math.max(-1.3, Math.min(1.3, dragRef.current.startPhi + dy * 0.008)));
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  useEffect(() => {
    const onMove = (e) => moveDrag(e);
    const onUp = () => endDrag();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove);
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [moveDrag, endDrag]);

  function resetView() {
    setTheta(-0.55);
    setPhi(0.35);
  }

  // Plot data
  const plotData = useMemo(() => {
    const SVG_H = isMobile ? 320 : 380;
    const cx = containerWidth / 2;
    const cy = SVG_H / 2;
    const scale = Math.min(containerWidth, SVG_H) * 0.32;

    if (entries.length === 0) {
      return { points: [], cx, cy, scale, height: SVG_H, totalDays: 1, startMs: Date.now(), minLen: 0, maxLen: 0 };
    }

    const firstDay = new Date(entries[0].createdAt);
    firstDay.setHours(0, 0, 0, 0);
    const startMs = firstDay.getTime();

    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const endMs = Math.max(today.getTime(), entries[entries.length - 1].createdAt);
    const totalDays = Math.max(Math.ceil((endMs - startMs) / 86400000), 7);

    const lengths = entries.map((e) => (e[PRIMARY] || '').length);
    const minLen = Math.min(...lengths);
    const maxLen = Math.max(...lengths);
    const lenRange = maxLen - minLen;

    const points = entries.map((e) => {
      const d = new Date(e.createdAt);
      const dayIdx = (d.getTime() - startMs) / 86400000;
      const hour = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
      const xN = totalDays > 1 ? dayIdx / totalDays : 0.5;
      const yN = 1 - hour / 24;
      const zN = lenRange > 0 ? ((e[PRIMARY] || '').length - minLen) / lenRange : 0.5;
      const monthIdx = Math.min(Math.floor(dayIdx / 30), 2);

      const proj = project3D(xN, yN, zN, theta, phi);
      return {
        ...e,
        xN, yN, zN,
        monthIdx,
        sx: cx + proj.x * scale,
        sy: cy + proj.y * scale,
        z: proj.z,
        factor: proj.factor,
      };
    });

    points.sort((a, b) => a.z - b.z);

    return { points, cx, cy, scale, height: SVG_H, totalDays, startMs, minLen, maxLen };
  }, [entries, theta, phi, containerWidth, isMobile]);

  // Cube vertices for wireframe
  const cubeProj = useMemo(() => {
    const corners = [
      [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
      [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
    ];
    return corners.map(([x, y, z]) => {
      const p = project3D(x, y, z, theta, phi);
      return {
        x: plotData.cx + p.x * plotData.scale,
        y: plotData.cy + p.y * plotData.scale,
        z: p.z,
      };
    });
  }, [theta, phi, plotData.cx, plotData.cy, plotData.scale]);

  const cubeEdges = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];

  const hoveredEntry = hoveredId ? entries.find((e) => e.id === hoveredId) : null;

  // Tick mark positions
  const xTicks = useMemo(() => {
    const ticks = [];
    [0, 30, 60, 90].forEach((day) => {
      if (day > plotData.totalDays) return;
      const xN = day / plotData.totalDays;
      const p = project3D(xN, 0, 0, theta, phi);
      const labelDate = new Date(plotData.startMs + day * 86400000);
      ticks.push({
        x: plotData.cx + p.x * plotData.scale,
        y: plotData.cy + p.y * plotData.scale,
        label: `${pad2(labelDate.getMonth() + 1)}.${pad2(labelDate.getDate())}`,
      });
    });
    return ticks;
  }, [theta, phi, plotData.totalDays, plotData.startMs, plotData.cx, plotData.cy, plotData.scale]);

  const yTicks = useMemo(() => {
    return [0, 6, 12, 18, 24].map((h) => {
      const yN = 1 - h / 24;
      const p = project3D(0, yN, 0, theta, phi);
      return {
        x: plotData.cx + p.x * plotData.scale,
        y: plotData.cy + p.y * plotData.scale,
        label: `${pad2(h)}h`,
      };
    });
  }, [theta, phi, plotData.cx, plotData.cy, plotData.scale]);

  const zTicks = useMemo(() => {
    if (plotData.maxLen === plotData.minLen) return [];
    const p0 = project3D(0, 0, 0, theta, phi);
    const p1 = project3D(0, 0, 1, theta, phi);
    return [
      {
        x: plotData.cx + p0.x * plotData.scale,
        y: plotData.cy + p0.y * plotData.scale,
        label: `${plotData.minLen}c`,
      },
      {
        x: plotData.cx + p1.x * plotData.scale,
        y: plotData.cy + p1.y * plotData.scale,
        label: `${plotData.maxLen}c`,
      },
    ];
  }, [theta, phi, plotData.minLen, plotData.maxLen, plotData.cx, plotData.cy, plotData.scale]);

  function attachmentSummary(entry) {
    const imgs = entry.attachments?.filter((a) => a.type === 'image').length || 0;
    const auds = entry.attachments?.filter((a) => a.type === 'audio').length || 0;
    const parts = [];
    if (imgs) parts.push(`${imgs}img`);
    if (auds) parts.push(`${auds}aud`);
    return parts.length ? ` · [${parts.join(' ')}]` : '';
  }

  return (
    <div
      className="filed-root"
      style={{
        minHeight: '100vh',
        background: '#0E0E10',
        color: '#D8D5CB',
        fontFamily: '"JetBrains Mono", monospace',
        padding: '32px 20px 80px',
        fontSize: '13px',
      }}
    >
      <div style={{ maxWidth: '860px', margin: '0 auto' }}>

        {/* Header */}
        <header
          className="filed-header"
          style={{
            marginBottom: '32px',
            borderBottom: '0.5px solid #2A2A2E',
            paddingBottom: '16px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div className="filed-header-title" style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
            <span style={{ color: '#88C0D0', fontSize: '13px' }}>$</span>
            <h1 style={{
              fontSize: '15px',
              fontWeight: 500,
              margin: 0,
              letterSpacing: '0.04em',
              color: '#D8D5CB',
            }}>
              filed
            </h1>
            <span style={{ color: '#555248', fontSize: '12px' }}>
              — a record of unweighed observations
            </span>
          </div>
          <div className="filed-header-meta" style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '11px', flexWrap: 'wrap' }}>
            <span style={{ color: '#8A877F' }}>
              [ {entries.length} {entries.length === 1 ? T.entry : T.entries} ]
            </span>
            {entries.some((e) => e[PRIMARY]?.trim() && !e[SECONDARY]) && (
              <button
                onClick={translateAllPending}
                disabled={bulkTranslating}
                className="filed-btn-ghost"
                style={{
                  background: 'transparent',
                  border: '0.5px solid',
                  borderColor: bulkTranslating ? '#2A2A2E' : '#88C0D0',
                  color: bulkTranslating ? '#555248' : '#88C0D0',
                  padding: '5px 10px',
                  fontFamily: 'inherit',
                  fontSize: '11px',
                  cursor: bulkTranslating ? 'default' : 'pointer',
                  letterSpacing: '0.04em',
                }}
              >
                {bulkTranslating ? `${T.translating}…` : T.translateAll}
              </button>
            )}
            <button
              onClick={() => setShowSettings(true)}
              className="filed-btn-ghost"
              style={{
                background: 'transparent',
                border: 'none',
                color: '#555248',
                padding: '5px 4px',
                fontFamily: 'inherit',
                fontSize: '11px',
                cursor: 'pointer',
                letterSpacing: '0.04em',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#D8D5CB'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = '#555248'; }}
            >
              [settings]
            </button>
            {!IS_EN && (
              <a
                href={enUrl}
                style={{
                  color: '#88C0D0',
                  textDecoration: 'none',
                  fontFamily: 'inherit',
                  fontSize: '11px',
                  letterSpacing: '0.04em',
                  border: '0.5px solid #2A2A2E',
                  padding: '5px 10px',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#88C0D0'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#2A2A2E'; }}
              >
                [en →]
              </a>
            )}
            {entries.length > 0 && (
              <button
                onClick={exportAll}
                className="filed-btn-ghost"
                style={{
                  background: 'transparent',
                  border: '0.5px solid #2A2A2E',
                  color: '#8A877F',
                  padding: '5px 10px',
                  fontFamily: 'inherit',
                  fontSize: '11px',
                  cursor: 'pointer',
                  letterSpacing: '0.04em',
                }}
              >
                export.md
              </button>
            )}
          </div>
        </header>

        {/* 3D Plot */}
        <section
          ref={containerRef}
          style={{
            marginBottom: '36px',
            position: 'relative',
            border: '0.5px solid #2A2A2E',
            background: '#0A0A0C',
          }}
        >
          {/* Plot meta bar */}
          <div className="filed-meta-bar" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 12px',
            borderBottom: '0.5px solid #2A2A2E',
            fontSize: '10px',
            color: '#555248',
            letterSpacing: '0.05em',
          }}>
            <span>plot.3d &nbsp;//&nbsp; x:date &nbsp; y:hour &nbsp; z:length</span>
            <button
              onClick={resetView}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#555248',
                fontFamily: 'inherit',
                fontSize: '10px',
                cursor: 'pointer',
                padding: 0,
                letterSpacing: '0.05em',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = '#D8D5CB'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = '#555248'; }}
            >
              [reset view]
            </button>
          </div>

          {loading ? (
            <div style={{
              height: plotData.height + 'px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#555248',
              fontSize: '12px',
            }}>
              loading<span className="filed-cursor">_</span>
            </div>
          ) : entries.length === 0 ? (
            <div style={{
              height: plotData.height + 'px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#555248',
              gap: '6px',
              fontSize: '12px',
              padding: '0 20px',
              textAlign: 'center',
            }}>
              <span>// empty</span>
              <span style={{ color: '#3D3B36' }}>file your first observation below</span>
            </div>
          ) : (
            <svg
              width={containerWidth}
              height={plotData.height}
              style={{
                display: 'block',
                cursor: isDragging ? 'grabbing' : 'grab',
                userSelect: 'none',
                touchAction: 'none',
              }}
              onMouseDown={startDrag}
              onTouchStart={startDrag}
            >
              {/* Cube wireframe */}
              {cubeEdges.map(([a, b], i) => {
                const pa = cubeProj[a];
                const pb = cubeProj[b];
                const avgZ = (pa.z + pb.z) / 2;
                const opacity = avgZ > 0 ? 0.18 : 0.35;
                return (
                  <line
                    key={i}
                    x1={pa.x} y1={pa.y}
                    x2={pb.x} y2={pb.y}
                    stroke="#3D3B36"
                    strokeOpacity={opacity}
                    strokeWidth="0.5"
                    strokeDasharray={avgZ > 0 ? '2,3' : '0'}
                  />
                );
              })}

              {/* Axis labels */}
              {[
                { from: 0, to: 1, label: 'date', labelOffset: { dx: 6, dy: 14 } },
                { from: 0, to: 3, label: 'hour', labelOffset: { dx: -8, dy: -4 } },
                { from: 0, to: 4, label: 'length', labelOffset: { dx: 6, dy: -4 } },
              ].map((ax, i) => {
                const pa = cubeProj[ax.from];
                const pb = cubeProj[ax.to];
                return (
                  <g key={`axis-${i}`}>
                    <line
                      x1={pa.x} y1={pa.y}
                      x2={pb.x} y2={pb.y}
                      stroke="#555248"
                      strokeWidth="1"
                      strokeOpacity="0.5"
                    />
                    <text
                      x={pb.x + ax.labelOffset.dx}
                      y={pb.y + ax.labelOffset.dy}
                      fontSize="10"
                      fill="#8A877F"
                      fontFamily='"JetBrains Mono", monospace'
                      letterSpacing="0.05em"
                    >
                      {ax.label}
                    </text>
                  </g>
                );
              })}

              {/* X tick labels */}
              {xTicks.map((t, i) => (
                <text
                  key={`xt-${i}`}
                  x={t.x}
                  y={t.y + 16}
                  fontSize="9"
                  fill="#555248"
                  textAnchor="middle"
                  fontFamily='"JetBrains Mono", monospace'
                >
                  {t.label}
                </text>
              ))}

              {/* Y tick labels */}
              {yTicks.map((t, i) => (
                <text
                  key={`yt-${i}`}
                  x={t.x - 8}
                  y={t.y + 3}
                  fontSize="9"
                  fill="#555248"
                  textAnchor="end"
                  fontFamily='"JetBrains Mono", monospace'
                >
                  {t.label}
                </text>
              ))}

              {/* Z tick labels */}
              {zTicks.map((t, i) => (
                <text
                  key={`zt-${i}`}
                  x={t.x + 8}
                  y={t.y - 4}
                  fontSize="9"
                  fill="#555248"
                  fontFamily='"JetBrains Mono", monospace'
                >
                  {t.label}
                </text>
              ))}

              {/* Points */}
              {plotData.points.map((p) => {
                const isHover = hoveredId === p.id;
                const isRecent = recentId === p.id;
                const baseR = 3 + p.factor * 2;
                const r = isHover ? baseR + 2.5 : baseR;
                const opacity = Math.max(0.4, Math.min(1, p.factor * 0.9));
                const hasAttach = p.attachments?.length > 0;
                return (
                  <g key={p.id}>
                    {isHover && (
                      <circle
                        cx={p.sx}
                        cy={p.sy}
                        r={r + 4}
                        fill="none"
                        stroke={MONTH_COLORS[p.monthIdx]}
                        strokeWidth="0.5"
                        strokeOpacity="0.6"
                      />
                    )}
                    <circle
                      cx={p.sx}
                      cy={p.sy}
                      r={r}
                      fill={MONTH_COLORS[p.monthIdx]}
                      fillOpacity={isHover ? 1 : opacity}
                      stroke={isHover ? '#FFFFFF' : 'none'}
                      strokeWidth="0.5"
                      className={`filed-point${isRecent ? ' recent' : ''}`}
                      style={{ cursor: isDragging ? 'grabbing' : 'pointer', transition: 'r 0.15s ease, fill-opacity 0.15s ease' }}
                      onMouseEnter={() => {
                        if (isDragging || isMobile) return;
                        setHoveredId(p.id);
                        setHoverPos({ x: p.sx, y: p.sy });
                      }}
                      onMouseLeave={() => setHoveredId(null)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (dragRef.current?.moved) return;
                        setSelectedEntry(p);
                        setConfirmDelete(false);
                      }}
                    />
                    {hasAttach && (
                      <circle
                        cx={p.sx}
                        cy={p.sy}
                        r={Math.max(0.8, r * 0.32)}
                        fill="#0A0A0C"
                        pointerEvents="none"
                      />
                    )}
                  </g>
                );
              })}
            </svg>
          )}

          {/* Hover preview (desktop only) */}
          {hoveredEntry && !isDragging && (
            <div
              className="filed-hover-preview"
              style={{
                position: 'absolute',
                left: Math.min(Math.max(hoverPos.x - 130, 8), containerWidth - 268),
                top: hoverPos.y > 220 ? hoverPos.y - 4 + 30 : hoverPos.y + 50,
                width: '260px',
                background: '#16161A',
                border: '0.5px solid #2A2A2E',
                padding: '10px 12px',
                pointerEvents: 'none',
                zIndex: 10,
                fontSize: '11px',
              }}
            >
              <div style={{ color: '#555248', marginBottom: '6px', letterSpacing: '0.04em' }}>
                {formatDate(hoveredEntry.createdAt)} &nbsp;·&nbsp; {(hoveredEntry[PRIMARY] || '').length}c{attachmentSummary(hoveredEntry)}
              </div>
              <div style={{
                color: '#A8A59B',
                lineHeight: 1.6,
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}>
                {hoveredEntry[PRIMARY] || (hoveredEntry[SECONDARY] ? <span style={{ color: '#555248', fontStyle: 'italic' }}>{T.translatePending}</span> : <span style={{ color: '#555248', fontStyle: 'italic' }}>// no text</span>)}
              </div>
            </div>
          )}
        </section>

        {/* Composer */}
        <section>
          <div
            className="filed-composer-meta"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              marginBottom: '12px',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ color: '#555248', fontSize: '11px', letterSpacing: '0.05em' }}>
              timestamp &gt;
            </span>
            <input
              type="datetime-local"
              value={customDateTime}
              onChange={(e) => setCustomDateTime(e.target.value)}
              className="filed-dt"
            />
            <button
              onClick={resetDateTime}
              className="filed-btn-ghost"
              style={{
                background: 'transparent',
                border: '0.5px solid #2A2A2E',
                color: '#8A877F',
                padding: '6px 10px',
                fontFamily: 'inherit',
                fontSize: '11px',
                cursor: 'pointer',
                letterSpacing: '0.04em',
              }}
            >
              now
            </button>

            <div style={{ flex: 1 }} />

            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageSelect}
              style={{ display: 'none' }}
            />
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*"
              onChange={handleAudioSelect}
              style={{ display: 'none' }}
            />
            <button
              onClick={() => imageInputRef.current?.click()}
              className="filed-btn-ghost"
              style={{
                background: 'transparent',
                border: '0.5px solid #2A2A2E',
                color: '#8A877F',
                padding: '6px 10px',
                fontFamily: 'inherit',
                fontSize: '11px',
                cursor: 'pointer',
                letterSpacing: '0.04em',
              }}
            >
              + img
            </button>
            <button
              onClick={() => audioInputRef.current?.click()}
              className="filed-btn-ghost"
              style={{
                background: 'transparent',
                border: '0.5px solid #2A2A2E',
                color: '#8A877F',
                padding: '6px 10px',
                fontFamily: 'inherit',
                fontSize: '11px',
                cursor: 'pointer',
                letterSpacing: '0.04em',
              }}
            >
              + aud
            </button>
          </div>

          <div className="filed-textarea-wrap" style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
            <span className="filed-prompt-prefix" style={{ color: '#88C0D0', fontSize: '13px', paddingTop: '14px' }}>&gt;</span>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="// what's there. a friction, a fragment, someone's offhand remark."
              rows={6}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  save();
                }
              }}
              className="filed-input"
              style={{
                flex: 1,
                minHeight: '140px',
                background: '#16161A',
                border: '0.5px solid #2A2A2E',
                padding: '14px 16px',
                fontSize: '13px',
                lineHeight: 1.7,
                fontFamily: '"JetBrains Mono", monospace',
                color: '#D8D5CB',
                resize: 'vertical',
                outline: 'none',
                boxSizing: 'border-box',
                width: '100%',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#88C0D0'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#2A2A2E'; }}
            />
          </div>

          {/* Pending attachments preview */}
          {pendingAttachments.length > 0 && (
            <div className="filed-composer-foot" style={{
              display: 'flex',
              gap: '10px',
              flexWrap: 'wrap',
              marginTop: '14px',
              paddingLeft: '21px',
            }}>
              {pendingAttachments.map((att) => (
                <div
                  key={att.id}
                  style={{
                    position: 'relative',
                    border: '0.5px solid #2A2A2E',
                    background: '#16161A',
                    padding: att.type === 'image' ? 0 : '8px 10px',
                  }}
                >
                  {att.type === 'image' ? (
                    <img
                      src={att.dataURL}
                      alt={att.name}
                      style={{
                        width: '72px',
                        height: '72px',
                        objectFit: 'cover',
                        display: 'block',
                      }}
                    />
                  ) : (
                    <div style={{ width: '200px' }}>
                      <div style={{
                        color: '#A3BE8C',
                        fontSize: '10px',
                        marginBottom: '4px',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}>
                        ♪ {att.name}
                      </div>
                      <audio src={att.dataURL} controls className="filed-audio filed-audio-sm" />
                    </div>
                  )}
                  <button
                    onClick={() => removePendingAttachment(att.id)}
                    aria-label="remove"
                    style={{
                      position: 'absolute',
                      top: '-7px',
                      right: '-7px',
                      background: '#0E0E10',
                      border: '0.5px solid #555248',
                      color: '#D8D5CB',
                      width: '18px',
                      height: '18px',
                      cursor: 'pointer',
                      fontSize: '11px',
                      lineHeight: 1,
                      padding: 0,
                      fontFamily: 'inherit',
                    }}
                  >
                    ×
                  </button>
                  <span style={{
                    position: 'absolute',
                    bottom: '-15px',
                    left: 0,
                    color: '#3D3B36',
                    fontSize: '9px',
                    letterSpacing: '0.05em',
                  }}>
                    {formatBytes(att.size)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div
            className="filed-composer-foot"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: pendingAttachments.length > 0 ? '24px' : '12px',
              gap: '12px',
              flexWrap: 'wrap',
              paddingLeft: '21px',
            }}
          >
            <span style={{ color: '#555248', fontSize: '11px', letterSpacing: '0.04em' }}>
              {draft.length}c{pendingAttachments.length > 0 && ` · ${pendingAttachments.length} attached`} &nbsp;·&nbsp; ⌘+↵ to commit
            </span>
            <button
              onClick={save}
              disabled={(!draft.trim() && pendingAttachments.length === 0) || saving}
              className="filed-btn"
              style={{
                background: 'transparent',
                color: (draft.trim() || pendingAttachments.length > 0) && !saving ? '#88C0D0' : '#3D3B36',
                border: '0.5px solid',
                borderColor: (draft.trim() || pendingAttachments.length > 0) && !saving ? '#88C0D0' : '#2A2A2E',
                padding: '8px 22px',
                fontFamily: 'inherit',
                fontSize: '12px',
                letterSpacing: '0.08em',
                cursor: (draft.trim() || pendingAttachments.length > 0) && !saving ? 'pointer' : 'default',
              }}
            >
              {saving ? '...' : 'commit'}
            </button>
          </div>
        </section>
      </div>

      {/* Detail Modal */}
      {selectedEntry && (
        <div
          className="filed-overlay"
          onClick={closeModal}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(10, 10, 12, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            zIndex: 100,
            backdropFilter: 'blur(3px)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="filed-modal filed-scrollbar"
            style={{
              background: 'rgba(14, 14, 16, 0.5)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
              border: '0.5px solid #2A2A2E',
              maxWidth: '640px',
              width: '100%',
              maxHeight: '80vh',
              overflowY: 'auto',
              padding: '24px 28px',
              fontFamily: '"JetBrains Mono", monospace',
              color: '#D8D5CB',
            }}
          >
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '20px',
              paddingBottom: '12px',
              borderBottom: '0.5px solid #2A2A2E',
              gap: '12px',
              flexWrap: 'wrap',
            }}>
              {editing ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, flexWrap: 'wrap' }}>
                  <span style={{ color: '#555248', fontSize: '11px', letterSpacing: '0.05em' }}>
                    timestamp &gt;
                  </span>
                  <input
                    type="datetime-local"
                    value={editDateTime}
                    onChange={(e) => setEditDateTime(e.target.value)}
                    className="filed-dt"
                  />
                </div>
              ) : (
                <span style={{
                  fontSize: '11px',
                  color: '#8A877F',
                  letterSpacing: '0.05em',
                }}>
                  {formatDate(selectedEntry.createdAt)} &nbsp;·&nbsp; {(selectedEntry[PRIMARY] || '').length}c{attachmentSummary(selectedEntry)}
                </span>
              )}
              <button
                onClick={closeModal}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#555248',
                  fontSize: '14px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  padding: 0,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
                aria-label="close"
              >
                [x]
              </button>
            </div>

            {editing ? (
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                placeholder="// (empty)"
                className="filed-input"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    saveEdit();
                  }
                }}
                style={{
                  width: '100%',
                  minHeight: '180px',
                  background: 'rgba(14, 14, 16, 0.5)',
                  border: '0.5px solid #2A2A2E',
                  padding: '14px 16px',
                  fontSize: '13px',
                  lineHeight: 1.85,
                  fontFamily: '"JetBrains Mono", monospace',
                  color: '#D8D5CB',
                  resize: 'vertical',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = '#88C0D0'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = '#2A2A2E'; }}
              />
            ) : (
              (() => {
                const primary = selectedEntry[PRIMARY];
                const secondary = selectedEntry[SECONDARY];
                if (primary) {
                  return (
                    <div style={{
                      fontSize: '13px',
                      lineHeight: 1.85,
                      color: '#D8D5CB',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}>
                      {primary}
                    </div>
                  );
                }
                if (secondary) {
                  const isTranslating = translatingIds.has(selectedEntry.id);
                  return (
                    <div style={{
                      fontSize: '12px',
                      lineHeight: 1.7,
                      color: '#555248',
                      fontStyle: 'italic',
                    }}>
                      {isTranslating ? (
                        <>{T.translating}<span className="filed-cursor">_</span></>
                      ) : T.translatePending}
                    </div>
                  );
                }
                return null;
              })()
            )}

            {/* Attachments */}
            {(editing ? editAttachments : selectedEntry.attachments)?.map((att, i) => {
              const data = mediaCache[att.mediaKey];
              const showSeparator = editing
                ? (editText || i > 0)
                : (selectedEntry[PRIMARY] || selectedEntry[SECONDARY] || i > 0);
              return (
                <div key={att.mediaKey || i} style={{ marginTop: showSeparator ? '20px' : 0 }}>
                  <div style={{
                    color: '#555248',
                    fontSize: '10px',
                    marginBottom: '6px',
                    letterSpacing: '0.04em',
                    wordBreak: 'break-all',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '8px',
                  }}>
                    <span>// {att.type}: {att.name} · {formatBytes(att.size || 0)}</span>
                    {editing && (
                      <button
                        onClick={() => removeEditAttachment(att.mediaKey)}
                        style={{
                          background: '#0E0E10',
                          border: '0.5px solid #2A2A2E',
                          color: '#8A877F',
                          padding: '2px 8px',
                          fontSize: '10px',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          letterSpacing: '0.04em',
                          flexShrink: 0,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = '#BF616A'; e.currentTarget.style.borderColor = '#BF616A'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = '#8A877F'; e.currentTarget.style.borderColor = '#2A2A2E'; }}
                      >
                        rm
                      </button>
                    )}
                  </div>
                  {data === undefined ? (
                    <div style={{ color: '#555248', fontSize: '11px', padding: '12px 0' }}>
                      loading<span className="filed-cursor">_</span>
                    </div>
                  ) : data === null ? (
                    <div style={{ color: '#BF616A', fontSize: '11px', padding: '12px 0' }}>
                      error: media not found
                    </div>
                  ) : att.type === 'image' ? (
                    <img
                      src={data}
                      alt={att.name}
                      style={{
                        maxWidth: '100%',
                        maxHeight: '480px',
                        display: 'block',
                        border: '0.5px solid #2A2A2E',
                        opacity: editing ? 0.6 : 1,
                      }}
                    />
                  ) : (
                    <audio src={data} controls className="filed-audio" />
                  )}
                </div>
              );
            })}

            <div style={{
              marginTop: '24px',
              paddingTop: '12px',
              borderTop: '0.5px solid #2A2A2E',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap',
            }}>
              {editing ? (
                <>
                  <span style={{ color: '#555248', fontSize: '11px', letterSpacing: '0.04em' }}>
                    {editText.length}c &nbsp;·&nbsp; ⌘+↵ to save
                  </span>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button
                      onClick={cancelEdit}
                      disabled={editSaving}
                      style={{
                        background: 'transparent',
                        border: '0.5px solid #2A2A2E',
                        color: '#8A877F',
                        padding: '6px 14px',
                        fontSize: '11px',
                        cursor: editSaving ? 'default' : 'pointer',
                        fontFamily: 'inherit',
                        letterSpacing: '0.04em',
                      }}
                    >
                      cancel
                    </button>
                    <button
                      onClick={saveEdit}
                      disabled={editSaving}
                      className="filed-btn"
                      style={{
                        background: 'transparent',
                        color: '#88C0D0',
                        border: '0.5px solid #88C0D0',
                        padding: '6px 18px',
                        fontFamily: 'inherit',
                        fontSize: '11px',
                        letterSpacing: '0.06em',
                        cursor: editSaving ? 'default' : 'pointer',
                      }}
                    >
                      {editSaving ? '...' : 'save'}
                    </button>
                  </div>
                </>
              ) : confirmDelete ? (
                <>
                  <span style={{ fontSize: '11px', color: '#8A877F' }}>
                    confirm?
                  </span>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <button
                      onClick={() => setConfirmDelete(false)}
                      style={{
                        background: 'transparent',
                        border: '0.5px solid #2A2A2E',
                        color: '#8A877F',
                        padding: '4px 10px',
                        fontSize: '11px',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      cancel
                    </button>
                    <button
                      onClick={() => deleteEntry(selectedEntry.id)}
                      style={{
                        background: 'transparent',
                        border: '0.5px solid #BF616A',
                        color: '#BF616A',
                        padding: '4px 10px',
                        fontSize: '11px',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      rm
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    onClick={startEdit}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#8A877F',
                      fontSize: '11px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      letterSpacing: '0.04em',
                      padding: 0,
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#88C0D0'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = '#8A877F'; }}
                  >
                    edit
                  </button>
                  <button
                    onClick={() => setConfirmDelete(true)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#555248',
                      fontSize: '11px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      letterSpacing: '0.04em',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#BF616A'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = '#555248'; }}
                  >
                    rm --this
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div
          onClick={() => setShowSettings(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(10, 10, 12, 0.4)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            zIndex: 200,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'rgba(14, 14, 16, 0.92)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
              border: '0.5px solid #2A2A2E',
              maxWidth: '480px',
              width: '100%',
              padding: '24px 28px',
              fontFamily: '"JetBrains Mono", monospace',
              color: '#D8D5CB',
            }}
          >
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '16px',
              paddingBottom: '10px',
              borderBottom: '0.5px solid #2A2A2E',
            }}>
              <span style={{ fontSize: '12px', color: '#D8D5CB', letterSpacing: '0.06em' }}>
                $ settings
              </span>
              <button
                onClick={() => setShowSettings(false)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#555248',
                  fontSize: '14px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                [x]
              </button>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <div style={{ color: '#8A877F', fontSize: '11px', marginBottom: '8px', letterSpacing: '0.04em' }}>
                anthropic api key
              </div>
              <div style={{ color: '#555248', fontSize: '10px', marginBottom: '10px', lineHeight: 1.6 }}>
                used to translate entries between japanese and english.<br />
                stored only in this browser's localStorage. never sent anywhere except the anthropic api.
              </div>
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="sk-ant-..."
                style={{
                  width: '100%',
                  background: 'rgba(14, 14, 16, 0.6)',
                  border: '0.5px solid #2A2A2E',
                  padding: '8px 10px',
                  fontSize: '12px',
                  fontFamily: '"JetBrains Mono", monospace',
                  color: '#D8D5CB',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = '#88C0D0'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = '#2A2A2E'; }}
              />
              <div style={{
                color: hasApiKey ? '#A3BE8C' : '#555248',
                fontSize: '10px',
                marginTop: '6px',
                letterSpacing: '0.04em',
              }}>
                status: {hasApiKey ? 'configured' : 'not set'}
              </div>
            </div>

            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '8px',
              paddingTop: '12px',
              borderTop: '0.5px solid #2A2A2E',
            }}>
              <button
                onClick={() => setShowSettings(false)}
                style={{
                  background: '#0E0E10',
                  border: '0.5px solid #2A2A2E',
                  color: '#8A877F',
                  padding: '6px 14px',
                  fontSize: '11px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                cancel
              </button>
              <button
                onClick={saveApiKey}
                style={{
                  background: '#0E0E10',
                  color: '#88C0D0',
                  border: '0.5px solid #88C0D0',
                  padding: '6px 18px',
                  fontFamily: 'inherit',
                  fontSize: '11px',
                  letterSpacing: '0.06em',
                  cursor: 'pointer',
                }}
              >
                save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}