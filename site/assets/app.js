/* GreenSilicon site - shared header, footer, theme, formatting and chart helpers */

// Edit these links once the repo, video and demo are live.
window.SITE = {
  repo: "https://github.com/Divya2030/GreenSilicon",
  video: "",      // demo video URL (YouTube/Vimeo)
  demo: "",       // hosted prototype URL, if any
  site: "https://divya2030.github.io/GreenSilicon/",
  devpost: "",    // Devpost submission URL
  author: "Divya Kohli",
  affiliation: "Third-year PhD student, University of California, Santa Cruz (UCSC), CA, USA",
};

const PAGES = [
  ["index.html", "Overview"],
  ["story.html", "Why I built this"],
  ["analysis.html", "Analysis"],
  ["landscape.html", "Industry landscape"],
  ["technology.html", "Technology"],
  ["impact.html", "Impact"],
  ["judges.html", "For judges"],
];

const LOGO = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/><path d="M9.5 14.5c2 0 4.5-1.2 5.5-5-3.5.3-6 2-5.5 5zm0 0 2-2"/></svg>`;

const ICONS = {
  factory: '<path d="M2 20h20M4 20V9l5 3V9l5 3V5h4l2 15"/>',
  puzzle: '<path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z"/>',
  droplet: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  ruler: '<path d="M3 17 17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
};
function icons() {
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[el.dataset.icon] || ""}</svg>`;
  });
}
const THEME_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MENU_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';

function header() {
  const here = location.pathname.split("/").pop() || "index.html";
  const links = PAGES.map(([href, label]) => `<a href="${href}" class="${href === here ? "active" : ""}">${label}</a>`).join("");
  const el = document.createElement("header");
  el.className = "site-header";
  el.innerHTML = `<div class="wrap">
    <a class="logo" href="index.html"><span class="logo-mark">${LOGO}</span>GreenSilicon</a>
    <button class="icon-btn menu-btn" aria-label="Menu" onclick="document.querySelector('.nav').classList.toggle('open')">${MENU_ICON}</button>
    <nav class="nav">${links}</nav>
    <button class="icon-btn" id="theme" aria-label="Toggle dark mode" title="Toggle theme">${THEME_ICON}</button>
  </div>`;
  document.body.prepend(el);
  document.getElementById("theme").onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme !== "dark"
      : !matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    try { localStorage.setItem("gs-theme", document.documentElement.dataset.theme); } catch (e) { /* storage unavailable */ }
    window.dispatchEvent(new Event("themechange"));
  };
}

function footer() {
  const el = document.createElement("footer");
  el.className = "site-footer";
  const gen = window.GS ? new Date(window.GS.generatedAt * 1000).toLocaleString() : "";
  el.innerHTML = `<div class="wrap">
    <div><b>GreenSilicon</b> · IEEE ClimateChain Global Hackathon 2026 · Primary track: Sustainable Supply Chains<br>Team: <b>${SITE.author}</b>, ${SITE.affiliation}</div>
    <div>${SITE.repo ? `<a href="${SITE.repo}">Source code (MIT)</a> · ` : ""}Figures generated from the live prototype${gen ? ` on ${gen}` : ""}. Companies in the demo scenario are fictional; physics and data sources are real.</div>
  </div>`;
  document.body.append(el);
}

try { const t = localStorage.getItem("gs-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* ignore */ }
document.addEventListener("DOMContentLoaded", () => { header(); footer(); fillLinks(); icons(); });

function fillLinks() {
  document.querySelectorAll("[data-link]").forEach((a) => {
    const url = SITE[a.dataset.link];
    if (url) a.href = url; else a.remove();
  });
}

// ---------------------------------------------------------------- format
const F = {
  num: (n, d = 0) => (n == null || isNaN(n) ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d })),
  carbon(g, d = 1) {
    const a = Math.abs(g);
    if (a >= 1e6) return `${(g / 1e6).toFixed(d)} t`;
    if (a >= 1e3) return `${(g / 1e3).toFixed(a >= 1e5 ? 0 : d)} kg`;
    return `${Math.round(g)} g`;
  },
  pct: (x, d = 0) => `${(x * 100).toFixed(d)}%`,
};
window.F = F;

// ----------------------------------------------------------------- charts
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
window.cssVar = cssVar;
window.SERIES = () => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--series-${i}`));

const charts = [];
window.makeChart = function (id, build) {
  const el = document.getElementById(id);
  if (!el || !window.Chart) return;
  const render = () => {
    const prev = charts.find((c) => c.id === id);
    if (prev) { prev.chart.destroy(); charts.splice(charts.indexOf(prev), 1); }
    Chart.defaults.font.family = "Inter, system-ui, sans-serif";
    Chart.defaults.color = cssVar("--axis");
    Chart.defaults.borderColor = cssVar("--grid");
    const cfg = build();
    cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, animation: false }, cfg.options || {});
    const canvas = document.createElement("canvas");
    el.innerHTML = "";
    el.append(canvas);
    charts.push({ id, chart: new Chart(canvas, cfg) });
  };
  render();
  window.addEventListener("themechange", () => setTimeout(render, 0));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
};

window.legendOpts = { labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, boxHeight: 8, padding: 14 } };
window.STEP_SEQ = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
