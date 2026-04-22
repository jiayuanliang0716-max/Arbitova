/**
 * Arbitova — shared theme handler for app pages.
 *
 * Load AFTER the initial inline pre-paint snippet. The pre-paint snippet
 * applies the saved theme before the stylesheet renders to avoid a flash;
 * this file wires up the toggle button and keeps the sun/moon icons in sync.
 *
 * Default theme: 'light' — matches landing page, docs, pricing.
 */
(function () {
  'use strict';

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }

  function syncIcons() {
    var theme = getTheme();
    var darkIcon  = document.getElementById('theme-icon-dark');
    var lightIcon = document.getElementById('theme-icon-light');
    if (darkIcon)  darkIcon.style.display  = theme === 'dark' ? '' : 'none';
    if (lightIcon) lightIcon.style.display = theme === 'dark' ? 'none' : '';
  }

  window.toggleTheme = function () {
    var next = getTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
    syncIcons();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncIcons);
  } else {
    syncIcons();
  }
})();
