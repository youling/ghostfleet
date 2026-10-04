// Runs before styles paint. Only non-secret appearance preferences are persisted.
(() => {
  let preference = "system";
  const media = matchMedia("(prefers-color-scheme: dark)");
  try {
    const saved = localStorage.getItem("ghostfleet-theme");
    if (["light", "dark", "system"].includes(saved)) preference = saved;
  } catch {}
  function apply() {
    document.documentElement.dataset.theme = preference === "system" ? media.matches ? "dark" : "light" : preference;
    document.documentElement.style.colorScheme = document.documentElement.dataset.theme;
    window.dispatchEvent(new Event("ghostfleet-appearance"));
  }
  window.GhostFleetAppearance = {
    getPreference: () => preference,
    setPreference(value) {
      preference = ["light", "dark", "system"].includes(value) ? value : "system";
      try { localStorage.setItem("ghostfleet-theme", preference); } catch {}
      apply();
    },
    isDark: () => document.documentElement.dataset.theme === "dark",
  };
  media.addEventListener("change", () => { if (preference === "system") apply(); });
  apply();
})();
