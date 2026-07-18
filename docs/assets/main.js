/**
 * piex.dev — shared client scripts
 * Language toggle (EN/ZH), scroll animations, copy-on-click, mobile nav.
 */
(function () {
  /* ---- i18n ---- */

  var LANG = (function () {
    var saved = localStorage.getItem("piex-lang");
    return (saved === "zh" || saved === "en") ? saved : "en";
  })();

  var T = {
    en: {
      "hero.badge": "Built on <span class=\"s1\">Pi Extension API</span> · MIT",
      "hero.title": "<span class=\"accent\">PieX</span> — Extend Pi without forking",
      "hero.lead": "Core capabilities extracted from oh-my-pi, Claude Code, OpenCode and other coding agents, packaged as independent <code>@piex-dev/*</code> npm packages. Install with <code>pi install</code>.",
      "hero.cta1": "Get Started",
      "hero.cta2": "GitHub",
      "hero.term.title": "pi — piex",
      "hero.term.body": "<span class=\"prompt\">$</span> pi install npm:@piex-dev/hashline\n<span class=\"prompt\">$</span> pi install npm:@piex-dev/dap\n<span class=\"prompt\">$</span> pi install npm:@piex-dev/lsp\n<span class=\"comment\"># Override edit · debug · LSP. Upgrades with Pi.</span>",
      "stats.pkg": "Packages",
      "stats.lines": "Core Lines",
      "stats.adapters": "Debug Adapters",
      "stats.servers": "LSP Servers",
      "nav.why": "Philosophy",
      "nav.packages": "Packages",
      "nav.docs": "Docs",
      "nav.blog": "Blog",

      "why.title": "Design Philosophy",
      "why.desc": "Extend Pi without forking — on demand, understood, and measured.",
      "why.1.title": "Extend Pi, never fork",
      "why.1.desc": "omp forks the core and bundles everything; piex only extends via the official Extension API — never touching the core, upgrading with Pi.",
      "why.2.title": "On demand, switch freely",
      "why.2.desc": "Independent packages — install & remove at will. Minimal and in control: pay tokens only for what you use.",
      "why.3.title": "Know how it works",
      "why.3.desc": "Borrow the best from top agents — understand their designs, then rebuild as extensions you fully control.",
      "why.4.title": "Eval first",
      "why.4.desc": "Behavior-changing extensions ship with eval criteria & data. No measurement, no adoption.",
      "why.more": "Read the full design philosophy →",

      "blog.title": "Blog",
      "blog.desc": "Deep dives into Pi extension mechanics, coding agent design, and tooling.",
      "blog.post1.title": "Pi Extension Mechanism & Internals",
      "blog.post1.excerpt": "A deep dive into Pi's Extension API design philosophy, tool registration, hook system, and full extension loading pipeline.",

      "packages.title": "Packages",
      "packages.desc": "All packages are published as <code>@piex-dev/&lt;name&gt;</code>. See README in each package directory for details.",
      "pkg.hashline.desc": "Line-anchored, #TAG-verified hashline patch language — fewer mistakes, less token waste.",
      "pkg.dap.desc": "DAP debug adapter collection (14 adapters): breakpoints, stepping, variable inspection inside the agent session.",
      "pkg.lsp.desc": "Diagnostics, definitions, references, hover, symbols & formatting across 11 language servers.",
      "pkg.plan.desc": "Read-only exploration, plan drafting & step-by-step execution with progress tracking and tool locking.",
      "pkg.review.desc": "Interactive code review command & callable review tool covering diff / commit / branch comparisons.",
      "pkg.xai.desc": "xAI Grok OAuth subscription login: SuperGrok / X Premium+, with real-time model discovery.",
      "pkg.theme.desc": "High-contrast dark terminal theme with green/blue/red accents, distributed via pi.themes.",

      "docs.title": "Documentation",
      "docs.desc": "Synced with the <code>docs/</code> directory in the repository.",
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
      "hero.badge": "基于 <span class=\"s1\">Pi Extension API</span> · MIT",
      "hero.title": "<span class=\"accent\">PieX</span> — 不 fork Pi，按需扩展",
      "hero.lead": "从 oh-my-pi、Claude Code、OpenCode 等优秀 coding agent 提炼核心能力，封装为独立 <code>@piex-dev/*</code> package，<code>pi install</code> 即装即用。",
      "hero.cta1": "快速安装",
      "hero.cta2": "GitHub",
      "hero.term.title": "pi — piex",
      "hero.term.body": "<span class=\"prompt\">$</span> pi install npm:@piex-dev/hashline\n<span class=\"prompt\">$</span> pi install npm:@piex-dev/dap\n<span class=\"prompt\">$</span> pi install npm:@piex-dev/lsp\n<span class=\"comment\"># 覆盖 edit · debug · LSP，随 Pi 升级而升级</span>",
      "stats.pkg": "Packages",
      "stats.lines": "核心代码行",
      "stats.adapters": "调试适配器",
      "stats.servers": "LSP 服务器",
      "nav.why": "理念",
      "nav.packages": "Packages",
      "nav.docs": "文档",
      "nav.blog": "博客",

      "why.title": "设计理念",
      "why.desc": "充分拓展 pi 而非 fork，按需自由切换，知其所以然，评测优先。",
      "why.1.title": "充分拓展，而非 fork",
      "why.1.desc": "omp fork 内核并全量内置；piex 只做官方扩展——不碰内核，随 pi 升级而升级。",
      "why.2.title": "按需拓展，自由切换",
      "why.2.desc": "扩展相互独立、即装即卸；克制可控，只为用到的能力付出 token。",
      "why.3.title": "知其所以然",
      "why.3.desc": "取百家之长：借鉴主流 agent 的优秀设计，搞懂原理再以扩展引入，自己选择、自己掌控。",
      "why.4.title": "评测优先",
      "why.4.desc": "影响 agent 行为的扩展须有评测标准与数据支撑：无法度量，就不引入。",
      "why.more": "阅读完整设计理念 →",
      "blog.title": "博客",
      "blog.desc": "深入 Pi 扩展机制、coding agent 设计与工具链的技术文章。",
      "blog.post1.title": "Pi Extension 机制及工作原理",
      "blog.post1.excerpt": "深入剖析 Pi 的 Extension API 设计哲学、工具注册、Hook 系统和扩展加载全流程。",

      "packages.title": "Package 总览",
      "packages.desc": "npm 包名均为 <code>@piex-dev/&lt;name&gt;</code>，详情见仓库内各 package README。",
      "pkg.hashline.desc": "行锚定、#TAG 校验的 hashline 补丁语言，降低误改与 token 浪费。",
      "pkg.dap.desc": "DAP 调试适配器集合（14 个 adapter），在 agent 会话中断点、单步、查看变量。",
      "pkg.lsp.desc": "诊断、定义、引用、hover、符号与格式化，对接 11 个语言服务器。",
      "pkg.plan.desc": "只读探索、计划撰写与分步执行，带进度跟踪与工具锁定。",
      "pkg.review.desc": "交互式代码评审命令与 review 工具，覆盖 diff / commit / 分支对比。",
      "pkg.xai.desc": "xAI Grok OAuth 订阅登录，SuperGrok / X Premium+，含实时模型发现。",
      "pkg.theme.desc": "高对比暗终端主题，绿 / 蓝 / 红强调色，通过 pi.themes 分发。",

      "docs.title": "项目文档",
      "docs.desc": "与仓库 <code>docs/</code> 同源同步。",
      "docs.design.title": "设计理念",
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
    }
  };

  function applyLang(lang) {
    var t = T[lang];
    document.documentElement.lang = (lang === "zh") ? "zh-CN" : "en-US";
    document.title = (lang === "zh") ? "PieX — Pi 功能拓展集合" : "PieX — Pi Extensions";

    // update data-i18n elements
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      var val = t[key];
      if (val === undefined) return;
      // html translation (has tags inside)
      if (el.hasAttribute("data-i18n-html")) {
        el.innerHTML = val;
      } else {
        el.textContent = val;
      }
    });

    // update data-i18n-attr elements
    document.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
      var spec = el.getAttribute("data-i18n-attr");
      var parts = spec.split(":");
      var attr = parts[0];
      var key = parts[1];
      var val = t[key];
      if (val !== undefined) el.setAttribute(attr, val);
    });

    // update lang switches
    document.querySelectorAll(".lang-switch button").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-lang") === lang);
    });

    localStorage.setItem("piex-lang", lang);
    LANG = lang;
  }

  // expose globally for other scripts
  window.piexLang = function () { return LANG; };
  window.piexT = function (key) { return T[LANG][key] || key; };

  // bind lang buttons
  document.querySelectorAll(".lang-switch button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      applyLang(this.getAttribute("data-lang"));
    });
  });

  // initial apply
  applyLang(LANG);

  /* ---- scroll animations ---- */
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
      }
    });
  }, { threshold: 0.10, rootMargin: "0px 0px -30px 0px" });

  document.querySelectorAll(".anim-fade").forEach(function (el) {
    observer.observe(el);
  });

  /* ---- copy install command on click ---- */
  document.querySelectorAll(".pkg-install").forEach(function (el) {
    el.addEventListener("click", function () {
      var text = (el.textContent || "").replace(/\s*click to copy\s*$/i, "").replace(/\s*点击复制\s*$/i, "").trim();
      if (!text) return;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { showHint(el); });
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); showHint(el); } catch (_) {}
        document.body.removeChild(ta);
      }
    });
  });

  function showHint(el) {
    var hint = el.querySelector(".copied-hint") || document.createElement("span");
    hint.className = "copied-hint";
    hint.textContent = "copied ✓";
    if (!hint.parentNode) el.appendChild(hint);
    hint.classList.add("show");
    setTimeout(function () { hint.classList.remove("show"); }, 1500);
  }

  /* ---- mobile nav toggle ---- */
  var toggle = document.getElementById("nav-toggle");
  var nav = document.getElementById("nav-links");

  function closeNav() {
    if (!toggle || !nav) return;
    nav.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "\u2630";
  }

  function openNav() {
    if (!toggle || !nav) return;
    nav.classList.add("open");
    toggle.setAttribute("aria-expanded", "true");
    toggle.textContent = "\u2715";
  }

  if (toggle && nav) {
    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      if (nav.classList.contains("open")) closeNav();
      else openNav();
    });

    nav.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        closeNav();
      });
    });

    // click outside menu closes it
    document.addEventListener("click", function (e) {
      if (!nav.classList.contains("open")) return;
      if (nav.contains(e.target) || toggle.contains(e.target)) return;
      closeNav();
    });

    // Escape key closes it
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeNav();
    });
  }
})();
