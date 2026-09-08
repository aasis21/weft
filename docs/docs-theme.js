(() => {
  const key = "weft.docs.theme";
  let theme = "system";
  let storageUnavailable = false;
  try {
    const saved = localStorage.getItem(key);
    if (saved === "light" || saved === "dark") theme = saved;
  } catch {
    storageUnavailable = true;
  }

  function apply() {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = theme;
  }
  apply();

  document.addEventListener("DOMContentLoaded", () => {
    const button = document.querySelector("#theme-toggle");
    const status = document.querySelector("#theme-status");
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function updateButton() {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      button.dataset.nextTheme = dark ? "light" : "dark";
      const label = dark ? "Switch to light mode" : "Switch to dark mode";
      button.setAttribute("aria-label", label);
      button.title = label;
    }
    updateButton();
    media.addEventListener("change", updateButton);
    button.hidden = false;
    if (storageUnavailable) status.textContent = "Theme preferences cannot be saved in this browser.";
    button.addEventListener("click", () => {
      theme = button.dataset.nextTheme;
      apply();
      updateButton();
      try {
        if (theme === "system") localStorage.removeItem(key);
        else localStorage.setItem(key, theme);
        status.textContent = "";
      } catch {
        status.textContent = "Theme applied for this visit; this browser could not save it.";
      }
    });
  });
})();
