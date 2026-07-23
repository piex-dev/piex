/**
 * piex.dev — shared client scripts
 * Language toggle (EN/ZH), content-page language routing, scroll animations,
 * copy-on-click, install switcher, mobile nav-sheet drawer.
 *
 * URL convention (multi-lang ready):
 *   /                         homepage (JS dictionary i18n)
 *   /{lang}/docs/<slug>/      docs (static HTML per language)
 *   /{lang}/blogs/<slug>/     blogs (static HTML per language)
 *   /{lang}/packages/<slug>/  package intros (static HTML per language)
 * Supported langs today: en, zh. New langs = new path segment + static pages.
 */
(function () {
  var SUPPORTED = { en: true, zh: true };
  var DEFAULT_LANG = "en";

  /* ---- i18n dictionary (homepage chrome) ---- */

  var LANG = (function () {
    var saved = localStorage.getItem("piex-lang");
    if (saved && SUPPORTED[saved]) return saved;
    return DEFAULT_LANG;
  })();

  var T = {
    en: {
      "hero.badge": 'Built on <span class="s1">Pi Extension API</span> · MIT',
      "hero.title":
        '<span class="accent">PieX</span> — Extend Pi without forking',
      "hero.lead":
        "Core capabilities extracted from oh-my-pi, Claude Code, OpenCode and other coding agents, packaged as independent <code>@piex-dev/*</code> npm packages. Install with <code>pi install</code>.",
      "hero.cta1": "Get Started",
      "hero.cta2": "GitHub",
      "hero.term.title": "pi — piex",
      "hero.term.body":
        '<span class="comment"># Pick any package:</span>\n<span class="prompt">$</span> pi install npm:@piex-dev/hashline\n<span class="prompt">$</span> pi install npm:@piex-dev/dap\n<span class="prompt">$</span> pi install npm:@piex-dev/lsp\n<span class="comment"># All-in-one:</span>\n<span class="prompt">$</span> curl -fsSL piex.dev/scripts/install.sh | bash',
      "nav.why": "Philosophy",
      "nav.packages": "Packages",
      "nav.docs": "Docs",
      "nav.blog": "Blog",
      "nav.principles": "Principles",
      "copy.label": "Copy",
      "copy.copied": "Copied",

      "why.title": "Design Philosophy",
      "why.desc":
        "Extend Pi without forking — on demand, understood, and measured.",
      "why.1.title": "Extend Pi, never fork",
      "why.1.desc":
        "omp forks the core and bundles everything; piex only extends via the official Extension API — never touching the core, upgrading with Pi.",
      "why.2.title": "On demand, switch freely",
      "why.2.desc":
        "Independent packages — install & remove at will. Minimal and in control: pay tokens only for what you use.",
      "why.3.title": "Know how it works",
      "why.3.desc":
        "Borrow the best from top agents — understand their designs, then rebuild as extensions you fully control.",
      "why.4.title": "Eval first",
      "why.4.desc":
        "Behavior-changing extensions ship with eval criteria & data. No measurement, no adoption.",
      "why.more": "Read the full design philosophy →",

      "blog.title": "Blog",
      "blog.desc":
        "Deep dives into Pi extension mechanics, coding agent design, and tooling.",
      "blog.ext.title": "Pi Extension Mechanism & Internals",
      "blog.ext.excerpt":
        "Loader, runner, wrapper — how pi stays minimal and extensible.",

      "packages.title": "Packages",
      "packages.desc":
        "All packages are published as <code>@piex-dev/&lt;name&gt;</code>. Click a card for its intro, usage &amp; changelog.",
      "pkg.overview": "Overview →",
      "pkg.hashline.desc":
        "Line-anchored, #TAG-verified hashline patch language — fewer mistakes, less token waste.",
      "pkg.dap.desc":
        "DAP debug adapter collection (14 adapters): breakpoints, stepping, variable inspection inside the agent session.",
      "pkg.lsp.desc":
        "Diagnostics (post-edit ERRORs), navigation, rename/code actions & format across ~50 default servers.",
      "pkg.plan.desc":
        "Read-only exploration, plan drafting & step-by-step execution with progress tracking and tool locking.",
      "pkg.review.desc":
        "Interactive code review command & callable review tool covering diff / commit / branch comparisons.",
      "pkg.init.desc":
        "Guided /init prompt template: scan the repo and create or improve AGENTS.md.",
      "pkg.xai.desc":
        "xAI Grok OAuth subscription login: SuperGrok / X Premium+, with real-time model discovery.",
      "pkg.btw.desc":
        "Ephemeral side questions with full session context — answers not saved to conversation history.",
      "pkg.context.desc":
        "Session usage report: entry distribution, role breakdown, and estimated token allocation.",
      "pkg.goal.desc":
        "Autonomous goal completion: agent_settled-gated continuation, goal_id stale guard, goal_blocked impasse, and token-budget wrap-up.",
      "pkg.theme.desc":
        "High-contrast dark terminal theme with green/blue/red accents, distributed via pi.themes.",

      "docs.title": "Documentation",
      "docs.desc":
        "Synced with the <code>docs/</code> directory in the repository.",
      "docs.design.title": "Design Philosophy",
      "docs.design.sub": "Core principles & architecture patterns",
      "docs.arch.title": "Architecture Overview",
      "docs.arch.sub": "Structure, tool registration, API mapping",
      "docs.roadmap.title": "Roadmap",
      "docs.roadmap.sub": "Completed & planned",
      "docs.eval.title": "Evaluation Plan",
      "docs.eval.sub": "Benchmarks, metrics & implementation path",
      "docs.testing.title": "Testing Guide",
      "docs.testing.sub": "Per-package verification commands",
      "docs.refs.title": "References",
      "docs.refs.sub": "Pi docs & source projects",

      "footer.project": "Project",
      "footer.docs": "Docs",
      "footer.ecosystem": "Ecosystem",
      "footer.bottom": "piex-dev/piex · MIT License · Built on",
      "footer.ghub": "GitHub",
      "footer.npm": "npm",
      "footer.roadmap": "Roadmap",
      "footer.design": "Design",
      "footer.arch": "Architecture",
      "footer.testing": "Testing Guide",
      "footer.pi": "Pi",
      "footer.omp": "oh-my-pi",
      "copy.hint": "click to copy",
    },
    zh: {
      "hero.badge": '基于 <span class="s1">Pi Extension API</span> · MIT',
      "hero.title": '<span class="accent">PieX</span> — 不 fork Pi，按需扩展',
      "hero.lead":
        "从 oh-my-pi、Claude Code、OpenCode 等优秀 coding agent 提炼核心能力，封装为独立 <code>@piex-dev/*</code> package，<code>pi install</code> 即装即用。",
      "hero.cta1": "快速安装",
      "hero.cta2": "GitHub",
      "hero.term.title": "pi — piex",
      "hero.term.body":
        '<span class="comment"># 按需安装，逐包自由组合：</span>\n<span class="prompt">$</span> pi install npm:@piex-dev/hashline\n<span class="prompt">$</span> pi install npm:@piex-dev/dap\n<span class="prompt">$</span> pi install npm:@piex-dev/lsp\n<span class="comment"># 一键全部：</span>\n<span class="prompt">$</span> curl -fsSL piex.dev/scripts/install.sh | bash',
      "nav.why": "理念",
      "nav.packages": "Packages",
      "nav.docs": "文档",
      "nav.blog": "博客",
      "nav.principles": "原则",
      "copy.label": "复制",
      "copy.copied": "已复制",

      "why.title": "设计理念",
      "why.desc": "充分拓展 pi 而非 fork，按需自由切换，知其所以然，评测优先。",
      "why.1.title": "充分拓展，而非 fork",
      "why.1.desc":
        "omp fork 内核并全量内置；piex 只做官方扩展，不碰内核，随 pi 升级而升级。",
      "why.2.title": "按需拓展，自由切换",
      "why.2.desc":
        "扩展相互独立、即装即卸；克制可控，只为用到的能力付出 token。",
      "why.3.title": "知其所以然",
      "why.3.desc":
        "取百家之长：借鉴主流 agent 的优秀设计，搞懂原理再以扩展引入，自己选择、自己掌控。",
      "why.4.title": "评测优先",
      "why.4.desc":
        "影响 agent 行为的扩展须有评测标准与数据支撑：无法度量，就不引入。",
      "why.more": "阅读完整设计理念 →",
      "blog.title": "博客",
      "blog.desc": "项目级深度文章：Pi 扩展机制、coding agent 设计与工具链。",
      "blog.ext.title": "Pi Extension 机制及工作原理",
      "blog.ext.excerpt":
        "loader / runner / wrapper：pi 如何保持内核极简又可扩展。",

      "packages.title": "Package 总览",
      "packages.desc":
        "npm 包名均为 <code>@piex-dev/&lt;name&gt;</code>。点击卡片查看该 package 的介绍、使用说明与迭代记录。",
      "pkg.overview": "介绍 →",
      "pkg.hashline.desc":
        "行锚定、#TAG 校验的 hashline 补丁语言，降低误改与 token 浪费。",
      "pkg.dap.desc":
        "DAP 调试适配器集合（14 个 adapter），在 agent 会话中断点、单步、查看变量。",
      "pkg.lsp.desc":
        "写后 ERROR 诊断、导航、rename/code_actions 与格式化，~50 个默认 language server。",
      "pkg.plan.desc": "只读探索、计划撰写与分步执行，带进度跟踪与工具锁定。",
      "pkg.review.desc":
        "交互式代码评审命令与 review 工具，覆盖 diff / commit / 分支对比。",
      "pkg.init.desc": "引导式 /init prompt：扫描仓库并创建或改进 AGENTS.md。",
      "pkg.xai.desc":
        "xAI Grok OAuth 订阅登录，SuperGrok / X Premium+，含实时模型发现。",
      "pkg.theme.desc":
        "高对比暗终端主题，绿 / 蓝 / 红强调色，通过 pi.themes 分发。",

      "docs.title": "项目文档",
      "docs.desc": "与仓库 <code>docs/</code> 同源同步。",
      "docs.design.title": "设计理念",
      "pkg.btw.desc": "临时提问，用满会话上下文回答，答案不进入后续对话历史。",
      "pkg.context.desc": "会话用量报告：条目分布、角色占比与 token 估算。",
      "pkg.goal.desc":
        "自主目标完成：agent_settled 空闲边界续跑、goal_id stale 守卫、goal_blocked 阻塞通道、token 预算 wrap-up。",
      "docs.design.sub": "核心原则与架构模式",
      "docs.arch.title": "架构概览",
      "docs.arch.sub": "结构、工具注册、API 映射",
      "docs.roadmap.title": "实施路线",
      "docs.roadmap.sub": "已完成与待规划",
      "docs.eval.title": "评测方案",
      "docs.eval.sub": "评测集、指标与实施路径",
      "docs.testing.title": "测试指南",
      "docs.testing.sub": "各 package 验证命令",
      "docs.refs.title": "参考资料",
      "docs.refs.sub": "Pi 文档与来源项目",

      "footer.project": "项目",
      "footer.docs": "文档",
      "footer.ecosystem": "生态",
      "footer.bottom": "piex-dev/piex · MIT License · 基于",
      "footer.ghub": "GitHub",
      "footer.npm": "npm",
      "footer.roadmap": "路线图",
      "footer.design": "设计理念",
      "footer.arch": "架构概览",
      "footer.testing": "测试指南",
      "footer.pi": "Pi",
      "footer.omp": "oh-my-pi",
      "copy.hint": "点击复制",
    },
  };

  /* ---- language routing ---- */

  /** Current path language segment, or null on homepage / non-localized pages. */
  function pageLangFromPath() {
    var m = location.pathname.match(/^\/(zh|en)(?:\/|$)/);
    return m ? m[1] : null;
  }

  /**
   * Swap /{lang}/... → /{target}/...
   * Returns null when the current path is not language-prefixed (homepage).
   */
  function pathForLang(targetLang) {
    var path = location.pathname;
    if (/^\/(zh|en)(?:\/|$)/.test(path)) {
      return path.replace(/^\/(zh|en)/, "/" + targetLang);
    }
    return null;
  }

  /**
   * Rewrite absolute content links so they always carry the active language
   * prefix. Matches:
   *   /docs/...  /blogs/...  /packages/...
   *   /zh/docs/...  /en/blogs/...  /zh/packages/...
   * Leaves external, hash, and non-content paths alone.
   */
  function localizeContentHrefs(lang) {
    document.querySelectorAll("a[href]").forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href) return;
      // strip origin if absolute same-site
      var path = href;
      if (path.indexOf("https://piex.dev") === 0) {
        path = path.slice("https://piex.dev".length) || "/";
      }
      var m = path.match(
        /^\/(?:zh|en)?\/?(docs|blogs|packages)(\/[^#?]*)?([?#].*)?$/,
      );
      if (!m) return;
      var kind = m[1];
      var rest = m[2] || "/";
      var suffix = m[3] || "";
      if (rest.charAt(rest.length - 1) !== "/" && rest.indexOf(".") === -1) {
        rest += "/";
      }
      var next = "/" + lang + "/" + kind + rest + suffix;
      // preserve original host form
      if (href.indexOf("https://piex.dev") === 0) {
        a.setAttribute("href", "https://piex.dev" + next);
      } else {
        a.setAttribute("href", next);
      }
    });
  }

  function applyLang(lang) {
    if (!SUPPORTED[lang]) lang = DEFAULT_LANG;
    var t = T[lang];
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en-US";

    // Homepage title only (content pages set their own <title>)
    if (!pageLangFromPath()) {
      document.title =
        lang === "zh" ? "PieX — Pi 功能拓展集合" : "PieX — Pi Extensions";
    }

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      var val = t[key];
      if (val === undefined) return;
      if (el.hasAttribute("data-i18n-html")) {
        el.innerHTML = val;
      } else {
        el.textContent = val;
      }
    });

    document.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
      var spec = el.getAttribute("data-i18n-attr");
      var parts = spec.split(":");
      var attr = parts[0];
      var key = parts[1];
      var val = t[key];
      if (val !== undefined) el.setAttribute(attr, val);
    });

    document.querySelectorAll(".lang-switch button").forEach(function (btn) {
      var active = btn.getAttribute("data-lang") === lang;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
    });

    // Keep content links (docs|blogs|packages) in sync with the active language.
    localizeContentHrefs(lang);

    localStorage.setItem("piex-lang", lang);
    LANG = lang;
  }

  function switchLang(lang) {
    if (!SUPPORTED[lang]) return;
    localStorage.setItem("piex-lang", lang);

    var target = pathForLang(lang);
    if (target && target !== location.pathname) {
      location.href = target + location.search + location.hash;
      return;
    }
    applyLang(lang);
  }

  // expose for other scripts / debugging
  window.piexLang = function () {
    return LANG;
  };
  window.piexT = function (key) {
    return (T[LANG] && T[LANG][key]) || key;
  };
  window.piexSwitchLang = switchLang;

  // bind lang buttons (topbar + nav-sheet both carry .lang-switch)
  document.querySelectorAll(".lang-switch button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      switchLang(this.getAttribute("data-lang"));
    });
  });

  // initial apply:
  // - content page: prefer path language (authoritative), sync storage
  // - homepage: use saved/default LANG and rewrite content links
  var pathLang = pageLangFromPath();
  if (pathLang) {
    applyLang(pathLang);
  } else {
    applyLang(LANG);
  }

  /* ---- scroll animations ---- */
  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
        }
      });
    },
    { threshold: 0.1, rootMargin: "0px 0px -30px 0px" },
  );

  document.querySelectorAll(".anim-fade").forEach(function (el) {
    observer.observe(el);
  });

  /* ---- clipboard helper ---- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        resolve();
      } catch (e) {
        reject(e);
      }
      document.body.removeChild(ta);
    });
  }

  var switcher = document.querySelector("[data-install-switcher]");
  if (switcher) {
    var tabs = Array.prototype.slice.call(
      switcher.querySelectorAll("[data-install-tab]"),
    );
    var panels = switcher.querySelectorAll("[data-install-panel]");

    function activateTab(tab) {
      var name = tab.getAttribute("data-install-tab");
      tabs.forEach(function (t) {
        var on = t === tab;
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.setAttribute("tabindex", on ? "0" : "-1");
      });
      panels.forEach(function (p) {
        if (p.getAttribute("data-install-panel") === name)
          p.removeAttribute("hidden");
        else p.setAttribute("hidden", "");
      });
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () {
        activateTab(tab);
      });
      tab.addEventListener("keydown", function (e) {
        var idx = i;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          idx = (i + 1) % tabs.length;
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          idx = (i - 1 + tabs.length) % tabs.length;
        } else if (e.key === "Home") {
          e.preventDefault();
          idx = 0;
        } else if (e.key === "End") {
          e.preventDefault();
          idx = tabs.length - 1;
        } else {
          return;
        }
        tabs[idx].focus();
        activateTab(tabs[idx]);
      });
    });
  }

  /* ---- generic copy buttons ([data-copy-from]) ---- */
  document.querySelectorAll("[data-copy-from]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var sel = btn.getAttribute("data-copy-from");
      var src = document.querySelector(sel);
      if (!src) return;
      var text = (src.textContent || "").replace(/^\s*\$\s*/, "").trim();
      copyText(text).then(function () {
        var orig = btn.textContent;
        btn.classList.add("copied");
        btn.textContent = window.piexT("copy.copied");
        setTimeout(function () {
          btn.classList.remove("copied");
          btn.textContent = orig;
        }, 1500);
      });
    });
  });

  /* ---- copy install command on click (pkg-install cards) ---- */
  document.querySelectorAll(".pkg-install").forEach(function (el) {
    el.addEventListener("click", function () {
      var text = (el.textContent || "")
        .replace(/\s*click to copy\s*$/i, "")
        .replace(/\s*点击复制\s*$/i, "")
        .trim();
      if (!text) return;
      copyText(text).then(function () {
        showHint(el);
      });
    });
  });

  function showHint(el) {
    var hint =
      el.querySelector(".copied-hint") || document.createElement("span");
    hint.className = "copied-hint";
    hint.textContent = "copied ✓";
    if (!hint.parentNode) el.appendChild(hint);
    hint.classList.add("show");
    setTimeout(function () {
      hint.classList.remove("show");
    }, 1500);
  }

  /* ---- mobile nav-sheet drawer (pi.dev nav-sheet pattern) ---- */
  var toggle = document.getElementById("nav-toggle");
  var sheet = document.getElementById("navSheet");
  var backdrop = document.getElementById("navBackdrop");
  var closeBtn = document.getElementById("navSheetClose");

  function openSheet() {
    if (!sheet || !backdrop) return;
    sheet.classList.add("open");
    backdrop.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
    document.body.style.overflow = "hidden";
    // move focus into the sheet for keyboard/SR users
    var focusTarget = closeBtn || (sheet.querySelector ? sheet.querySelector("a") : null);
    if (focusTarget) focusTarget.focus();
  }

  // restoreFocus=false when closing via a nav link (let the anchor scroll win).
  function closeSheet(restoreFocus) {
    if (!sheet || !backdrop) return;
    if (!sheet.classList.contains("open")) return;
    sheet.classList.remove("open");
    backdrop.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    document.body.style.overflow = "";
    if (restoreFocus && toggle) toggle.focus();
  }

  if (toggle && sheet) {
    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      if (sheet.classList.contains("open")) closeSheet(true);
      else openSheet();
    });
  }
  if (backdrop) backdrop.addEventListener("click", function () { closeSheet(true); });
  if (closeBtn) closeBtn.addEventListener("click", function () { closeSheet(true); });
  if (sheet) {
    sheet.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { closeSheet(false); });
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      closeSheet(true);
      // also close the legacy topbar dropdown if present
      var nav = document.getElementById("nav-links");
      if (nav && nav.classList.contains("open")) {
        nav.classList.remove("open");
      }
    }
  });
})();
