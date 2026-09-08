// Content and native disclosure navigation remain usable without JavaScript.
const navigation = document.querySelector("#navigation");
const mobile = window.matchMedia("(max-width: 760px)");
const links = [...navigation.querySelectorAll('nav a[href^="#"]')];
const sections = links.map((link) => document.querySelector(link.getAttribute("href")));
document.documentElement.classList.add("enhanced");

function syncNavigation() {
  navigation.open = !mobile.matches;
}

function markCurrent(section) {
  for (const link of links) {
    if (link.hash === `#${section.id}`) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}

function targetForHash() {
  let id;
  try {
    id = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    // A malformed URL fragment is not a document ID.
    return null;
  }
  return document.getElementById(id);
}

function markHash() {
  const target = targetForHash();
  const section = target?.closest("section") ?? sections[0];
  if (section) markCurrent(section);
}

syncNavigation();
markHash();
mobile.addEventListener("change", syncNavigation);
window.addEventListener("hashchange", markHash);

navigation.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link || !mobile.matches) return;
  navigation.open = false;
  const target = document.getElementById(link.hash.slice(1));
  if (!target) return;
  // Move focus out of the collapsed menu so keyboard users continue in the content.
  target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
});

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) markCurrent(entry.target);
    }
  }, { rootMargin: "-18% 0px -65% 0px", threshold: 0 });
  sections.forEach((section) => observer.observe(section));
}
