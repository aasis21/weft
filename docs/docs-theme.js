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
    const select = document.querySelector("#theme-select");
    const status = document.querySelector("#theme-status");
    select.value = theme;
    select.closest("label").hidden = false;
    if (storageUnavailable) status.textContent = "Theme preferences cannot be saved in this browser.";
    select.addEventListener("change", () => {
      theme = select.value;
      apply();
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
