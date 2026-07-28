const api = window.dynamicShowcase;
const surface = document.getElementById("surface");
const hint = document.getElementById("hint");
let media = null;
let currentKey = "";
let exitRequested = false;
const openedAt = performance.now();

function requestLock() {
  if (exitRequested) return;
  exitRequested = true;
  api.exitAndLock();
}

function apply(payload) {
  const entry = payload?.entry;
  const settings = payload?.settings || {};
  if (!entry) {
    surface.replaceChildren();
    currentKey = "";
    return;
  }
  const key = `${entry.id}:${entry.url}`;
  if (key !== currentKey) {
    currentKey = key;
    media = document.createElement(entry.kind === "video" ? "video" : "img");
    media.src = entry.url;
    media.draggable = false;
    if (entry.kind === "video") {
      media.autoplay = true;
      media.loop = true;
      media.playsInline = true;
      media.preload = "auto";
      media.addEventListener("canplay", () => media.play().catch(() => {}));
    }
    surface.replaceChildren(media);
  }
  media.style.objectFit = settings.fit || "cover";
  media.style.objectPosition = `${settings.positionX ?? 50}% ${settings.positionY ?? 50}%`;
  if (media.tagName === "VIDEO") {
    media.muted = Boolean(settings.muted);
    media.volume = Math.max(0, Math.min(1, Number(settings.volume) || 0));
    media.play().catch(() => {});
  }
}

document.addEventListener("keydown", (event) => {
  event.preventDefault();
  requestLock();
});
document.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  if (performance.now() - openedAt > 350) requestLock();
});

setTimeout(() => hint.classList.add("hidden"), 4800);
api.onState(apply);
api.ready();
