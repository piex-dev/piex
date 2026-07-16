/**
 * 站内 Markdown 阅读器：UTF-8 解码 + marked 渲染，避免 GitHub Pages 将 .md 当纯文本。
 */
(function () {
  const DOCS = [
    { file: "design.md", title: "设计理念", group: "docs" },
    { file: "architecture.md", title: "架构概览", group: "docs" },
    { file: "roadmap.md", title: "实施路线", group: "docs" },
    { file: "evaluation.md", title: "评测方案", group: "docs" },
    { file: "testing.md", title: "测试指南", group: "docs" },
    { file: "references.md", title: "参考资料", group: "docs" },
  ];

  const BLOGS = [
    {
      file: "blogs/hashline.md",
      title: "Hashline 方案的原理及借鉴",
      date: "2026-07-16",
      group: "blogs",
    },
    {
      file: "blogs/pi-extension-mechanism.md",
      title: "Pi Extension 机制及工作原理",
      date: "2026-07-14",
      group: "blogs",
    },
  ];

  const ALL = DOCS.concat(BLOGS);
  const REPO_BLOB = "https://github.com/piex-dev/piex/blob/main/docs/";

  const params = new URLSearchParams(location.search);
  const requested = params.get("doc") || "design.md";
  const docEntry = ALL.find(function (d) {
    return d.file === requested;
  }) || DOCS[0];
  const docFile = docEntry.file;

  const navEl = document.getElementById("doc-nav");
  const contentEl = document.getElementById("doc-content");
  const statusEl = document.getElementById("doc-status");
  const rawLink = document.getElementById("doc-raw-link");

  function setStatus(msg, isError) {
    statusEl.hidden = !msg;
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("doc-status-error", !!isError);
  }

  function basename(path) {
    return String(path || "").split("/").pop();
  }

  function resolveDocPath(hrefPath) {
    if (!hrefPath) return null;
    // exact match first
    if (ALL.some(function (d) { return d.file === hrefPath; })) return hrefPath;
    // basename match (design.md / ./design.md / ../design.md)
    var base = basename(hrefPath);
    var hit = ALL.find(function (d) { return basename(d.file) === base; });
    return hit ? hit.file : null;
  }

  // group label + links
  var groups = {};
  ALL.forEach(function (d) {
    if (!groups[d.group]) groups[d.group] = [];
    groups[d.group].push(d);
  });

  Object.keys(groups).forEach(function (group) {
    var labelText = group === "blogs" ? "Blog" : "Docs";
    var label = document.createElement("p");
    label.className = "doc-sidebar-title";
    label.textContent = labelText;
    navEl.appendChild(label);

    groups[group].forEach(function (d) {
      var a = document.createElement("a");
      a.href = "doc.html?doc=" + encodeURIComponent(d.file);
      a.textContent = d.date ? d.date + " · " + d.title : d.title;
      if (d.file === docFile) a.classList.add("is-active");
      navEl.appendChild(a);
    });
  });

  /* collapsible sidebar on mobile */
  var sidebarEl = document.querySelector(".doc-sidebar");
  var sidebarToggle = document.getElementById("doc-sidebar-toggle");
  if (sidebarEl && sidebarToggle) {
    var activeEntry = ALL.find(function (d) { return d.file === docFile; });
    var toggleLabel = sidebarToggle.querySelector(".doc-sidebar-toggle-label");
    if (toggleLabel && activeEntry) {
      toggleLabel.textContent = activeEntry.date
        ? activeEntry.date + " · " + activeEntry.title
        : activeEntry.title;
    }

    sidebarToggle.addEventListener("click", function () {
      var open = sidebarEl.classList.toggle("is-open");
      sidebarToggle.setAttribute("aria-expanded", String(open));
    });

    // collapse after picking another doc link (same-page nav uses full reload, but keep for safety)
    navEl.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        sidebarEl.classList.remove("is-open");
        sidebarToggle.setAttribute("aria-expanded", "false");
      });
    });
  }
  document.title = docEntry.title + " — PieX";
  rawLink.href = REPO_BLOB + docFile;

  /** 相对路径链接：站内 .md → doc.html，其它保持 */
  function rewriteLinks(container) {
    container.querySelectorAll("a[href]").forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href || href.startsWith("http") || href.startsWith("#") || href.startsWith("mailto:")) return;
      if (!(href.endsWith(".md") || /\.md#/.test(href))) return;

      var parts = href.split("#");
      var path = parts[0];
      var hash = parts[1];
      var resolved = resolveDocPath(path);
      if (resolved) {
        a.href = "doc.html?doc=" + encodeURIComponent(resolved) + (hash ? "#" + hash : "");
      }
    });
  }

  function parseFrontmatter(md) {
    var result = { body: md, fm: {} };
    if (!md.startsWith("---")) return result;

    var end = md.indexOf("\n---", 3);
    if (end === -1) return result;

    var block = md.slice(3, end).trim();
    var fm = {};
    block.split("\n").forEach(function (line) {
      var i = line.indexOf(":");
      if (i <= 0) return;
      var k = line.slice(0, i).trim();
      var v = line.slice(i + 1).trim();
      // strip surrounding quotes
      v = v.replace(/^["']|["']$/g, "");
      // keep simple array tags as raw string; unused for now
      fm[k] = v;
    });

    var body = md.slice(end + 4).replace(/^\n+/, "");
    // inject H1 from frontmatter title if body has no markdown H1
    if (fm.title && !/(^|\n)#\s+\S/.test(body)) {
      body = "# " + fm.title + "\n\n" + body;
    }

    result.fm = fm;
    result.body = body;
    return result;
  }

  async function load() {
    setStatus("加载中…", false);
    contentEl.innerHTML = "";

    try {
      var res = await fetch(docFile, { credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP " + res.status);

      var buf = await res.arrayBuffer();
      var raw = new TextDecoder("utf-8").decode(buf);
      var parsed = parseFrontmatter(raw);
      var md = parsed.body;
      var fm = parsed.fm;

      if (fm.date) docEntry.date = fm.date;
      if (fm.title) {
        docEntry.title = fm.title;
        document.title = fm.title + " — PieX";
      }

      var html = marked.parse(md, {
        gfm: true,
        breaks: false,
        headerIds: true,
        mangle: false,
      });
      var safe = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
      contentEl.innerHTML = safe;

      if (docEntry.date) {
        var h1 = contentEl.querySelector("h1");
        var meta = document.createElement("p");
        meta.className = "doc-meta";
        meta.textContent = docEntry.date;
        if (h1) {
          h1.insertAdjacentElement("afterend", meta);
        } else {
          contentEl.insertBefore(meta, contentEl.firstChild);
        }
      }

      rewriteLinks(contentEl);
      setStatus("", false);
    } catch (e) {
      setStatus("无法加载文档：" + (e.message || e), true);
    }
  }

  load();
})();
