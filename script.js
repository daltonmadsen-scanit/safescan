
/* SafeScan - Drop-in script.js (avoid_list parentheses INCLUDED)
   - Only warns for terms with sensitivity level >= 2 (2 or 3)
   - Uses existing DOM IDs (no HTML changes)
   - iOS Safari: playsinline + muted; photo-capture fallback if live video fails
   - BarcodeDetector (native) with ZXing fallback (video & photo)
   - Open Food Facts lookup (v2 + v0 fallback)
   - Detailed ingredient matching with parentheses expansion (both ingredients & avoid_list),
     counts, examples, and highlighting under the original avoid_list display label
*/

(async function () {
  'use strict';

  // ---------- DOM ----------
  const videoEl             = document.getElementById('video');
  const startBtn            = document.getElementById('startScanBtn');
  const stopBtn             = document.getElementById('stopScanBtn');
  const supportWarning      = document.getElementById('supportWarning');

  const barcodeInput        = document.getElementById('barcodeInput');
  const lookupBtn           = document.getElementById('lookupBtn');

  const ingredientsText     = document.getElementById('ingredientsText');
  const checkIngredientsBtn = document.getElementById('checkIngredientsBtn');

  const resultSec           = document.getElementById('result');
  const productMeta         = document.getElementById('productMeta');
  const matchSummary        = document.getElementById('matchSummary');
  const matches             = document.getElementById('matches');

  // ---------- Env flags ----------
  const ua = navigator.userAgent || '';
  const isIOS       = /iPhone|iPad|iPod/i.test(ua);
  const isSafari    = (!!navigator.vendor && navigator.vendor.includes('Apple')) || /Safari/i.test(ua);
  const isIOSSafari = isIOS && isSafari;

  // ---------- Load avoid list and build token index (with parentheses) ----------
  const avoidRaw = await fetch('avoid_list.json')
    .then(r => r.json())
    .catch(() => ({ match_keywords: [] }));

  // Two supported formats:
  // 1) avoid_terms: [{ term:"Cheese (havarti)", level:2 }, ...]
  // 2) legacy match_keywords: ["milk", ...] -> treated as level 1
  const avoidTerms = Array.isArray(avoidRaw.avoid_terms)
    ? avoidRaw.avoid_terms
    : (Array.isArray(avoidRaw.match_keywords)
        ? avoidRaw.match_keywords.map(t => ({ term: t, level: 1 }))
        : []);

  const AVOID_LEVEL_MIN = 2; // 🚨 Only warn for level >= 2

  // Normalize helper for tokens
  const norm = s => (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract parentheses content for a single label (e.g., "Cheese (havarti)" -> ["havarti"])
  function extractParenParts(label) {
    const m = label.match(/\(([^)]*)\)/);
    if (!m || !m[1]) return [];
    return m[1]
      .split(/[;,.\|]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Build tokens for a single avoid entry label:
  // - full label (lowercased)
  // - main portion without parentheses
  // - each parenthetical part
  function buildAvoidTokens(label) {
    const low = (label || '').toLowerCase().trim();
    const tokens = new Set();
    if (low) tokens.add(norm(low));                         // "cheese (havarti)"
    const main = low.replace(/\([^)]*\)/g, '').trim();      // "cheese"
    if (main) tokens.add(norm(main));
    const parts = extractParenParts(low);                   // ["havarti"]
    for (const p of parts) tokens.add(norm(p));
    return Array.from(tokens);
  }

  // Build entries and token->entry index (only level >= 2)
  const avoidEntries = [];
  for (const x of avoidTerms) {
    const label = (x.term || '').trim();
    const level = Number(x.level) || 1;
    const tokens = buildAvoidTokens(label);
    avoidEntries.push({ label, level, tokens });
  }

  // Map tokens to entries that should WARN (level >= 2)
  const tokenToEntries = new Map(); // token -> [entry, ...]
  for (const entry of avoidEntries) {
    if (entry.level < AVOID_LEVEL_MIN) continue; // filter here
    for (const tok of entry.tokens) {
      if (!tokenToEntries.has(tok)) tokenToEntries.set(tok, []);
      tokenToEntries.get(tok).push(entry);
    }
  }

  const hasNativeDetector = ('BarcodeDetector' in window);
  if (!hasNativeDetector && supportWarning) supportWarning.hidden = false;

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  async function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load: ${src}`));
      document.head.appendChild(s);
    });
