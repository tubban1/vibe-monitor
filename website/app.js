/* Vibe Monitor site: no analytics, cookies, telemetry or backend calls. */
(() => {
  'use strict';
  const translations = {
    zh: {
      copy:'复制', navWhy:'为什么需要 Vibe',navHow:'工作方式',navFeatures:'核心能力',navPlans:'服务等级',navBeta:'体验 Beta',
      eyebrow:'为 AI 编程打造的架构智能层',heroLine1:'让 AI 飞速开发。',heroLine2:'让架构始终可控。',
      heroLead:'AI 正在持续添加功能。Vibe Monitor 帮你判断项目架构是否还能跟上发展速度，以及现在真正值得做什么。',
      heroCta:'了解私有 Beta',heroGithub:'查看 GitHub',noteOne:'源码留在本地',noteTwo:'面向 AI 编程工作流',
      sampleLabel:'构图示例 · 非实时扫描结果',sampleTitle:'架构演变趋势',metricOne:'结构健康',metricTwo:'变更压力',metricThree:'证据',findingTitle:'项目变更压力正在上升',findingDesc:'多项信号表明模块职责正在交叉重叠。',adviceTag:'建议行动',adviceText:'先厘清模块边界，暂时不建议拆成微服务。',chipOne:'基于证据，而非猜测',
      agentsLabel:'融入你熟悉的编程 Agent 工作流',
      whyLabel:'用户真正遇到的问题',whyTitle:'开发从未如此迅速，<br>理解项目却越来越难。',whyLead:'Vibe Coding 改变了项目成长方式。传统代码检查不足以告诉你，什么时候真正需要调整架构。',
      issueOneTitle:'功能不断堆积',issueOneBody:'新代码迅速增加，依赖关系、模块职责与隐性耦合也悄悄增长。',
      issueTwoTitle:'重构让人犹豫',issueTwoBody:'你感觉哪里出了问题，却不知道现在应该重构，还是继续交付功能。',
      issueThreeTitle:'缺乏长期视角',issueThreeBody:'单次报警无法说明项目在变好还是变坏，更无法解释过去一个月发生了什么。',
      howLabel:'分析方法',howTitle:'给每一个 AI 开发项目，<br>配一个架构顾问。',howLead:'将项目证据转化为有依据、可解释、低打扰的架构建议。',
      processOneTitle:'本地采集证据',processOneBody:'观察代码结构与历史变化，不需要上传源码。',
      processTwoTitle:'理解演变趋势',processTwoBody:'对比多次开发迭代，而不只看当前快照。',
      processThreeTitle:'判断真正的压力',processThreeBody:'结合多个独立信号与产品目标，决定是否需要行动。',
      processFourTitle:'追踪改进结果',processFourBody:'持续观察调整之后是否出现真正的改善。',
      featuresLabel:'回答开发者最关心的问题',featuresTitle:'减少无用报警，<br>看清下一步怎么做。',
      featureOne:'我的项目健康吗？',featureOneDesc:'结合上下文分析结构、耦合、可靠性、测试和安全证据。',
      featureTwo:'项目在变好还是变坏？',featureTwoDesc:'观察架构长期演变，而非简单的一次性评分。',
      featureThree:'现在应该做什么？',featureThreeDesc:'明确现在做、提前准备、暂时不要做，以及未来判断条件。',
      roadmap:'规划中',featureFour:'我的投入值得吗？',featureFourDesc:'未来将分析 AI Token、重复劳动与基础设施成本如何影响真实成果。',
      featureFive:'可以准备上线了吗？',featureFiveDesc:'了解下一阶段可能需要补齐的能力。完整上线准备度评估仍在完善。',
      privacyLabel:'以信任为基础',privacyTitle:'你的代码，<br>应该始终属于你。',privacyBody:'默认 Beta 遥测仅包含经过隐私最小化处理的架构信号，不会上传源码、Diff、提示词或密钥。加入测试前可以查看数据收集合同。',
      privacyLink:'阅读当前 Beta 隐私协议',privacyCard:'默认 BETA 遥测',privacyNoCode:'源代码与 Diff',privacyNoPrompt:'提示词与对话',privacyNoSecrets:'密钥与项目路径',privacySignals:'有限的架构结构化信号',privacySignalStatus:'已明确披露',privacyCaption:'当前私有 Beta 要求按照协议提交遥测数据。未来公开 Community 将采用独立制定的使用条款。',
      plansLabel:'同一个客户端 · 按需升级',plansTitle:'一个 Vibe Monitor，<br>陪伴项目成长。',plansLead:'只需要安装一次，沿用熟悉的 Agent 工作流。未来更高等级通过云端智能增强，而不是更换客户端。',
      plansNote:'以下为规划中的服务等级 · 价格和高级付费能力尚未正式开放。',
      communityTitle:'从看清项目开始。',communityDesc:'面向独立开发者的诚实、可用的开源本地分析基础。',
      communityF1:'13 类 Monitor 分析',communityF2:'本地证据与长期趋势',communityF3:'可解释的基础架构建议',comingSource:'开源客户端仍在准备中',
      proTitle:'更深入地理解项目。',proDesc:'同一套客户端，未来增加私有云端智能与个性化决策能力。',
      proF1:'包含 Community 全部能力',proF2:'高级校准与建议优先级',proF3:'云端辅助的长期项目洞察',comingPlan:'规划中 · 尚未开放购买',
      teamTitle:'让团队共同成长。',teamDesc:'让多人协作拥有统一的可视化、权限和决策依据。',
      teamF1:'包含 Pro 全部能力',teamF2:'组织权限与团队协作',teamF3:'统一用量与额度管理',
      betaLabel:'开始体验',betaTitle:'想知道你的项目，<br>正在变成什么样？',
      betaLead:'Vibe Monitor 目前处于私有 Beta 阶段，需要邀请码/激活码。公开开源客户端与付费服务等级仍在准备中。',
      betaRequest:'申请 Beta 测试资格',betaUpdates:'关注开源进度',installTitle:'私有 BETA 安装',installIntro:'取得激活码后，在终端运行：',
      installWarning:'需要 Node/npm 和 Beta 激活码。当前安装包为私有 Beta，不是已发布的 Community 开源客户端。',
      faqTitle:'一些你可能关心的问题。',
      faqQ1:'Vibe Monitor 已经开源了吗？',faqA1:'公开 GitHub 仓库已建立，但客户端源码与开源许可证尚未发布。当前 npm Beta 仍采用私有测试许可证。',
      faqQ2:'Vibe Monitor 会上传我的源码吗？',faqA2:'默认 Beta 遥测不包含源码、Diff、提示词、项目路径和密钥；会按照已披露的私有 Beta 协议收集有限的架构与使用信号。',
      faqQ3:'Vibe Monitor 会消耗 AI Token 吗？',faqA3:'本地结构分析不需要调用大语言模型。通过编程 Agent 进行可选的语义架构复核可能使用 Token，不包含在低开销本地分析的承诺之内。',
      faqQ4:'Community、Pro 和 Team 需要分别安装吗？',faqA4:'不需要。规划中三个服务等级共用一套客户端，通过官方云端提供相应服务能力；这些套餐尚未开放购买。',
      footerTag:'开发更快，理解更深。',footerPrivacy:'隐私说明',footerBeta:'Beta 测试',footerNote:'公开官网 · 客户端源码仍在准备开源'
    }
  };

  const strings = [...document.querySelectorAll('[data-i18n]')];
  const original = new Map(strings.map(el => [el, el.innerHTML]));
  const languageButton = document.getElementById('language');
  let locale = 'en';
  function applyLanguage(next) {
    locale = next === 'zh' ? 'zh' : 'en';
    for (const element of strings) {
      const key = element.getAttribute('data-i18n');
      if (locale === 'zh' && Object.prototype.hasOwnProperty.call(translations.zh, key)) {
        element.innerHTML = translations.zh[key];
      } else {
        element.innerHTML = original.get(element);
      }
    }
    const copyAria = document.getElementById('copy-install');
    if (copyAria) copyAria.setAttribute('aria-label', locale === 'zh' ? '复制安装命令' : 'Copy installation command');
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
    document.title = locale === 'zh'
      ? 'Vibe Monitor — AI 编程架构智能顾问'
      : 'Vibe Monitor — Architecture Intelligence for AI Coding';
    if (languageButton) {
      languageButton.textContent = locale === 'zh' ? 'EN' : '中文';
      languageButton.setAttribute('aria-label', locale === 'zh' ? 'Switch to English' : '切换到中文');
    }
    try { localStorage.setItem('vibe-site-language', locale); } catch (_) { /* privacy mode */ }
  }
  const storedLanguage = (() => {
    try { return localStorage.getItem('vibe-site-language'); } catch (_) { return null; }
  })();
  applyLanguage(storedLanguage || (/^zh\b/i.test(navigator.language || '') ? 'zh' : 'en'));
  languageButton?.addEventListener('click', () => applyLanguage(locale === 'en' ? 'zh' : 'en'));

  const menuButton = document.getElementById('menu-toggle');
  const mobileNav = document.getElementById('mobile-nav');
  function closeMenu() {
    if (!mobileNav || !menuButton) return;
    mobileNav.hidden = true;
    menuButton.setAttribute('aria-expanded', 'false');
  }
  menuButton?.addEventListener('click', () => {
    if (!mobileNav) return;
    mobileNav.hidden = !mobileNav.hidden;
    menuButton.setAttribute('aria-expanded', String(!mobileNav.hidden));
  });
  mobileNav?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });

  const copyButton = document.getElementById('copy-install');
  const installText = document.getElementById('install-command');
  copyButton?.addEventListener('click', async () => {
    const command = installText?.textContent?.trim();
    if (!command) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = command;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      try { copied = document.execCommand('copy'); } catch (_) { /* not supported */ }
      textarea.remove();
    }
    if (!copied) {
      window.prompt(locale === 'zh' ? '请复制安装命令：' : 'Copy installation command:', command);
      return;
    }
    copyButton.setAttribute('aria-label', locale === 'zh' ? '已复制安装命令' : 'Installation command copied');
    const label = copyButton.querySelector('[data-i18n="copy"]');
    if (label) label.textContent = locale === 'zh' ? '已复制 ✓' : 'Copied ✓';
    // Restore only on the next click or page navigation; no timers or background operations.
  });
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
