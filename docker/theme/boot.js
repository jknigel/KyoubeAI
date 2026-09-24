(function () {
  // Inlined into index.html's <head> by docker/theme/theme.mjs.
  // The Studio skin applies while the Studio plugin's team roster is on the
  // page. The plugin's UI loads after the first paint, so without this flag a
  // full page load would show the stock sidebar and then rearrange it. The
  // flag applies the layout at once and clears itself if the roster has not
  // appeared within a few seconds (plugin missing or failed), which returns
  // the stock sidebar.
  var root = document.documentElement;
  try {
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "")) root.setAttribute("data-kyoube-platform", "mac");
  } catch (e) {}
  root.setAttribute("data-kyoube-shell", "studio");
  setTimeout(function () {
    if (!document.querySelector('[data-kyoube-studio="team"]')) root.removeAttribute("data-kyoube-shell");
  }, 6000);
})();
