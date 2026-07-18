/**
 * piex.dev article helpers: docs nav, on-page TOC active state, mobile toggles, code copy.
 */
(function () {
  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }
  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* ---- mobile collapsible panels ---- */
  qsa(".blog-toc-mobile, .docs-mobile-nav").forEach(function (panel) {
    var toggle = qs(".blog-toc-toggle", panel);
    if (!toggle) return;
    toggle.addEventListener("click", function () {
      var open = panel.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    qsa("a", panel).forEach(function (a) {
      a.addEventListener("click", function () {
        // only collapse for in-page anchors; keep open for doc switches is fine (page unloads)
        if ((a.getAttribute("href") || "").charAt(0) === "#") {
          panel.classList.remove("is-open");
          toggle.setAttribute("aria-expanded", "false");
        }
      });
    });
  });

  /* ---- heading ids (if missing) ---- */
  var prose = qs(".blog-prose");
  if (prose) {
    qsa("h2, h3", prose).forEach(function (h) {
      if (h.id) return;
      var text = (h.textContent || "").trim();
      if (!text) return;
      var id = text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
      if (id) h.id = id;
    });
  }

  /* ---- auto-build on-page TOC if empty ---- */
  function fillToc(nav) {
    if (!nav || !prose || nav.children.length) return;
    qsa("h2, h3", prose).forEach(function (h) {
      if (!h.id) return;
      var a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = (h.textContent || "").trim();
      if (h.tagName === "H3") a.className = "depth-3";
      nav.appendChild(a);
    });
  }
  fillToc(qs(".page-toc nav"));
  fillToc(qs(".blog-toc nav"));
  fillToc(qs(".blog-toc-mobile-nav"));

  /* ---- active section highlight (on-page TOC only) ---- */
  var tocLinks = qsa(
    ".page-toc a[href^='#'], .blog-toc a[href^='#'], .blog-toc-mobile-nav a[href^='#']"
  );
  var headings = tocLinks
    .map(function (a) {
      var id = decodeURIComponent((a.getAttribute("href") || "").slice(1));
      return id ? document.getElementById(id) : null;
    })
    .filter(Boolean);

  // de-dupe headings by id
  var seen = {};
  headings = headings.filter(function (h) {
    if (seen[h.id]) return false;
    seen[h.id] = true;
    return true;
  });

  function setActive(id) {
    tocLinks.forEach(function (a) {
      var href = decodeURIComponent((a.getAttribute("href") || "").slice(1));
      a.classList.toggle("is-active", href === id);
    });
  }

  if (headings.length && "IntersectionObserver" in window) {
    var visible = new Map();
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          visible.set(entry.target.id, entry.isIntersecting && entry.intersectionRatio > 0);
        });
        var active = null;
        for (var i = 0; i < headings.length; i++) {
          if (visible.get(headings[i].id)) {
            active = headings[i].id;
            break;
          }
        }
        if (!active) {
          var best = null;
          var bestTop = -Infinity;
          headings.forEach(function (h) {
            var top = h.getBoundingClientRect().top;
            if (top < 120 && top > bestTop) {
              bestTop = top;
              best = h.id;
            }
          });
          active = best || headings[0].id;
        }
        setActive(active);
      },
      { rootMargin: "-20% 0px -65% 0px", threshold: [0, 0.1, 0.5, 1] }
    );
    headings.forEach(function (h) {
      io.observe(h);
    });
  }

  /* ---- code copy ---- */
  qsa(".blog-code").forEach(function (block) {
    var pre = qs("pre", block);
    if (!pre) return;
    var bar = qs(".blog-code-bar", block);
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "blog-code-bar";
      var lang = block.getAttribute("data-lang") || "code";
      bar.innerHTML =
        "<span>" + lang + '</span><button type="button" class="blog-code-copy">Copy</button>';
      block.insertBefore(bar, pre);
    }
    var btn = qs(".blog-code-copy", bar);
    if (!btn) return;
    btn.addEventListener("click", function () {
      var text = pre.innerText || pre.textContent || "";
      function done() {
        btn.textContent = "Copied";
        btn.classList.add("is-copied");
        setTimeout(function () {
          btn.textContent = "Copy";
          btn.classList.remove("is-copied");
        }, 1400);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {
          fallbackCopy(text, done);
        });
      } else {
        fallbackCopy(text, done);
      }
    });
  });

  function fallbackCopy(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch (_) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }
})();
