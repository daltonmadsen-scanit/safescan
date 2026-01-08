
<script>
/* =========================================================================
   SafeScan DOM Add‑On (Non-invasive)
   - Display ONLY Level 2 & Level 3 items
   - Prefer full Item label (e.g., "Cheese (asiago)") when available
   - Does NOT change or wrap any existing code, data, or network calls
   ========================================================================= */

(function() {
  'use strict';

  // Config
  const LEVELS_TO_SHOW = new Set([2, 3]);

  // Helpers
  const isLevel23 = (lvl) => LEVELS_TO_SHOW.has(Number(lvl));
  const getNumber = (text) => Number(String(text || '').replace(/[^\d]/g, ''));

  // Try to read a "Level" from an element (attribute, class, or text)
  function inferLevelFromElement(el) {
    // 1) Explicit attribute: data-level="2"
    if (el.hasAttribute('data-level')) return getNumber(el.getAttribute('data-level'));

    // 2) Class-based: level-2 / level-3
    for (const cls of el.classList) {
      const m = cls.match(/^level-(\d+)$/i);
      if (m) return Number(m[1]);
    }

    // 3) Table row: look for a cell that looks like a Level column
    if (el.tagName === 'TR') {
      const cells = Array.from(el.children);
      // Heuristic: first 3 cells might contain level
      for (let i = 0; i < Math.min(3, cells.length); i++) {
        const n = getNumber(cells[i].textContent);
        if (!Number.isNaN(n) && n >= 0) return n;
      }
    }

    // 4) Text pattern: "... Level: 2"
    const text = (el.textContent || '').toLowerCase();
    const match = text.match(/level\s*:?\s*(\d)/);
    if (match) return Number(match[1]);

    return undefined;
  }

  // Put a good label on an element if we have one
  function applyLabelIfAvailable(el) {
    const labelAttr = el.getAttribute('data-item') || el.getAttribute('data-label');
    if (labelAttr && labelAttr.trim()) {
      // If there is a specific label slot, use it; otherwise set the element text
      const slot = el.querySelector('.item-label') || el;
      slot.textContent = labelAttr.trim();
    }
  }

  // Decide if an element should be visible (Level 2/3) and update label
  function evaluateElement(el) {
    const lvl = inferLevelFromElement(el);
    if (lvl === undefined) return; // Unknown level; do not interfere
    const show = isLevel23(lvl);
    el.style.display = show ? '' : 'none';
    if (show) applyLabelIfAvailable(el);
  }

  // Apply to common item containers
  function filterDOM() {
    // 1) Elements that explicitly declare their level
    document.querySelectorAll('[data-level]').forEach(evaluateElement);

    // 2) Class-based level markers
    document.querySelectorAll('.level-0, .level-1, .level-2, .level-3, .level-4, .level-5, .level-6')
      .forEach(evaluateElement);

    // 3) Tables (rows)
    document.querySelectorAll('table tbody tr, table tr').forEach(evaluateElement);

    // 4) Generic cards/list items (only if they mention a level or have data-label)
    document.querySelectorAll('.item, .result, .card, li').forEach(el => {
      const hasLevel = el.hasAttribute('data-level') ||
                       [...el.classList].some(c => /^level-\d+$/i.test(c)) ||
                       /level\s*:?\s*\d/i.test(el.textContent || '');
      if (hasLevel) evaluateElement(el);
      else applyLabelIfAvailable(el); // surface label if provided
    });
  }

  // Debounce to avoid excessive work on frequent DOM changes
  let debounceTimer;
  function debouncedFilter() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(filterDOM, 30);
  }

  // Initial run
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', debouncedFilter);
  } else {
    debouncedFilter();
  }

  // Observe DOM changes without touching original code
  const observer = new MutationObserver(debouncedFilter);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Optional: If you add a checkbox with id="only23", we’ll respect it
  const toggle = document.getElementById('only23');
  if (toggle) {
    toggle.addEventListener('change', () => {
      if (toggle.checked) {
        debouncedFilter();
      } else {
        // Show everything (do not change labels)
        document.querySelectorAll('[data-level], .level-0, .level-1, .level-2, .level-3, .level-4, .level-5, .level-6, .item, .result, .card, li, tr')
          .forEach(el => el.style.removeProperty('display'));
      }
    });
  }

  console.info('[SafeScan DOM Add‑On] Active: Level 2 & 3 only. Base script untouched.');
})();
</script>
