import { scanProject } from "./scanner.js";
import { findProjectRoot, projectIdentity } from "./project.js";
import { loadState, saveSnapshot, listRecentSnapshots } from "./history.js";
import { clamp, round, sha256, stageFromScore } from "./utils.js";
import { EVIDENCE_VERSION, STAGES, TEST_SCOPE_PATTERN } from "./constants.js";
import { resolveProductIntent } from "./intent.js";
import { architectureRoleForTarget, assessBoundaryEvidence, hasExistingRuntimeBoundary } from "./diagnostic-quality.js";
import { findingDetail } from "./finding-detail.js";
import { enrichFindingIntelligence } from "./finding-intelligence.js";
import { observeOutcomeCheckpoint } from "./outcomes.js";
import { detectEncodedIdContract } from "./contract-evidence.js";
import { scoringPolicyIdentity } from "./decision-policy.js";

function fileMap(snapshot) {
  return new Map((snapshot?.files || []).map(file => [file.path, file]));
}

function runtimeFiles(snapshot) {
  return (snapshot?.files || []).filter(file => !file.isTestFile && !file.isToolingFile);
}

function sumField(files, field) {
  return files.reduce((total, file) => total + (file[field] || 0), 0);
}

function signal(active, name, value, evidence, bucket = null, independenceGroup = null) {
  return { active: Boolean(active), name, value, evidence, bucket, independenceGroup: independenceGroup || name };
}

function findingId(projectId, family, target) {
  return "VM-" + sha256(projectId + "|" + family + "|" + target).slice(0, 10).toUpperCase();
}

function stageRank(stage) {
  return STAGES[stage]?.rank ?? 0;
}

const SIGNAL_PLAIN = {
  size: "它已经比较大",
  responsibility_concentration: "它同时管了很多不同的事情",
  dependency_fan_out_proxy: "很多其他代码都和它连在一起",
  function_concentration: "很多逻辑都集中在这里",
  logic_complexity: "这里面的判断、分支和处理流程已经比较多，改起来更容易漏掉情况",
  mixed_layer_work: "它同时在处理界面和比较底层的事情，很多不同层面的工作混在了一起",
  duplicate_logic: "项目里出现了多份很相似的成段逻辑，后面容易改一份漏一份",
  growth_velocity: "它最近还在明显变大",
  hotspot_frequency: "最近很多次加功能都会碰到它",
  change_coupling: "改它时经常还要一起改其他文件",
  dependency_cycles: "一些模块开始互相绕着依赖",
  max_fan_out: "一个地方需要知道太多其他模块",
  max_fan_in: "很多地方都依赖同一个核心位置",
  dependency_edge_growth: "模块之间的连接最近增长很快",
  platform_assumption_count: "项目里已经出现不少只适合特定系统或环境的写法",
  platform_assumption_spread: "这些环境相关写法已经散到多个文件",
  platform_assumption_growth: "这类环境绑定最近增长很快",
  credential_surface: "项目里需要管理的账号、密钥或凭证越来越多",
  public_endpoint_surface: "对外提供的接口越来越多",
  credential_surface_growth: "最近又增加了新的凭证使用位置",
  endpoint_surface_growth: "最近又增加了新的对外接口",
  shared_state_surface: "越来越多地方开始共享和修改同一批状态",
  shared_state_spread: "共享状态已经分散到不少文件里",
  state_data_mixing: "状态管理和数据保存开始混在多个地方",
  persistence_surface: "需要保存和同步的数据越来越多",
  state_surface_growth: "最近共享状态明显增加",
  persistence_growth: "最近需要持久保存的数据处理明显增加",
  async_work_spread: "异步流程已经散到很多地方",
  background_work_surface: "后台任务、定时任务或队列相关逻辑正在变多",
  parallel_process_surface: "项目开始同时启动多个进程或 worker",
  shared_state_parallelism: "并行任务开始碰到共享状态",
  coordination_gap: "并行工作已经出现，但几乎看不到防止重复或互相冲突的保护",
  async_growth: "最近异步和后台流程增长很快",
  retry_surface: "失败后的重试路径正在变多",
  missing_idempotency: "存在重试或后台任务，但还看不到明显的防重复处理",
  missing_recovery: "后台工作已经不少，但还看不到明确的恢复或续跑方式",
  missing_timeout_control: "项目会启动独立任务或进程，但超时/取消处理还很少",
  recovery_pressure_growth: "需要恢复和重试的工作量最近增长很快",
  project_change_surface: "项目已经有不少代码和变化面",
  sparse_test_surface: "仓库里能看到的自动测试相对很少",
  test_ratio_gap: "功能代码增长得比测试快很多",
  critical_paths_test_gap: "接口或后台任务已经不少，但对应的自动验证还比较少",
  tests_not_growing: "功能继续增长，但测试数量没有跟上",
  low_assertion_depth: "现有测试里的实际检查点比较少",
  operational_surface: "项目已经有不少接口、后台任务或独立执行流程",
  visibility_gap: "系统越来越复杂，但能看到运行过程的日志/追踪还比较少",
  correlation_gap: "出问题时还缺少把一次请求或任务从头串起来的标记",
  observability_growth_gap: "运行流程增长很快，但排错能力没有同步增加",
  hosted_delivery: "这个项目已经明显在按线上服务的方式运行",
  multi_user_intent: "项目已经出现多人或多租户使用的迹象",
  separate_runtime_work: "有些工作已经需要独立进程、worker 或后台执行",
  multiple_deploy_targets: "项目已经存在不止一种部署/运行目标",
  workspace_boundaries: "项目已经有多个相对独立的包或工作区",
  endpoint_surface_large: "对外接口已经不少",
  endpoint_spread: "接口已经分散到多个位置",
  contract_gap: "接口越来越多，但明确的数据格式/契约还没有同步跟上",
  endpoint_growth: "最近对外接口增长很快",
  compatibility_pressure: "为了兼容旧用法，项目里开始出现越来越多兼容处理",
  provider_count: "项目已经接入了多个外部服务",
  provider_spread: "这些外部服务的调用已经散到不少文件",
  provider_core_leak: "外部服务的专用写法开始直接进入核心业务代码",
  provider_branching: "代码里开始频繁根据不同服务商走不同分支",
  stack_fragmentation: "同一类事情开始同时使用多套不同工具或写法",
  duplicate_implementation_spread: "项目里出现了不少重复的成段实现",
  duplicate_implementation_growth: "重复实现最近还在继续增加",
  dependency_stack_growth: "项目依赖增长很快，做法也在持续分叉"
};

function plainSignalReasons(finding) {
  const priority = {
    growth_velocity: 100,
    hotspot_frequency: 95,
    change_coupling: 90,
    responsibility_concentration: 80,
    dependency_fan_out_proxy: 75,
    logic_complexity: 70,
    mixed_layer_work: 65,
    duplicate_logic: 60,
    function_concentration: 55,
    size: 50,
    state_surface_growth: 100,
    persistence_growth: 95,
    shared_state_parallelism: 100,
    coordination_gap: 98,
    async_growth: 95,
    missing_idempotency: 100,
    missing_recovery: 98,
    missing_timeout_control: 90,
    recovery_pressure_growth: 95,
    tests_not_growing: 100,
    critical_paths_test_gap: 95,
    sparse_test_surface: 90,
    test_ratio_gap: 85,
    visibility_gap: 100,
    observability_growth_gap: 98,
    correlation_gap: 90,
    operational_surface: 80
  };
  return [...finding.signals]
    .sort((a, b) => (priority[b.name] || 0) - (priority[a.name] || 0))
    .map(s => SIGNAL_PLAIN[s.name])
    .filter(Boolean)
    .slice(0, 4);
}

function plainFinding(finding) {
  const reasons = plainSignalReasons(finding);
  if (finding.family === "code-structure") {
    if (finding.architectureContext?.role === "composition-root") {
      return {
        title: "这是应用组合入口，先核实职责再决定是否拆分",
        why: "扫描识别到入口/装配角色（路径启发式）；启动和依赖装配本身可能自然集中在这里，文件压力信号不能单独证明职责边界有问题。",
        doNow: "保留生命周期和依赖装配；只在有独立变化证据时考虑隔离业务行为。",
        doNotDoYet: "不要为降低行数而拆分组合入口。",
        nextTrigger: "出现可由结构证据和重复变更共同支持的独立职责时再评估。"
      };
    }
    if (finding.architectureContext?.role === "external-runtime-integration") {
      return {
        title: "保留 Desktop 与 Runtime 的现有职责边界",
        why: "路径启发式将此文件识别为 Runtime 集成位置；静态压力信号不代表 Desktop 应承担 Runtime 的执行或恢复职责。",
        doNow: "继续通过现有集成边界调用 Runtime，并让 Runtime 保持执行与恢复权威。",
        doNotDoYet: "不要在 Desktop 重复实现任务执行、恢复或编排。",
        nextTrigger: "有具体证据表明集成协议或独立变化的适配逻辑造成维护问题时再调整。"
      };
    }
    if (finding.architectureContext?.role === "cloud-bridge") {
      return {
        title: "保留 Cloud Bridge 的协议边界",
        why: "路径启发式将此文件识别为 Cloud Bridge；协议转换与网络访问集中在桥接层可能是预期设计。",
        doNow: "先核实变化是否属于桥接职责，避免把产品行为重复放进调用方。",
        doNotDoYet: "不要仅凭混合层信号重做桥接或增加新的服务层。",
        nextTrigger: "具体业务逻辑独立变化且有结构证据支持时再考虑局部隔离。"
      };
    }
    if (finding.boundaryAssessment?.status === "insufficient-semantic-evidence") {
      return {
        title: "结构压力信号较高，但拆分依据不足",
        why: "当前扫描只有规模、词汇或控制流等压力指标，没有可支持职责边界判断的结构证据；这些指标不能证明现在需要重构。",
        doNow: "先观察；下一次改动触及此文件时核实具体职责和现有边界。",
        doNotDoYet: "不要仅依据文件大小或启发式计数拆分。",
        nextTrigger: "出现结构边界候选、反复独立变更或具体变更缺陷后再评估。"
      };
    }
    const title = stageRank(finding.stage) >= 4
      ? "这个文件现在最好别再继续堆功能"
      : "这个文件开始变得越来越难改";
    return {
      title,
      why: reasons.length
        ? reasons.join("；") + "。继续把新功能塞进这里，后面会更难改，也更容易牵连别的地方。"
        : "这里正在同时积累几个让后续修改变难的迹象。",
      doNow: stageRank(finding.stage) >= 4
        ? "如果这次还要改它，先把这次新增的那一小块功能放到清楚的独立模块里，再继续做。"
        : "继续开发可以，但尽量别再把新的、不相关的事情塞进这里。",
      doNotDoYet: "不要因为它大就全面重写，也不用急着上微服务或复杂架构。",
      nextTrigger: "如果后面几次加功能还是总要改这里，或者改一次仍经常牵连很多文件，就该继续拆。"
    };
  }
  if (finding.family === "dependency-coupling") {
    return {
      title: "项目里有些部分开始绑得太紧",
      why: reasons.length ? reasons.join("；") + "。这样以后改一处更容易带出一串修改。" : "模块之间的连接正在变复杂。",
      doNow: "新功能尽量沿现有边界放，不要再随手增加跨模块连接；如果已经互相绕着依赖，先拆最小的一处。",
      doNotDoYet: "还不需要因此改成微服务或引入一整套新架构。",
      nextTrigger: "如果循环依赖继续增加，或一次修改越来越常牵连多个模块，就需要进一步整理边界。"
    };
  }
  if (finding.family === "platform-portability") {
    return {
      title: "项目开始越来越依赖某个系统或运行环境",
      why: reasons.length ? reasons.join("；") + "。以后要支持别的电脑或环境时会越来越麻烦。" : "环境相关写法正在扩散。",
      doNow: "把这些系统判断尽量集中在少数底层位置，不要散进主要业务逻辑。",
      doNotDoYet: "还不用提前做复杂的跨平台调度系统。",
      nextTrigger: "当你真的要支持第二种系统/硬件，或者这些特殊判断继续扩散时，再进一步抽象。"
    };
  }
  if (finding.family === "security-surface") {
    return {
      title: "项目需要保护的入口和凭证正在变多",
      why: reasons.length ? reasons.join("；") + "。如果不早点管清楚，后面容易出现谁能访问什么都说不清的问题。" : "需要保护的访问入口正在增加。",
      doNow: "确认新增接口谁能访问、凭证放在哪里、权限是否只给到真正需要的范围。",
      doNotDoYet: "不用因为数量增加就立刻上一套很重的安全平台。",
      nextTrigger: "如果出现共享账号、更大权限、新的公开入口，或者不同用户/服务之间开始互相访问，就需要更严格地处理。"
    };
  }
  if (finding.family === "state-data") {
    return {
      title: stageRank(finding.stage) >= 4 ? "状态和数据开始需要明确分工了" : "状态和数据正在变得越来越难管",
      why: reasons.length ? reasons.join("；") + "。继续随处读写同一批状态或数据，后面更容易出现改一处另一处不同步。" : "状态和数据的使用方式正在变复杂。",
      doNow: "先明确谁负责保存、谁可以修改，以及哪些数据需要长期保存；这次新增的数据不要再随手散到多个地方。",
      doNotDoYet: "不要因为状态变多就立刻换一整套框架或把所有东西搬进数据库。",
      nextTrigger: "如果多个页面/任务都在改同一批状态，或者数据保存、同步、迁移开始频繁出现，就该进一步整理。"
    };
  }
  if (finding.family === "async-concurrency") {
    return {
      title: stageRank(finding.stage) >= 4 ? "后台任务已经不能只靠“跑起来就行”了" : "后台和并行任务开始变得难控制",
      why: reasons.length ? reasons.join("；") + "。任务一多，最容易出现重复执行、互相覆盖、停不下来或抢同一份资源。" : "异步和并行执行正在增加。",
      doNow: "这次新增后台任务时，把谁负责它、什么时候结束、失败后怎么办、会不会重复执行说清楚。",
      doNotDoYet: "不要一看到异步任务就立刻上复杂队列或分布式系统。",
      nextTrigger: "如果开始同时跑多个任务、共享同一份状态，或出现重复执行/互相覆盖，就需要正式的队列、锁或任务归属机制。"
    };
  }
  if (finding.family === "reliability-recovery") {
    return {
      title: stageRank(finding.stage) >= 4 ? "现在要开始考虑“出错以后怎么办”了" : "项目的失败和恢复路径开始跟不上功能增长",
      why: reasons.length ? reasons.join("；") + "。正常情况可能都能跑，但一旦断网、超时、重启或重复执行，就更容易留下半完成状态。" : "项目开始有更多需要恢复的执行流程。",
      doNow: "优先把这次任务的超时、重试、防重复和恢复方式补清楚，至少保证失败后知道该从哪里继续。",
      doNotDoYet: "不用为了可靠性一次性引入完整工作流平台或复杂容灾系统。",
      nextTrigger: "如果任务会长时间运行、会重试、会跨进程，或者已经出现丢任务/重复执行，就该进一步做持久化和恢复机制。"
    };
  }
  if (finding.family === "testing-verification") {
    return {
      title: stageRank(finding.stage) >= 4 ? "项目已经不太适合继续主要靠手测了" : "测试开始跟不上项目复杂度",
      why: reasons.length ? reasons.join("；") + "。功能继续增加时，只靠 AI 说“测试通过”或自己点几下，会越来越难覆盖真正容易坏的地方。" : "代码变化面正在超过现有自动验证能力。",
      doNow: "先给最近最常改、最容易牵连别处的关键流程补自动测试，不需要追求一次把覆盖率做满。",
      doNotDoYet: "不要为了一个数字去补大量没有价值的测试，也不用立刻追求 100% 覆盖率。",
      nextTrigger: "如果小改动经常带来回归、测试时间明显变长，或关键流程仍只能靠手动验证，就需要继续升级测试方式。"
    };
  }
  if (finding.family === "observability") {
    return {
      title: stageRank(finding.stage) >= 4 ? "项目已经需要更清楚地知道“现在到底在发生什么”" : "项目开始变得不好排错",
      why: reasons.length ? reasons.join("；") + "。流程一多以后，出错时只看到“失败了”，很难知道是哪一步、哪一次请求或哪个后台任务出了问题。" : "运行过程正在变复杂，但可见性还没有跟上。",
      doNow: "先给关键接口和后台任务加清楚的结构化日志，并让同一次请求/任务能从头追到尾。",
      doNotDoYet: "不用一上来就部署一整套昂贵监控平台；先让关键流程能被看懂。",
      nextTrigger: "如果开始频繁遇到“偶发、复现不了、只知道失败不知道哪一步”的问题，就需要进一步增加指标和链路追踪。"
    };
  }
  if (finding.family === "distribution-scaling") {
    if (finding.architecturalContext?.existingRuntimeBoundary) {
      return {
        title: "保留现有 Runtime 执行边界",
        why: "扫描识别到已有 Runtime 集成路径（路径启发式）；后台/进程信号不表示 Desktop 应重复承担执行或恢复。",
        doNow: "让 Desktop 通过现有集成边界协调工作，由 Runtime 继续负责任务执行与恢复。",
        doNotDoYet: "不要在 Desktop 复制任务执行、恢复或编排，也不要仅凭静态计数增加服务层。",
        nextTrigger: "有明确需求证明某个工作负载需要独立扩缩、发布或故障隔离时，再评估现有边界。"
      };
    }
    if (finding.decisionAssessment?.status === "product-intent-unconfirmed") {
      return {
        title: "运行时压力可观察，但产品边界尚未确认",
        why: "代码中有后台/进程活动信号；当前没有明确的部署、受众或规模意图，不能据此推断需要独立服务。",
        doNow: "先确认产品部署方式和工作负载的执行权威，再决定是否需要架构调整。",
        doNotDoYet: "在产品意图和独立运行需求确认前，不要拆服务或重复实现执行/恢复。",
        nextTrigger: "明确意图后，且有独立扩缩、发布或故障隔离证据时再干预。"
      };
    }
    return {
      title: "项目里开始出现需要不同运行方式的工作",
      why: reasons.length ? reasons.join("；") + "。这说明有些部分以后可能需要独立运行、重启或扩容，但现在还不代表应该拆微服务。" : "项目的运行方式开始分化。",
      doNow: "先把需要独立运行的后台/worker 和主应用之间的边界说清楚，保持接口简单。",
      doNotDoYet: "不要因为项目变大就直接拆微服务、上 Kubernetes 或服务网格。",
      nextTrigger: "当某一部分真的需要独立扩容、独立发布、独立恢复，或者故障不能再拖累主应用时，再考虑拆进程或服务。"
    };
  }
  if (finding.family === "api-contract") {
    if (finding.decisionAssessment?.status === "product-intent-unconfirmed") {
      return {
        title: "接口模式已观察到，但外部调用方尚未确认",
        why: "扫描看到了路由、兼容性或 schema 模式；这些模式不能单独证明存在外部消费者或商业 API 契约。",
        doNow: "先确认实际调用方和哪些输入输出格式已被依赖，再决定是否固定契约。",
        doNotDoYet: "不要仅凭路由数量、推断的 public/commercial 属性增加 API 版本或网关。",
        nextTrigger: "确认存在多个独立调用方、外部依赖或真实破坏性变更成本后再制定契约策略。"
      };
    }
    return {
      title: "接口开始多到需要把“说好的格式”固定下来",
      why: reasons.length ? reasons.join("；") + "。接口越多、调用方越多，临时改字段或返回格式就越容易把别的地方弄坏。" : "接口规模正在增长。",
      doNow: "先把最常用、最容易被别人依赖的接口输入输出固定下来，并让测试围绕这个格式跑。",
      doNotDoYet: "不用一上来做复杂 API 网关，也不用为了形式给所有内部函数做版本管理。",
      nextTrigger: "如果开始出现多个调用方、兼容旧版本、频繁改字段或外部客户接入，就该正式做版本和兼容策略。"
    };
  }
  if (finding.family === "provider-integration") {
    return {
      title: "外部服务的细节开始散进项目很多地方",
      why: reasons.length ? reasons.join("；") + "。以后换服务商、处理失败重试或统一权限时，会越来越难改。" : "第三方服务的接入方式正在扩散。",
      doNow: "把新增的服务商专用代码尽量放到一个清楚的接入层里，业务代码只关心它需要的能力。",
      doNotDoYet: "不用为了两三个 SDK 就做一套复杂插件平台或动态路由系统。",
      nextTrigger: "当同一种能力要支持第二个服务商，或者 provider 分支、鉴权、重试逻辑继续重复时，就值得做统一适配层。"
    };
  }
  if (finding.family === "ai-drift") {
    return {
      title: "项目里开始出现几套不同的做法",
      why: reasons.length ? reasons.join("；") + "。这种情况在多次 AI coding session 后很常见：功能都能跑，但后面的人越来越不知道应该沿用哪一种。" : "实现方式正在出现分叉。",
      doNow: "新功能优先沿用已经占主导的那一种做法，把明显重复的一小块收回同一个实现。",
      doNotDoYet: "不要为了“统一风格”全面重写整个项目，也不要一次替换所有库。",
      nextTrigger: "如果同一类功能继续出现第三、第四套实现，或者重复代码和依赖分叉还在增长，就该正式收敛约定。"
    };
  }
  return {
    title: finding.title,
    why: finding.whyItMatters,
    doNow: finding.doNow?.[0] || null,
    doNotDoYet: finding.doNotDoYet?.[0] || null,
    nextTrigger: finding.nextTrigger || null
  };
}

function findingTransitions(previousItems, currentFindings) {
  const previous = previousItems || {};
  const currentById = new Map(currentFindings.map(f => [f.id, f]));
  const changes = [];

  for (const finding of currentFindings) {
    const old = previous[finding.id];
    if (!old) {
      if (finding.requiresAttention) changes.push({
        type: "new_attention",
        id: finding.id,
        target: finding.target,
        family: finding.family,
        fromStage: null,
        toStage: finding.stage
      });
      continue;
    }
    const oldRank = stageRank(old.stage);
    const newRank = stageRank(finding.stage);
    if (newRank > oldRank) changes.push({
      type: "worsened",
      id: finding.id,
      target: finding.target,
      family: finding.family,
      fromStage: old.stage,
      toStage: finding.stage
    });
    else if (newRank < oldRank) changes.push({
      type: "improved",
      id: finding.id,
      target: finding.target,
      family: finding.family,
      fromStage: old.stage,
      toStage: finding.stage
    });
  }

  for (const [id, old] of Object.entries(previous)) {
    if (!currentById.has(id) && stageRank(old.stage) >= 2) {
      changes.push({
        // Absence can be a rename, omitted evidence, or rule evolution.
        type: "unverified_disappearance",
        id,
        target: old.target || "project",
        family: old.family || "unknown",
        fromStage: old.stage,
        toStage: null,
        verification: "required"
      });
    }
  }

  return changes;
}

function growthRatio(current, previous) {
  if (!previous || previous <= 0) return null;
  return current / previous;
}

function structuralSignature(snapshot) {
  if (!snapshot) return null;
  return JSON.stringify({
    sourceFiles: snapshot.summary?.sourceFiles || 0,
    totalLoc: snapshot.summary?.totalLoc || 0,
    publicEndpoints: snapshot.summary?.publicEndpoints || 0,
    apiContractSignals: snapshot.summary?.apiContractSignals || 0,
    providerFiles: snapshot.summary?.providerFiles || 0,
    providerNames: snapshot.summary?.providerNames || [],
    deploymentTargetCount: snapshot.summary?.deploymentTargetCount || 0,
    workspacePackages: snapshot.summary?.workspacePackages || 0,
    productionDependencies: snapshot.summary?.productionDependencies || 0,
    duplicateBlockGroups: snapshot.summary?.duplicateBlockGroups || 0,
    edgeCount: snapshot.graph?.edgeCount || 0,
    files: (snapshot.files || []).map(file => [
      file.path,
      file.loc,
      file.importCount,
      file.functionCount,
      file.decisionCount || 0,
      file.mixedLayerWork ? 1 : 0,
      file.duplicateBlockCount || 0,
      file.sharedStateSignals || 0,
      file.persistenceSignals || 0,
      file.backgroundJobSignals || 0,
      file.retrySignals || 0,
      file.timeoutSignals || 0,
      file.idempotencySignals || 0,
      file.coordinationSignals || 0,
      file.recoverySignals || 0,
      file.structuredLogSignals || 0,
      file.telemetrySignals || 0,
      file.correlationSignals || 0,
      file.assertionSignals || 0,
      file.responsibilities?.length || 0,
      file.structuralEvidence?.responsibilityClusterCount || 0,
      file.structuralEvidence?.boundaryCandidateCount || 0,
      file.structuralEvidence?.localCallEdges || 0
    ])
  });
}

function selectTrendReference(current, snapshots, windowSize = 4) {
  const currentSignature = structuralSignature(current);
  const distinct = [];
  let lastSignature = null;

  for (const snapshot of snapshots || []) {
    if (snapshot?.evidenceVersion !== current?.evidenceVersion) continue;
    const signature = structuralSignature(snapshot);
    if (!signature || signature === lastSignature) continue;
    lastSignature = signature;
    if (signature === currentSignature) continue;
    distinct.push(snapshot);
  }

  const recentDistinct = distinct.slice(-windowSize);
  return recentDistinct[recentDistinct.length - 1] || null;
}

function componentFinding(projectId, file, previousFile, gitCommitCount, decisionPolicy = null) {
  const ratio = growthRatio(file.loc, previousFile?.loc);
  const hotspotRatio = gitCommitCount ? file.gitCommits / gitCommitCount : 0;
  const cochangeCount = file.cochangePartners.filter(x => x.count >= 2).length;
  const resp = file.responsibilities.length;
  const structural = file.structuralEvidence?.unavailable ? null : file.structuralEvidence;
  const architectureContext = architectureRoleForTarget(file.path);

  let score = 0;
  const signals = [];

  const sizePoints = file.loc >= 4000 ? 25 : file.loc >= 2000 ? 20 : file.loc >= 1200 ? 15 : file.loc >= 800 ? 10 : file.loc >= 500 ? 5 : 0;
  score += sizePoints;
  signals.push(signal(sizePoints > 0, "size", file.loc, "Direct LOC observation", sizePoints >= 20 ? "high" : sizePoints ? "medium" : "low", "size"));

  const responsibilityPoints = clamp((resp - 2) * 6, 0, 24);
  score += responsibilityPoints;
  signals.push(signal(resp >= 4, "responsibility_concentration", resp, "Heuristic classification from code vocabulary", resp >= 7 ? "high" : resp >= 4 ? "medium" : "low", "responsibility"));

  // v0.2 observes mixed-layer work but does not score it yet. It is highly
  // correlated with responsibility concentration and needs beta calibration.
  signals.push(signal(file.mixedLayerWork, "mixed_layer_work", file.mixedLayerWork ? 1 : 0, "Heuristic overlap of presentation and infrastructure responsibilities", null, "responsibility"));

  const importPoints = file.importCount >= 25 ? 15 : file.importCount >= 16 ? 12 : file.importCount >= 10 ? 8 : file.importCount >= 6 ? 4 : 0;
  score += importPoints;
  signals.push(signal(file.importCount >= 10, "dependency_fan_out_proxy", file.importCount, "Direct import count; alias imports may be under-resolved", null, "dependency"));

  const effectiveFunctionCount = structural?.functionCount ?? file.functionCount;
  const functionPoints = effectiveFunctionCount >= 80 ? 10 : effectiveFunctionCount >= 50 ? 7 : effectiveFunctionCount >= 30 ? 4 : 0;
  score += functionPoints;
  signals.push(signal(
    effectiveFunctionCount >= 30,
    "function_concentration",
    effectiveFunctionCount,
    structural ? "Tree-sitter AST function-like declaration count" : "Fast-scan function-like declaration count",
    null,
    "logic"
  ));

  const decisionDensity = file.nonBlankLoc ? file.decisionCount / file.nonBlankLoc : 0;
  const complexityActive = file.decisionCount >= 60 || (file.decisionCount >= 30 && decisionDensity >= 0.04);
  // v0.2 captures logic-complexity and duplication evidence for explanation
  // and telemetry, but deliberately keeps both non-scoring until real beta
  // outcomes show that their thresholds are stable across languages/projects.
  signals.push(signal(complexityActive, "logic_complexity", file.decisionCount, "Heuristic control-flow concentration from branch/loop/error-path tokens", decisionDensity >= 0.08 ? "high" : complexityActive ? "medium" : "low", "logic"));

  signals.push(signal(file.duplicateBlockCount >= 8, "duplicate_logic", file.duplicateBlockCount, "Exact substantial multi-line blocks repeated across source files", file.duplicateBlockCount >= 20 ? "high" : file.duplicateBlockCount >= 8 ? "medium" : "low", "duplication"));

  const structuralBoundaryPoints = structural?.boundaryCandidateCount >= 2 ? 10 : structural?.boundaryCandidateCount >= 1 ? 6 : 0;
  score += structuralBoundaryPoints;
  signals.push(signal(
    structuralBoundaryPoints > 0,
    "structural_boundary",
    structural?.boundaryCandidateCount || 0,
    "Tree-sitter function clusters corroborated by local call-graph separation",
    structuralBoundaryPoints >= 10 ? "high" : structuralBoundaryPoints ? "medium" : "low",
    "structure"
  ));

  const growthPoints = ratio == null ? 0 : ratio >= 2 ? 18 : ratio >= 1.5 ? 14 : ratio >= 1.25 ? 10 : ratio >= 1.1 ? 5 : 0;
  score += growthPoints;
  signals.push(signal(ratio != null && ratio >= 1.25, "growth_velocity", ratio == null ? null : round((ratio - 1) * 100, 1), "Derived from current and previous session LOC", ratio >= 1.5 ? "high" : "medium", "growth"));

  const hotspotPoints = hotspotRatio >= 0.7 ? 10 : hotspotRatio >= 0.45 ? 7 : hotspotRatio >= 0.25 ? 4 : 0;
  score += hotspotPoints;
  signals.push(signal(hotspotRatio >= 0.45 && gitCommitCount >= 5, "hotspot_frequency", round(hotspotRatio, 2), "Derived from recent Git commits", null, "history"));

  const cochangePoints = cochangeCount >= 5 ? 10 : cochangeCount >= 3 ? 7 : cochangeCount >= 1 ? 3 : 0;
  score += cochangePoints;
  signals.push(signal(cochangeCount >= 3, "change_coupling", cochangeCount, "Derived from recent Git co-change history", null, "coupling"));

  const uncalibrated = new Set(["mixed_layer_work", "logic_complexity", "duplicate_logic"]);
  const supporting = new Set(
    signals
      .filter(s => s.active && !uncalibrated.has(s.name))
      .map(s => s.independenceGroup)
  ).size;
  const finalScore = clamp(score);
  let stage = stageFromScore(finalScore, supporting, decisionPolicy, "code-structure");

  // Test code has its own verification-architecture concerns. A large test file
  // must not by itself tell the product code to componentize. Keep it as watch-only
  // until the dedicated Testing & Verification monitor exists.
  const isTestScope = TEST_SCOPE_PATTERN.test(file.path);
  if (isTestScope && stageRank(stage) >= 3) stage = "S2";

  if (stage === "S1") return null;
  const boundary = structural?.boundaryCandidates?.[0] || null;
  const agentAction = stageRank(stage) >= 3 && boundary && architectureContext.role === "unclassified" ? {
    mode: "next-change-guidance",
    autoExecute: false,
    target: file.path,
    suggestedBoundary: boundary.group,
    evidence: [
      `Tree-sitter found ${structural.responsibilityClusterCount} responsibility clusters across ${structural.functionCount} function-like units.`,
      `${boundary.group} has ${boundary.functionCount} functions with ${boundary.internalCalls} internal and ${boundary.crossCalls} cross-cluster local calls.`,
      `Recent Git evidence shows ${file.gitCommits} touches and ${cochangeCount} repeated co-change partners.`
    ],
    instruction: `When the next feature touches ${file.path}, keep new ${boundary.group} behavior behind a focused internal boundary. Move only the behavior touched by that feature, and preserve the current public API and UI behavior.`,
    doNot: [
      "Do not rewrite the whole file.",
      "Do not split code only to reduce LOC.",
      "Do not introduce a new state framework, service boundary, or orchestration layer unless separate evidence requires it."
    ],
    verify: [
      "Run existing characterization/tests around the touched behavior.",
      "At the next Vibe checkpoint, verify that structural pressure and change coupling are stable or falling."
    ]
  } : null;
  const semanticReview = stageRank(stage) >= 3 && (!structural || (structural.responsibilityClusterCount >= 2 && structural.boundaryCandidateCount === 0)) ? {
    recommended: true,
    reason: structural
      ? "Structural parsing sees multiple responsibility clusters, but the local call graph does not show a clean low-coupling boundary."
      : "The current scan has no structural boundary evidence for this file; verify its responsibilities before proposing a split.",
    questions: [
      "Do these responsibilities represent stable domain boundaries or one cohesive workflow?",
      "Would separating them reduce future change coupling without adding coordination overhead?",
      "Can the next feature use an existing boundary instead of creating a new abstraction?"
    ],
    evidence: structural ? {
      functionCount: structural.functionCount,
      responsibilityClusterCount: structural.responsibilityClusterCount,
      localCallEdges: structural.localCallEdges
    } : { unavailable: true, reason: "structural-analysis-not-available-for-this-file-in-this-scan" }
  } : null;
  const boundaryAssessment = assessBoundaryEvidence({
    stage,
    structuralEvidence: structural,
    architectureRole: architectureContext.role
  });
  const recommendations = architectureContext.role !== "unclassified"
    ? {
        doNow: [architectureContext.role === "composition-root"
          ? "Keep lifecycle wiring and dependency composition at this root; verify independent domain behavior before extracting it."
          : architectureContext.role === "external-runtime-integration"
            ? "Keep Desktop-to-Runtime communication behind this integration boundary; preserve Runtime as the execution and recovery authority."
            : "Keep cloud protocol translation behind this bridge; verify any independently changing product behavior before extracting it."],
        prepare: ["Use the existing boundary and move only behavior with direct semantic evidence and a separate change reason."],
        doNotDoYet: ["Do not duplicate task execution, recovery, or orchestration responsibilities across an existing runtime boundary."],
        nextTrigger: "A specific independently changing responsibility is supported by structural evidence and recurring change history."
      }
    : boundaryAssessment.status === "insufficient-semantic-evidence"
      ? {
          doNow: ["Treat this as an observation; verify the actual responsibilities before proposing a component boundary."],
          prepare: ["On the next change to this file, identify the behavior that changes independently and check existing module boundaries."],
          doNotDoYet: ["Do not split this file or extract a service based on size, vocabulary counts, or control-flow counts alone."],
          nextTrigger: "A structural boundary candidate, repeated independent changes, or concrete change-related defects provide evidence for intervention."
        }
    : stageRank(stage) >= 4
    ? {
        doNow: ["Create bounded internal component/module boundaries before adding another unrelated responsibility.", "Preserve behavior with characterization tests around the affected boundary."],
        prepare: ["Define ownership and stable internal interfaces.", "Measure whether change coupling and blast radius fall after the split."],
        doNotDoYet: ["Do not extract a microservice solely because this file/module is large.", "Do not perform unrelated cleanup in the same transition."],
        nextTrigger: "Another independent responsibility, further co-change growth, or continued fan-out growth."
      }
    : {
        doNow: ["Keep new responsibilities from accumulating in this unit where practical."],
        prepare: ["Identify likely ownership boundaries.", "Add characterization tests before a future decomposition."],
        doNotDoYet: ["No service extraction is justified from these signals alone."],
        nextTrigger: "Sustained growth plus rising coupling/hotspot evidence."
      };

  return {
    id: findingId(projectId, "code-structure", file.path),
    family: "code-structure",
    stage,
    score: finalScore,
    target: file.path,
    title: "Componentization pressure is rising",
    evidenceQuality: structural
      ? (previousFile ? "direct+structural+derived+heuristic" : "direct+structural+heuristic")
      : (previousFile ? "direct+derived+heuristic" : "direct+heuristic"),
    signals: signals.filter(s => s.active),
    architectureContext,
    boundaryAssessment,
    structuralEvidence: structural ? {
      functionCount: structural.functionCount,
      responsibilityClusterCount: structural.responsibilityClusterCount,
      localCallEdges: structural.localCallEdges,
      boundaryCandidateCount: structural.boundaryCandidateCount,
      boundaryCandidates: structural.boundaryCandidates
    } : null,
    whyItMatters: "This unit is accumulating multiple independent pressure signals; future feature work may become more coupled and harder to verify.",
    ...recommendations,
    agentAction,
    semanticReview,
    confidence: clamp(0.45 + supporting * 0.08 + (previousFile ? 0.1 : 0) + (structuralBoundaryPoints ? 0.05 : 0), 0, 0.95),
    standards: ["ISO/IEC 25010:2023 maintainability/modularity baseline"],
    heuristicDisclosure: structural
      ? "Stage thresholds and responsibility labels remain Vibe heuristics. Tree-sitter improves structural precision but does not prove that a semantic boundary should be split."
      : "Stage thresholds and responsibility classification are Vibe Monitor heuristics, not ISO thresholds."
  };
}

function couplingFinding(projectId, current, previous, decisionPolicy = null) {
  const graph = current.graph;
  const prev = previous?.graph;
  const edgeGrowth = prev?.edgeCount ? graph.edgeCount / prev.edgeCount : null;
  const s = [
    signal(graph.cycleCount > 0, "dependency_cycles", graph.cycleCount, "Derived local import graph"),
    signal(graph.maxFanOut >= 8, "max_fan_out", graph.maxFanOut, "Derived local import graph"),
    signal(graph.maxFanIn >= 8, "max_fan_in", graph.maxFanIn, "Derived local import graph"),
    signal(edgeGrowth != null && edgeGrowth >= 1.25, "dependency_edge_growth", edgeGrowth == null ? null : round((edgeGrowth - 1) * 100, 1), "Derived across sessions")
  ];
  let score = 0;
  score += Math.min(35, graph.cycleCount * 10);
  score += graph.maxFanOut >= 15 ? 25 : graph.maxFanOut >= 8 ? 15 : 0;
  score += graph.maxFanIn >= 15 ? 20 : graph.maxFanIn >= 8 ? 12 : 0;
  score += edgeGrowth >= 1.5 ? 20 : edgeGrowth >= 1.25 ? 12 : 0;
  const supporting = s.filter(x => x.active).length;
  const stage = stageFromScore(clamp(score), supporting, decisionPolicy, "dependency-coupling");
  if (stage === "S1") return null;
  return {
    id: findingId(projectId, "dependency-coupling", "project"),
    family: "dependency-coupling",
    stage,
    score: clamp(score),
    target: "project",
    title: "Dependency coupling pressure is rising",
    evidenceQuality: previous ? "derived" : "direct+derived",
    signals: s.filter(x => x.active),
    whyItMatters: "Increasing dependency breadth or cycles can increase change blast radius and make boundaries harder to evolve.",
    doNow: stageRank(stage) >= 4 ? ["Break dependency cycles at the smallest stable boundary."] : ["Avoid adding new cross-boundary dependencies without a clear ownership reason."],
    prepare: ["Identify dependency direction and ownership rules.", "Stabilize interfaces before considering deployment separation."],
    doNotDoYet: ["Do not introduce microservices, a service mesh, or a new orchestration layer from coupling evidence alone."],
    nextTrigger: "Persistent cycle growth, materially larger fan-in/fan-out, or repeated co-change across intended boundaries.",
    confidence: clamp(0.5 + supporting * 0.1, 0, 0.9),
    standards: ["ISO/IEC 25010:2023 maintainability/modularity baseline", "ISO/IEC/IEEE 42010 architecture-description discipline"],
    heuristicDisclosure: "Graph thresholds are Vibe Monitor calibration heuristics."
  };
}

function portabilityFinding(projectId, current, previous, decisionPolicy = null) {
  const count = current.summary.platformAssumptions;
  const previousCount = previous?.summary?.platformAssumptions ?? null;
  const growth = previousCount > 0 ? count / previousCount : null;
  const affectedFiles = current.files.filter(f => f.platformAssumptions > 0).length;
  const s = [
    signal(count >= 4, "platform_assumption_count", count, "Direct platform/runtime token observations"),
    signal(affectedFiles >= 3, "platform_assumption_spread", affectedFiles, "Derived number of source files with platform assumptions"),
    signal(growth != null && growth >= 1.5, "platform_assumption_growth", round((growth - 1) * 100, 1), "Derived across sessions")
  ];
  let score = count >= 20 ? 45 : count >= 10 ? 30 : count >= 4 ? 18 : 0;
  score += affectedFiles >= 8 ? 25 : affectedFiles >= 3 ? 15 : 0;
  score += growth >= 2 ? 25 : growth >= 1.5 ? 15 : 0;
  const supporting = s.filter(x => x.active).length;
  const stage = stageFromScore(clamp(score), supporting, decisionPolicy, "platform-portability");
  if (stage === "S1") return null;
  return {
    id: findingId(projectId, "platform-portability", "project"),
    family: "platform-portability",
    stage,
    score: clamp(score),
    target: "project",
    title: "Platform-specific assumptions are spreading",
    evidenceQuality: previous ? "direct+derived" : "direct",
    signals: s.filter(x => x.active),
    whyItMatters: "Platform branches that spread through product logic make future OS/CPU/GPU support more expensive.",
    doNow: ["Keep platform checks close to infrastructure boundaries rather than business logic."],
    prepare: ["Define a capability matrix before a second execution target becomes mandatory.", "Consider a provider/capability interface if target diversity becomes a real requirement."],
    doNotDoYet: ["Do not build a generalized hardware scheduler unless multiple workload/target classes actually exist."],
    nextTrigger: "A second supported OS/architecture/accelerator becomes a declared requirement or platform branches continue spreading.",
    confidence: clamp(0.45 + supporting * 0.12, 0, 0.85),
    standards: ["ISO/IEC 25010:2023 flexibility/adaptability baseline"],
    heuristicDisclosure: "Platform token counts are a heuristic proxy; product intent is required for a transition decision."
  };
}

function securityFinding(projectId, current, previous, decisionPolicy = null) {
  const creds = current.summary.credentialSurface;
  const endpoints = current.summary.publicEndpoints;
  const prevCreds = previous?.summary?.credentialSurface ?? 0;
  const prevEndpoints = previous?.summary?.publicEndpoints ?? 0;
  const s = [
    signal(creds >= 3, "credential_surface", creds, "Credential-related references; values are never persisted"),
    signal(endpoints >= 5, "public_endpoint_surface", endpoints, "Direct route/endpoint pattern count"),
    signal(creds > prevCreds && previous != null, "credential_surface_growth", creds - prevCreds, "Derived across sessions"),
    signal(endpoints > prevEndpoints && previous != null, "endpoint_surface_growth", endpoints - prevEndpoints, "Derived across sessions")
  ];
  let score = creds >= 12 ? 35 : creds >= 6 ? 24 : creds >= 3 ? 14 : 0;
  score += endpoints >= 15 ? 30 : endpoints >= 8 ? 20 : endpoints >= 5 ? 12 : 0;
  score += creds > prevCreds ? 10 : 0;
  score += endpoints > prevEndpoints ? 10 : 0;
  const supporting = s.filter(x => x.active).length;
  const stage = stageFromScore(clamp(score), supporting, decisionPolicy, "security-surface");
  if (stage === "S1") return null;
  return {
    id: findingId(projectId, "security-surface", "project"),
    family: "security-surface",
    stage,
    score: clamp(score),
    target: "project",
    title: "Security surface is expanding",
    evidenceQuality: previous ? "direct+derived" : "direct",
    signals: s.filter(x => x.active),
    whyItMatters: "More credentials and externally reachable endpoints increase the importance of explicit trust, authorization, and secret ownership boundaries.",
    doNow: ["Keep credentials scoped and out of source control.", "Ensure new externally reachable endpoints have explicit authentication/authorization decisions."],
    prepare: ["Document trust boundaries and credential ownership before the surface expands further."],
    doNotDoYet: ["Do not add heavyweight security infrastructure solely because endpoint count increased."],
    nextTrigger: "New trust boundaries, broader privileges, shared credentials, or materially larger public surface.",
    confidence: clamp(0.4 + supporting * 0.12, 0, 0.85),
    standards: ["NIST SP 800-218 SSDF", "OWASP SAMM"],
    heuristicDisclosure: "Pattern counts do not prove a vulnerability; this finding tracks architectural security surface, not exploitability."
  };
}

function stateDataFinding(projectId, current, previous, decisionPolicy = null) {
  const files = runtimeFiles(current);
  const prevFiles = runtimeFiles(previous);
  const shared = sumField(files, "sharedStateSignals");
  const persistence = sumField(files, "persistenceSignals");
  const schema = sumField(files, "schemaSignals");
  const prevShared = sumField(prevFiles, "sharedStateSignals");
  const prevPersistence = sumField(prevFiles, "persistenceSignals");
  const sharedFiles = files.filter(file => file.sharedStateSignals > 0).length;
  const persistenceFiles = files.filter(file => file.persistenceSignals > 0).length;
  const mixedFiles = files.filter(file =>
    (file.sharedStateSignals > 0 || file.responsibilities.includes("state")) &&
    (file.persistenceSignals > 0 || file.responsibilities.includes("data"))
  ).length;
  const sharedGrowth = prevShared > 0 ? shared / prevShared : null;
  const persistenceGrowth = prevPersistence > 0 ? persistence / prevPersistence : null;

  const s = [
    signal(shared >= 4, "shared_state_surface", shared, "Shared/global state pattern count"),
    signal(sharedFiles >= 3, "shared_state_spread", sharedFiles, "Number of files participating in shared state"),
    signal(mixedFiles >= 2, "state_data_mixing", mixedFiles, "Files mixing shared state and persistence/data concerns"),
    signal(persistence >= 5, "persistence_surface", persistence, "Persistence/storage pattern count"),
    signal(sharedGrowth != null && sharedGrowth >= 1.5, "state_surface_growth", round((sharedGrowth - 1) * 100, 1), "Derived across sessions"),
    signal(persistenceGrowth != null && persistenceGrowth >= 1.5, "persistence_growth", round((persistenceGrowth - 1) * 100, 1), "Derived across sessions"),
    signal(schema >= 3 && persistenceFiles >= 2, "schema_growth", schema, "Schema/migration-related patterns")
  ];

  let score = 0;
  score += shared >= 16 ? 24 : shared >= 8 ? 16 : shared >= 4 ? 10 : 0;
  score += sharedFiles >= 8 ? 20 : sharedFiles >= 4 ? 14 : sharedFiles >= 3 ? 8 : 0;
  score += mixedFiles >= 5 ? 20 : mixedFiles >= 3 ? 14 : mixedFiles >= 2 ? 8 : 0;
  score += persistence >= 15 ? 16 : persistence >= 8 ? 12 : persistence >= 5 ? 8 : 0;
  score += sharedGrowth >= 2 ? 16 : sharedGrowth >= 1.5 ? 10 : 0;
  score += persistenceGrowth >= 2 ? 14 : persistenceGrowth >= 1.5 ? 9 : 0;
  score += schema >= 8 ? 10 : schema >= 3 ? 6 : 0;

  const supporting = s.filter(item => item.active).length;
  const stage = stageFromScore(clamp(score), supporting, decisionPolicy, "state-data");
  if (stage === "S1") return null;
  return {
    id: findingId(projectId, "state-data", "project"),
    family: "state-data",
    stage,
    score: clamp(score),
    target: "project",
    title: "State and data ownership pressure is rising",
    evidenceQuality: previous ? "direct+derived+heuristic" : "direct+heuristic",
    signals: s.filter(item => item.active),
    whyItMatters: "Shared state and persistence spread can make synchronization and ownership harder to reason about.",
    doNow: ["Clarify which component owns shared state and which data must be durable before adding another writer."],
    prepare: ["Separate transient UI state from durable product data where the boundary is already visible."],
    doNotDoYet: ["Do not replace the state stack or move everything into a database from count evidence alone."],
    nextTrigger: "More independent writers, repeated synchronization bugs, migration growth, or the same state being coordinated across background work.",
    confidence: clamp(0.42 + supporting * 0.09 + (previous ? 0.08 : 0), 0, 0.88),
    standards: ["ISO/IEC 25010:2023 maintainability/modularity baseline", "ISO/IEC/IEEE 42010:2022 architecture viewpoints"],
    heuristicDisclosure: "State/persistence pattern counts are proxies; they do not prove incorrect state architecture."
  };
}

function asyncConcurrencyFinding(projectId, current, previous, decisionPolicy = null) {
  const files = runtimeFiles(current);
  const prevFiles = runtimeFiles(previous);
  const asyncCount = sumField(files, "asyncPaths");
  const asyncFiles = files.filter(file => file.asyncPaths > 0).length;
  const background = sumField(files, "backgroundJobSignals");
  const processes = sumField(files, "processSignals");
  const shared = sumField(files, "sharedStateSignals");
  const coordination = sumField(files, "coordinationSignals") + sumField(files, "idempotencySignals");
  const prevAsync = sumField(prevFiles, "asyncPaths");
  const asyncGrowth = prevAsync > 0 ? asyncCount / prevAsync : null;
  const concurrentSurface = background + processes;

  const s = [
    signal(asyncCount >= 30 && asyncFiles >= 6, "async_work_spread", asyncFiles, "Async paths spread across source files"),
    signal(background >= 4, "background_work_surface", background, "Background job/scheduler/queue patterns"),
    signal(processes >= 2, "parallel_process_surface", processes, "Child process/worker patterns"),
    signal(concurrentSurface >= 5 && shared >= 3, "shared_state_parallelism", shared, "Parallel/background work combined with shared state"),
    signal(concurrentSurface >= 6 && coordination === 0, "coordination_gap", concurrentSurface, "Parallel/background work with no observed coordination/idempotency patterns"),
    signal(asyncGrowth != null && asyncGrowth >= 1.5, "async_growth", round((asyncGrowth - 1) * 100, 1), "Derived async-path growth across sessions")
  ];

  let score = 0;
  score += asyncCount >= 100 && asyncFiles >= 12 ? 16 : asyncCount >= 30 && asyncFiles >= 6 ? 10 : 0;
  score += background >= 12 ? 20 : background >= 6 ? 16 : background >= 4 ? 12 : 0;
  score += processes >= 6 ? 18 : processes >= 3 ? 14 : processes >= 2 ? 9 : 0;
  score += concurrentSurface >= 5 && shared >= 3 ? 22 : 0;
  score += concurrentSurface >= 6 && coordination === 0 ? 20 : 0;
  score += asyncGrowth >= 2 ? 16 : asyncGrowth >= 1.5 ? 10 : 0;

  const supporting = s.filter(item => item.active).length;
  const stage = stageFromScore(clamp(score), supporting, decisionPolicy, "async-concurrency");
  if (stage === "S1") return null;
  return {
    id: findingId(projectId, "async-concurrency", "project"),
    family: "async-concurrency",
    stage,
    score: clamp(score),
    target: "project",
    title: "Async/concurrent execution pressure is rising",
    evidenceQuality: previous ? "direct+derived+heuristic" : "direct+heuristic",
    signals: s.filter(item => item.active),
    whyItMatters: "More parallel and background execution increases the chance of duplicate work, conflicting ownership, and tasks that cannot be stopped cleanly.",
    doNow: ["Make task ownership, completion, cancellation, and duplicate-work behavior explicit for new background work."],
    prepare: ["Introduce coordination only around the resources that actually have competing writers."],
    doNotDoYet: ["Do not introduce a distributed queue or orchestration platform just because async code exists."],
    nextTrigger: "Multiple tasks touching shared state, duplicate execution, resource contention, or jobs that outlive the request/session that created them.",
    confidence: clamp(0.4 + supporting * 0.1 + (previous ? 0.08 : 0), 0, 0.9),
    standards: ["ISO/IEC 25010:2023 reliability/maintainability baseline", "CNCF cloud-native architecture guidance where distributed execution is justified"],
    heuristicDisclosure: "Static async/process patterns cannot prove a race condition; they indicate coordination pressure."
  };
}

function reliabilityRecoveryFinding(projectId, current, previous, decisionPolicy = null) {
  const files = runtimeFiles(current);
  const prevFiles = runtimeFiles(previous);
  const background = sumField(files, "backgroundJobSignals");
  const processes = sumField(files, "processSignals");
  const retries = sumField(files, "retrySignals");
  const timeouts = sumField(files, "timeoutSignals");
  const idempotency = sumField(files, "idempotencySignals");
  const recovery = sumField(files, "recoverySignals");
  const workSurface = background + processes;
  const prevWork = sumField(prevFiles, "backgroundJobSignals") + sumField(prevFiles, "processSignals");
  const workGrowth = prevWork > 0 ? workSurface / prevWork : null;

  const s = [
    signal(workSurface >= 5, "long_running_work_surface", workSurface, "Background/process execution patterns"),
    signal(retries >= 3, "retry_surface", retries, "Retry/backoff patterns"),
    signal((retries >= 2 || background >= 5) && idempotency === 0, "missing_idempotency", retries + background, "Retry/background work with no observed idempotency/deduplication patterns"),
    signal(background >= 5 && recovery === 0, "missing_recovery", background, "Background work with no observed checkpoint/resume/reconciliation patterns"),
    signal(processes >= 2 && timeouts === 0, "missing_timeout_control", processes, "Process execution with no observed timeout/cancellation patterns"),
    signal(workGrowth != null && workGrowth >= 1.5, "recovery_pressure_growth", round((workGrowth - 1) * 100, 1), "Derived growth of background/process work")
  ];

  let score = 0;
  score += workSurface >= 12 ? 18 : workSurface >= 5 ? 12 : 0;
  score += retries >= 8 ? 14 : retries >= 3 ? 9 : 0;
  score += (retries >= 2 || background >= 5) && idempotency === 0 ? 22 : 0;
  score += background >= 5 && recovery === 0 ? 22 : 0;
  score += processes >= 2 && timeouts === 0 ? 16 : 0;
  score += workGrowth >= 2 ? 16 : workGrowth >= 1.5 ? 10 : 0;

  const supporting = s.filter(item => item.active).length;
  const stage = stageFromScore(clamp(score), supporting, decisionPolicy, "reliability-recovery");
  if (stage === "S1") return null;
  return {
    id: findingId(projectId, "reliability-recovery", "project"),
    family: "reliability-recovery",
    stage,
    score: clamp(score),
    target: "project",
    title: "Recovery pressure is rising",
    evidenceQuality: previous ? "direct+derived+heuristic" : "direct+heuristic",
    signals: s.filter(item => item.active),
    whyItMatters: "Background and retryable work needs explicit behavior for interruption, duplicate execution, timeout, and restart.",
    doNow: ["For the next long-running or retryable task, define timeout/cancellation, duplicate handling, and how work resumes after interruption."],
    prepare: ["Persist only the minimum task state needed to recover when real interruption risk appears."],
    doNotDoYet: ["Do not adopt a full workflow engine or multi-region failover solely from static code signals."],
    nextTrigger: "Lost work, duplicate side effects, orphan processes, frequent retry chains, or work that must survive application restarts.",
    confidence: clamp(0.42 + supporting * 0.1 + (previous ? 0.08 : 0), 0, 0.9),
    standards: ["ISO/IEC 25010:2023 reliability/recoverability baseline", "ISO/IEC/IEEE 12207:2026 lifecycle/operation baseline"],
    heuristicDisclosure: "Missing source-code patterns do not prove missing runtime safeguards; this finding flags recovery questions to verify."
  };
}

function testingVerificationFinding(projectId, current, previous, decisionPolicy = null) {
  const summary = current.summary;
  const files = runtimeFiles(current);
  const prevFiles = runtimeFiles(previous);
  const testFiles = summary.testFiles || 0;
  const previousTestFiles = previous?.summary?.testFiles || 0;
  const productFiles = files.length;
  const productLoc = files.reduce((total, file) => total + (file.loc || 0), 0);
  const assertions = summary.assertionSignals || 0;
  const testRatio = testFiles > 0 ? productFiles / testFiles : Infinity;
  const sourceGrowth = prevFiles.length > 0 ? productFiles / prevFiles.length : null;
  const criticalSurface =
    sumField(files, "publicEndpoints") +
    sumField(files, "backgroundJobSignals") +
    sumField(files, "processSignals");

  const s = [
    signal(productFiles >= 60 || productLoc >= 25000, "project_change_surface", productFiles, "Project source size/change surface proxy"),
    signal(productFiles >= 40 && testFiles <= 2, "sparse_test_surface", testFiles, "Repository-visible automated test file count"),
    signal(testFiles > 0 && productFiles >= 40 && testRatio >= 20, "test_ratio_gap", round(testRatio, 1), "Product-to-test file ratio"),
    signal(criticalSurface >= 8 && testFiles < 5, "critical_paths_test_gap", criticalSurface, "API/background/process surface relative to repository-visible tests"),
    signal(sourceGrowth != null && sourceGrowth >= 1.25 && testFiles <= previousTestFiles, "tests_not_growing", round((sourceGrowth - 1) * 100, 1), "Source growth without test-file growth"),
    signal(testFiles >= 3 && assertions < testFiles * 2, "low_assertion_depth", assertions, "Assertion/checkpoint patterns in repository-visible tests")
  ];

  let score = 0;
  score += productFiles >= 120 || productLoc >= 50000 ? 18 : productFiles >= 60 || productLoc >= 25000 ? 12 : 0;
  score += productFiles >= 40 && testFiles <= 2 ? 22 : 0;
  score += testFiles > 0 && testRatio >= 30 ? 18 : testFiles > 0 && testRatio >= 20 ? 12 : 0;
  score += criticalSurface >= 15 && testFiles < 5 ? 20 : criticalSurface >= 8 && testFiles < 5 ? 14 : 0;
  score += sourceGrowth >= 1.5 && testFiles <= previousTestFiles ? 16 : sourceGrowth >= 1.25 && testFiles <= previousTestFiles ? 10 : 0;
  score += testFiles >= 3 && assertions < testFiles * 2 ? 8 : 0;

  const supporting = s.filter(item => item.active).length;
  const stage = stageFromScore(clamp(score), supporting, decisionPolicy, "testing-verification");
  if (stage === "S1") return null;
  return {
    id: findingId(projectId, "testing-verification", "project"),
    family: "testing-verification",
    stage,
    score: clamp(score),
    target: "project",
    title: "Verification pressure is rising",
    evidenceQuality: previous ? "direct+derived+heuristic" : "direct+heuristic",
    signals: s.filter(item => item.active),
    whyItMatters: "As change surface grows, manual checks and agent self-reports are less likely to catch regressions consistently.",
    doNow: ["Add focused automated checks around the most frequently changed or failure-sensitive path before broad test expansion."],
    prepare: ["Track which critical paths still require manual verification."],
    doNotDoYet: ["Do not chase 100% coverage or create tests only to improve a coverage number."],
    nextTrigger: "Repeated regressions, increasing test runtime/flakiness, or important flows that still cannot be verified automatically.",
    confidence: clamp(0.36 + supporting * 0.09 + (previous ? 0.06 : 0), 0, 0.82),
    standards: ["ISO/IEC 25010:2023 reliability/functional-suitability baseline", "ISO/IEC/IEEE 12207:2026 verification/validation lifecycle baseline"],
    heuristicDisclosure: "Repository-visible test counts are incomplete evidence; external/manual verification may exist."
  };
}

function observabilityFinding(projectId, current, previous, decisionPolicy = null) {
  const files = runtimeFiles(current);
  const prevFiles = runtimeFiles(previous);
  const endpoints = sumField(files, "publicEndpoints");
  const background = sumField(files, "backgroundJobSignals");
  const processes = sumField(files, "processSignals");
  const operational = endpoints + background + processes;
  const visibility = sumField(files, "structuredLogSignals") + sumField(files, "telemetrySignals");
  const correlation = sumField(files, "correlationSignals");
  const prevOperational =
    sumField(prevFiles, "publicEndpoints") +
    sumField(prevFiles, "backgroundJobSignals") +
    sumField(prevFiles, "processSignals");
  const prevVisibility = sumField(prevFiles, "structuredLogSignals") + sumField(prevFiles, "telemetrySignals");
  const operationalGrowth = prevOperational > 0 ? operational / prevOperational : null;

  const s = [
    signal(operational >= 8, "operational_surface", operational, "API/background/process execution surface"),
    signal(background >= 4, "background_work_surface", background, "Background execution patterns"),
    signal(operational >= 8 && visibility < 3, "visibility_gap", visibility, "Operational surface with low structured logging/telemetry evidence"),
    signal(endpoints >= 5 && correlation === 0, "correlation_gap", endpoints, "Multiple endpoints with no observed request/trace correlation identifiers"),
    signal(operationalGrowth != null && operationalGrowth >= 1.5 && visibility <= prevVisibility, "observability_growth_gap", round((operationalGrowth - 1) * 100, 1), "Operational growth without matching visibility growth")
  ];

  let score = 0;
  score += operational >= 20 ? 18 : operational >= 8 ? 12 : 0;
  score += background >= 8 ? 14 : background >= 4 ? 9 : 0;
  score += operational >= 8 && visibility < 3 ? 24 : 0;
  score += endpoints >= 5 && correlation === 0 ? 16 : 0;
  score += operationalGrowth >= 2 && visibility <= prevVisibility ? 18 : operationalGrowth >= 1.5 && visibility <= prevVisibility ? 12 : 0;

  const supporting = s.filter(item => item.active).length;
  const stage = stageFromScore(clamp(score), supporting, decisionPolicy, "observability");
  if (stage === "S1") return null;
  return {
    id: findingId(projectId, "observability", "project"),
    family: "observability",
    stage,
    score: clamp(score),
    target: "project",
    title: "Diagnosability pressure is rising",
    evidenceQuality: previous ? "direct+derived+heuristic" : "direct+heuristic",
    signals: s.filter(item => item.active),
    whyItMatters: "More API/background execution without matching visibility makes intermittent failures harder to explain and fix.",
    doNow: ["Make the next critical API/background path emit structured logs and a request/task identifier that follows it end to end."],
    prepare: ["Add metrics/traces only around flows where logs are no longer enough."],
    doNotDoYet: ["Do not deploy a large observability stack before the project has enough runtime complexity to justify it."],
    nextTrigger: "Frequent intermittent failures, multiple background flows, or incidents where the team cannot tell which step failed.",
    confidence: clamp(0.4 + supporting * 0.1 + (previous ? 0.08 : 0), 0, 0.88),
    standards: ["OpenTelemetry specification vocabulary", "CNCF cloud-native observability guidance", "ISO/IEC 25010:2023 reliability/maintainability baseline"],
    heuristicDisclosure: "Static logging/telemetry patterns do not prove runtime observability quality; they identify a likely diagnosability gap."
  };
}

function distributionScalingFinding(projectId, current, previous, intent, decisionPolicy = null) {
  const files = runtimeFiles(current);
  const background = sumField(files, "backgroundJobSignals");
  const processes = sumField(files, "processSignals");
  const endpoints = sumField(files, "publicEndpoints");
  const persistence = sumField(files, "persistenceSignals");
  const deployTargets = current.summary.deploymentTargetCount || 0;
  const workspaces = current.summary.workspacePackages || 0;
  const existingRuntimeBoundary = hasExistingRuntimeBoundary(files);
  const hosted = ["hosted", "hybrid"].includes(intent?.effective?.delivery);
  const multiUser =
    intent?.explicit?.tenancy === "multi" ||
    intent?.explicit?.audience === "public";

  const s = [
    signal(hosted, "hosted_delivery", intent?.effective?.delivery || "unknown", "Explicit product-intent context only; inferred values remain advisory"),
    signal(multiUser, "multi_user_intent", intent?.effective?.tenancy || intent?.effective?.audience || "unknown", "Explicit product-intent context only; inferred values remain advisory"),
    signal(background >= 4 || processes >= 3, "separate_runtime_work", background + processes, "Background/worker/process execution evidence"),
    signal(deployTargets >= 2, "multiple_deploy_targets", deployTargets, "Root deployment-target evidence"),
    signal(workspaces >= 2, "workspace_boundaries", workspaces, "Workspace/package boundary evidence"),
    signal(endpoints >= 8, "endpoint_surface_large", endpoints, "Public endpoint evidence"),
    signal(persistence >= 8, "persistence_surface", persistence, "Persistence/storage evidence")
  ];

  let score = 0;
  score += hosted ? 14 : 0;
  score += multiUser ? 10 : 0;
  score += background >= 8 || processes >= 6 ? 18 : background >= 4 || processes >= 3 ? 12 : 0;
  score += deployTargets >= 3 ? 16 : deployTargets >= 2 ? 10 : 0;
  score += workspaces >= 3 ? 12 : workspaces >= 2 ? 8 : 0;
  score += endpoints >= 15 ? 14 : endpoints >= 8 ? 9 : 0;
  score += persistence >= 20 ? 12 : persistence >= 8 ? 7 : 0;

  const supporting = s.filter(x => x.active).length;
  const observedStage = stageFromScore(clamp(score), supporting, decisionPolicy, "distribution-scaling");
  const highImpactContextKnown =
    hosted ||
    multiUser ||
    ["growing", "large"].includes(intent?.effective?.scale) ||
    ["important", "critical"].includes(intent?.effective?.criticality);
  // Static background/process counts measure pressure, not independent-service need.
  // Keep the raw stage visible, but do not raise a high-impact action without intent.
  const stage = !highImpactContextKnown && stageRank(observedStage) >= 3 ? "S2" : observedStage;
  const hasDirectRuntimeWork = background >= 4 || processes >= 3;
  if (stage === "S1" && !hasDirectRuntimeWork) return null;

  return {
    id: findingId(projectId, "distribution-scaling", "project"),
    family: "distribution-scaling",
    stage,
    observedStage,
    score: clamp(score),
    target: "project",
    title: "Runtime/deployment separation pressure is rising",
    evidenceQuality: "direct+intent+heuristic",
    signals: s.filter(x => x.active),
    architecturalContext: existingRuntimeBoundary
      ? { existingRuntimeBoundary: true, source: "path-heuristic" }
      : { existingRuntimeBoundary: false, source: "path-heuristic" },
    decisionAssessment: existingRuntimeBoundary
      ? { status: "existing-runtime-boundary", semanticEvidenceAvailable: false, recommendation: "preserve-existing-runtime-authority" }
      : !highImpactContextKnown
        ? { status: "product-intent-unconfirmed", semanticEvidenceAvailable: false, recommendation: "confirm-intent-before-high-impact-change" }
        : { status: "evaluate-direct-operational-evidence", semanticEvidenceAvailable: false, recommendation: "verify-independent-operational-need" },
    decisionQuestions: !highImpactContextKnown && !existingRuntimeBoundary
      ? ["这个产品是本地、托管还是混合交付？", "哪个组件负责任务执行和恢复？"]
      : [],
    whyItMatters: existingRuntimeBoundary
      ? "Runtime/process activity is present and an existing Runtime integration path was detected; this does not imply Desktop should own task execution or recovery."
      : "Different runtime, scaling, and recovery needs can justify a process or service boundary, but only when explicit product intent and operational evidence agree.",
    doNow: [existingRuntimeBoundary
      ? "Keep Desktop as the integration/orchestration surface and leave execution and recovery with the existing Runtime."
      : !highImpactContextKnown
        ? "Confirm deployment and workload-ownership intent before considering an architecture change."
        : "Keep independently-running work behind a small explicit boundary and make ownership/failure behavior clear."],
    prepare: [existingRuntimeBoundary
      ? "Check whether a concrete workload needs independent scaling or release before changing the current Runtime integration."
      : "Collect real scale, failure-isolation, and independent-release needs before extracting a service."],
    doNotDoYet: [existingRuntimeBoundary
      ? "Do not duplicate task execution, recovery, or orchestration in Desktop; do not add a service layer without an independent operational need."
      : "Do not introduce microservices, Kubernetes, or a service mesh from repository size alone."],
    nextTrigger: existingRuntimeBoundary
      ? "A workload has a demonstrated need to scale, deploy, or fail independently from the current Runtime."
      : "A workload must scale, deploy, or recover independently from the main application.",
    confidence: clamp(0.38 + supporting * 0.08 + (hosted ? 0.08 : 0), 0, 0.86),
    standards: ["ISO/IEC/IEEE 42010:2022 architecture viewpoints", "CNCF cloud-native architecture guidance"],
    heuristicDisclosure: "Static repository evidence cannot prove independent scaling/failure-domain needs; Product Intent is required for higher-confidence transitions."
  };
}

function apiContractFinding(projectId, current, previous, intent, decisionPolicy = null) {
  const files = runtimeFiles(current);
  const endpoints = sumField(files, "publicEndpoints");
  const endpointFiles = files.filter(f => f.publicEndpoints > 0).length;
  const contracts = sumField(files, "apiContractSignals");
  const versions = sumField(files, "apiVersionSignals");
  const compatibility = sumField(files, "compatibilitySignals");
  const prevEndpoints = previous ? sumField(runtimeFiles(previous), "publicEndpoints") : 0;
  const growth = prevEndpoints > 0 ? endpoints / prevEndpoints : null;
  const hosted = ["hosted", "hybrid"].includes(intent?.effective?.delivery);
  const contractGap = endpoints >= 8 && contracts < Math.max(2, Math.ceil(endpointFiles / 2));

  const s = [
    signal(endpoints >= 8, "endpoint_surface_large", endpoints, "Public endpoint count"),
    signal(endpointFiles >= 4, "endpoint_spread", endpointFiles, "Files exposing public endpoints"),
    signal(contractGap, "contract_gap", contracts, "Endpoint surface compared with explicit contract/schema evidence"),
    signal(growth != null && growth >= 1.25, "endpoint_growth", round((growth - 1) * 100, 1), "Endpoint growth across compatible evidence versions"),
    signal(compatibility >= 3 || versions >= 3, "compatibility_pressure", compatibility + versions, "Versioning/compatibility evidence"),
    signal(hosted, "hosted_delivery", intent?.effective?.delivery || "unknown", "Explicit product-intent context only; inferred values remain advisory")
  ];

  let score = 0;
  score += endpoints >= 20 ? 20 : endpoints >= 8 ? 13 : 0;
  score += endpointFiles >= 8 ? 16 : endpointFiles >= 4 ? 10 : 0;
  score += contractGap ? 22 : 0;
  score += growth >= 1.5 ? 16 : growth >= 1.25 ? 10 : 0;
  score += compatibility >= 5 || versions >= 5 ? 14 : compatibility >= 3 || versions >= 3 ? 9 : 0;
  score += hosted ? 8 : 0;

  const supporting = s.filter(x => x.active).length;
  const observedStage = stageFromScore(clamp(score), supporting, decisionPolicy, "api-contract");
  const externalIntentKnown =
    intent?.explicit?.audience === "public" ||
    intent?.explicit?.tenancy === "multi" ||
    intent?.explicit?.delivery === "hosted" ||
    intent?.explicit?.delivery === "hybrid";
  // Endpoint and schema-pattern counts do not establish external consumers.
  // Preserve observed pressure while avoiding S3+ action until intent is verified.
  const stage = !externalIntentKnown && stageRank(observedStage) >= 3 ? "S2" : observedStage;
  if (stage === "S1" && endpoints < 8 && !contractGap && compatibility < 3 && versions < 3) return null;

  return {
    id: findingId(projectId, "api-contract", "project"),
    family: "api-contract",
    stage,
    observedStage,
    score: clamp(score),
    target: "project",
    title: "API contract pressure is rising",
    evidenceQuality: previous ? "direct+derived+intent+heuristic" : "direct+intent+heuristic",
    signals: s.filter(x => x.active),
    decisionAssessment: externalIntentKnown
      ? { status: "evaluate-confirmed-consumers", recommendation: "verify-contract-risk" }
      : { status: "product-intent-unconfirmed", recommendation: "confirm-consumers-before-high-impact-change" },
    decisionQuestions: externalIntentKnown
      ? []
      : ["是否有外部客户或独立服务依赖这些请求/响应格式？", "哪些接口确实需要兼容旧格式？"],
    whyItMatters: "As endpoint count and consumers grow, implicit request/response shapes make change compatibility harder to control.",
    doNow: ["Stabilize schemas for the most depended-on endpoints and verify them automatically."],
    prepare: ["Introduce version/compatibility policy only when real consumers make breaking changes costly."],
    doNotDoYet: ["Do not add an API gateway or version every internal function just because endpoint count increased."],
    nextTrigger: "Multiple consumers, repeated breaking changes, compatibility branches, or external integrations depending on the API.",
    confidence: clamp(0.4 + supporting * 0.09 + (previous ? 0.06 : 0), 0, 0.88),
    standards: ["OpenAPI / JSON Schema where applicable", "ISO/IEC/IEEE 42010:2022 interface viewpoints"],
    heuristicDisclosure: "Contract-pattern counts are proxies; contracts may exist outside the scanned source tree."
  };
}

function providerIntegrationFinding(projectId, current, previous, decisionPolicy = null) {
  const files = runtimeFiles(current);
  const providers = [...new Set(files.flatMap(f => f.providerNames || []))];
  const providerFiles = files.filter(f => (f.providerNames || []).length > 0);
  const coreLeakFiles = providerFiles.filter(f => !/(^|\/)(providers?|adapters?|integrations?|clients?)(\/|$)/i.test(f.path)).length;
  const branches = sumField(providerFiles, "providerBranchSignals");
  const providerAuthRetry = providerFiles.filter(f => (f.retrySignals || 0) + (f.credentialSurface || 0) > 0).length;
  const prevProviders = previous ? [...new Set(runtimeFiles(previous).flatMap(f => f.providerNames || []))].length : 0;
  const providerGrowth = prevProviders > 0 ? providers.length / prevProviders : null;

  const s = [
    signal(providers.length >= 2, "provider_count", providers.length, "Distinct provider SDK families"),
    signal(providerFiles.length >= 4, "provider_spread", providerFiles.length, "Files importing provider SDKs"),
    signal(coreLeakFiles >= 3, "provider_core_leak", coreLeakFiles, "Provider SDK usage outside provider/adapter/integration boundaries"),
    signal(branches >= 3, "provider_branching", branches, "Provider-specific branch evidence"),
    signal(providerAuthRetry >= 3, "provider_retry_auth_spread", providerAuthRetry, "Provider files containing auth/retry concerns"),
    signal(providerGrowth != null && providerGrowth >= 1.5, "provider_growth", round((providerGrowth - 1) * 100, 1), "Provider-family growth across sessions")
  ];

  let score = 0;
  score += providers.length >= 4 ? 18 : providers.length >= 2 ? 11 : 0;
  score += providerFiles.length >= 8 ? 18 : providerFiles.length >= 4 ? 12 : 0;
  score += coreLeakFiles >= 6 ? 22 : coreLeakFiles >= 3 ? 15 : 0;
  score += branches >= 6 ? 16 : branches >= 3 ? 10 : 0;
  score += providerAuthRetry >= 5 ? 12 : providerAuthRetry >= 3 ? 8 : 0;
  score += providerGrowth >= 2 ? 14 : providerGrowth >= 1.5 ? 9 : 0;

  const supporting = s.filter(x => x.active).length;
  const stage = stageFromScore(clamp(score), supporting, decisionPolicy, "provider-integration");
  if (stage === "S1") return null;

  return {
    id: findingId(projectId, "provider-integration", "project"),
    family: "provider-integration",
    stage,
    score: clamp(score),
    target: "project",
    title: "Provider-specific complexity is spreading",
    evidenceQuality: previous ? "direct+derived+heuristic" : "direct+heuristic",
    signals: s.filter(x => x.active),
    whyItMatters: "Provider SDK/auth/retry details spread through core logic make replacement, fallback, and consistent policy harder.",
    doNow: ["Keep new provider-specific behavior behind a small adapter/capability boundary."],
    prepare: ["Share retry/auth/error policy only when the same capability truly spans multiple providers."],
    doNotDoYet: ["Do not build a general plugin platform or routing engine for a small number of integrations."],
    nextTrigger: "A second provider for the same capability, repeated provider branches, or duplicated auth/retry behavior.",
    confidence: clamp(0.4 + supporting * 0.09 + (previous ? 0.06 : 0), 0, 0.87),
    standards: ["ISO/IEC 25010:2023 modularity/flexibility baseline", "ISO/IEC/IEEE 42010:2022 interface viewpoints"],
    heuristicDisclosure: "Provider detection is package/import based and may miss custom integrations."
  };
}

function aiDriftFinding(projectId, current, previous, decisionPolicy = null) {
  const groups = current.summary.technologyGroups || {};
  const fragmented = Object.values(groups).filter(values => Array.isArray(values) && values.length >= 2).length;
  const duplicates = current.summary.duplicateBlockGroups || 0;
  const duplicateFiles = current.summary.duplicateAffectedFiles || 0;
  const prevDuplicates = previous?.summary?.duplicateBlockGroups || 0;
  const duplicateGrowth = prevDuplicates > 0 ? duplicates / prevDuplicates : null;
  const deps = current.summary.productionDependencies || 0;
  const prevDeps = previous?.summary?.productionDependencies || 0;
  const depGrowth = prevDeps > 0 ? deps / prevDeps : null;

  const s = [
    signal(fragmented >= 1, "stack_fragmentation", fragmented, "Technology categories with multiple competing libraries"),
    signal(duplicates >= 8 && duplicateFiles >= 4, "duplicate_implementation_spread", duplicateFiles, "Substantial repeated multi-line blocks across files"),
    signal(duplicateGrowth != null && duplicateGrowth >= 1.5, "duplicate_implementation_growth", round((duplicateGrowth - 1) * 100, 1), "Duplicate-block growth across sessions"),
    signal(depGrowth != null && depGrowth >= 1.25, "dependency_stack_growth", round((depGrowth - 1) * 100, 1), "Production-dependency growth across sessions")
  ];

  let score = 0;
  score += fragmented >= 3 ? 24 : fragmented >= 2 ? 18 : fragmented >= 1 ? 10 : 0;
  score += duplicates >= 20 && duplicateFiles >= 8 ? 24 : duplicates >= 8 && duplicateFiles >= 4 ? 14 : 0;
  score += duplicateGrowth >= 2 ? 20 : duplicateGrowth >= 1.5 ? 12 : 0;
  score += depGrowth >= 1.5 ? 18 : depGrowth >= 1.25 ? 10 : 0;

  const supporting = s.filter(x => x.active).length;
  const stage = stageFromScore(clamp(score), supporting, decisionPolicy, "ai-drift");
  if (stage === "S1") return null;

  return {
    id: findingId(projectId, "ai-drift", "project"),
    family: "ai-drift",
    stage,
    score: clamp(score),
    target: "project",
    title: "Implementation conventions are drifting",
    evidenceQuality: previous ? "direct+derived+heuristic" : "direct+heuristic",
    signals: s.filter(x => x.active),
    whyItMatters: "Multiple competing stacks and repeated implementations make later sessions less certain about which pattern to extend.",
    doNow: ["Prefer the dominant existing pattern for new work and consolidate only the smallest repeated implementation that is actively changing."],
    prepare: ["Write a short convention only after a pattern is clearly dominant and worth preserving."],
    doNotDoYet: ["Do not rewrite the project just to make every historical implementation look identical."],
    nextTrigger: "Another competing implementation appears or duplicate/stack fragmentation continues growing.",
    confidence: clamp(0.34 + supporting * 0.1 + (previous ? 0.08 : 0), 0, 0.82),
    standards: ["ISO/IEC 25010:2023 maintainability/consistency baseline"],
    heuristicDisclosure: "Vibe can detect implementation drift but cannot prove that AI caused it."
  };
}

function buildFindings(projectId, current, previous, intent, root, decisionPolicy = null) {
  const previousFiles = fileMap(previous);
  const findings = [];

  for (const file of current.files) {
    const f = componentFinding(projectId, file, previousFiles.get(file.path), current.git.commitCount, decisionPolicy);
    if (f) findings.push(f);
  }
  for (const f of [
    couplingFinding(projectId, current, previous, decisionPolicy),
    portabilityFinding(projectId, current, previous, decisionPolicy),
    securityFinding(projectId, current, previous, decisionPolicy),
    stateDataFinding(projectId, current, previous, decisionPolicy),
    asyncConcurrencyFinding(projectId, current, previous, decisionPolicy),
    reliabilityRecoveryFinding(projectId, current, previous, decisionPolicy),
    testingVerificationFinding(projectId, current, previous, decisionPolicy),
    observabilityFinding(projectId, current, previous, decisionPolicy),
    distributionScalingFinding(projectId, current, previous, intent, decisionPolicy),
    apiContractFinding(projectId, current, previous, intent, decisionPolicy),
    providerIntegrationFinding(projectId, current, previous, decisionPolicy),
    aiDriftFinding(projectId, current, previous, decisionPolicy)
  ]) if (f) findings.push(f);

  const contractFinding = detectEncodedIdContract(root, current.files, projectId);
  if (contractFinding) findings.push(contractFinding);

  // Preserve evidence scores while explaining a cloud-calibrated stage. Some
  // specialist safety/intent guards deliberately cap the stage after scoring.
  if (decisionPolicy) {
    for (const finding of findings) {
      const multiplier = decisionPolicy.familyScoreWeights?.[finding.family] ?? 1;
      finding.baseScore = finding.score;
      finding.score = Math.max(0, Math.min(100, Math.round(finding.score * multiplier * 100) / 100));
    }
  }
  findings.sort((a, b) => stageRank(b.stage) - stageRank(a.stage) || b.score - a.score);
  return findings;
}

function compactSnapshot(scan, identity, changeFingerprint = null) {
  return {
    ...scan,
    project: {
      id: identity.id,
      repoId: identity.repoId,
      projectInstanceId: identity.projectInstanceId,
      identityVersion: identity.identityVersion,
      displayName: identity.displayName,
      branch: identity.branch,
      head: identity.head,
      remotePresent: identity.remotePresent,
      changeFingerprint
    }
  };
}

export function analyzeProject(
  inputPath = process.cwd(),
  {
    persist = true,
    changeFingerprint = null,
    projectRoot = null,
    identity: precomputedIdentity = null,
    scanLimits = null,
    decisionPolicy = null
  } = {}
) {
  const engineStartedAt = Date.now();

  const root = projectRoot || findProjectRoot(inputPath);
  const identityStartedAt = Date.now();
  const identity = precomputedIdentity || projectIdentity(root);
  const identityMs = precomputedIdentity ? 0 : Date.now() - identityStartedAt;

  const historyReadStartedAt = Date.now();
  const state = loadState(identity.id);
  const recentSnapshots = listRecentSnapshots(identity.id, 12);
  const historyReadBaseMs = Date.now() - historyReadStartedAt;

  const scan = scanProject(root, { limits: scanLimits || {} });
  const current = compactSnapshot(scan, identity, changeFingerprint);
  const scoringPolicy = scoringPolicyIdentity(decisionPolicy);
  current.scoringPolicy = scoringPolicy;

  const trendStartedAt = Date.now();
  const trendReference = selectTrendReference(current, recentSnapshots, 4);
  const latestCompatible = state.latest?.evidenceVersion === current.evidenceVersion ? state.latest : null;
  const previous = trendReference || latestCompatible;
  const intent = resolveProductIntent(identity.id, current);
  const historyReadMs = historyReadBaseMs + (Date.now() - trendStartedAt);

  const monitorsStartedAt = Date.now();
  const findingsComparable = state.findings?.evidenceVersion === current.evidenceVersion &&
    (state.findings?.scoringPolicyKey || "local-v1") === scoringPolicy.key;
  const comparablePreviousFindings = findingsComparable ? state.findings?.items || {} : {};
  const findings = buildFindings(identity.id, current, previous, intent, root, decisionPolicy).map(f => {
    const base = { ...f, requiresAttention: stageRank(f.stage) >= 3, userFacing: plainFinding(f) };
    return enrichFindingIntelligence(base, comparablePreviousFindings[f.id], intent, current.capturedAt, {persist});
  });
  if (current.summary.testFiles === 0) {
    for (const finding of findings) {
      if (finding.family === "code-structure") {
        finding.prepare = [...finding.prepare, "No repository-visible test files were found; establish a minimal test runner and characterize the affected behavior before any extraction."];
      }
    }
  }
  const transitions = findingsComparable
    ? findingTransitions(comparablePreviousFindings, findings)
    : [];
  const attention = findings.filter(f => f.requiresAttention);
  const monitorsMs = Date.now() - monitorsStartedAt;

  const snapshotCountStartedAt = Date.now();
  const snapshotCount = listRecentSnapshots(identity.id, 60).length + (persist ? 1 : 0);
  const snapshotCountReadMs = Date.now() - snapshotCountStartedAt;

  let historyWriteMs = 0;
  if (persist) {
    const historyWriteStartedAt = Date.now();
    saveSnapshot(identity.id, current, findings);
    // Outcome collection is local-only and must never block a coding checkpoint.
    try {
      observeOutcomeCheckpoint(identity.id, {
        capturedAt: current.capturedAt, evidenceVersion: current.evidenceVersion,
        findings, fingerprint: current.project?.changeFingerprint || identity.head || null
      });
    } catch { /* best effort; next complete changed scan may recover */ }
    historyWriteMs = Date.now() - historyWriteStartedAt;
  }

  const result = {
    schemaVersion: 1,
    evidenceVersion: current.evidenceVersion,
    scoringPolicy,
    project: {
      id: identity.id,
      repoId: identity.repoId,
      projectInstanceId: identity.projectInstanceId,
      identityVersion: identity.identityVersion,
      root,
      branch: identity.branch,
      head: identity.head
    },
    capturedAt: current.capturedAt,
    durationMs: current.durationMs,
    summary: current.summary,
    graph: current.graph,
    productIntent: intent,
    history: {
      previousSnapshot: state.latest?.capturedAt || null,
      previousHead: state.latest?.project?.head || null,
      trendReferenceSnapshot: trendReference?.capturedAt || null,
      findingsComparable,
      snapshotCount
    },
    phaseTimings: {
      engineMs: Date.now() - engineStartedAt,
      identityMs,
      historyReadMs: historyReadMs + snapshotCountReadMs,
      gitEvidenceMs: scan.timings?.gitEvidenceMs ?? null,
      evidenceMs: scan.timings?.evidenceMs ?? null,
      structuralMs: scan.timings?.structuralMs ?? current.summary?.structuralScan?.durationMs ?? null,
      monitorsMs,
      historyWriteMs
    },
    status: {
      attentionRequired: attention.length > 0,
      highestStage: findings[0]?.stage || "S1",
      findingCount: findings.length,
      attentionCount: attention.length
    },
    transitions,
    findings
  };
  return result;
}

export function readCachedAnalysis(
  inputPath = process.cwd(),
  changeFingerprint = null,
  { projectRoot = null, identity: precomputedIdentity = null, decisionPolicy = null } = {}
) {
  const root = projectRoot || findProjectRoot(inputPath);
  const identity = precomputedIdentity || projectIdentity(root);
  const state = loadState(identity.id);
  const latest = state.latest;
  if (!latest) return null;
  if (latest.evidenceVersion !== EVIDENCE_VERSION) return null;
  if ((latest.scoringPolicy?.key || "local-v1") !== scoringPolicyIdentity(decisionPolicy).key) return null;
  if (!changeFingerprint || latest.project?.changeFingerprint !== changeFingerprint) return null;

  const findings = Object.values(state.findings?.items || {});
  const attention = findings.filter(f => f.requiresAttention);
  const intent = resolveProductIntent(identity.id, latest);
  return {
    schemaVersion: 1,
    evidenceVersion: latest.evidenceVersion,
    scoringPolicy: latest.scoringPolicy || scoringPolicyIdentity(null),
    project: {
      id: identity.id,
      repoId: identity.repoId,
      projectInstanceId: identity.projectInstanceId,
      identityVersion: identity.identityVersion,
      root,
      branch: identity.branch,
      head: identity.head
    },
    capturedAt: latest.capturedAt,
    durationMs: 0,
    summary: latest.summary,
    graph: latest.graph,
    productIntent: intent,
    history: {
      previousSnapshot: latest.capturedAt,
      previousHead: latest.project?.head || null,
      trendReferenceSnapshot: null,
      findingsComparable: false,
      snapshotCount: listRecentSnapshots(identity.id, 60).length
    },
    status: {
      attentionRequired: attention.length > 0,
      highestStage: findings[0]?.stage || "S1",
      findingCount: findings.length,
      attentionCount: attention.length
    },
    transitions: [],
    findings
  };
}

export function explainFinding(inputPath, findingIdValue) {
  const result = analyzeProject(inputPath, { persist: false });
  return findingDetail(result.project.root, result.findings.find(f => f.id === findingIdValue), result.summary);
}


/**
 * Opt-in presentation of existing scan evidence for five Vibe Coder questions.
 * Adds no scans, model calls, telemetry, network requests or certification.
 */
export function buildVibeCoderBrief(analysis) {
  if (!analysis || !Array.isArray(analysis.findings)) throw new TypeError("analysis_findings_required");
  const unique = values => [...new Set(values.filter(v => typeof v === "string" && v.length))];
  const ranked = [...analysis.findings].sort((a, b) =>
    stageRank(b.stage) - stageRank(a.stage) || (b.score || 0) - (a.score || 0));
  const byConcern = new Map();
  for (const f of ranked) {
    // Different standards referencing one concern never multiply alerts.
    // Without a stable concern identifier, do NOT merge unrelated families.
    const key = f.concernId || f.id || String(f.family) + "|" + String(f.target);
    if (!byConcern.has(key)) byConcern.set(key, {primary: f, refs: [], ids: []});
    const g = byConcern.get(key);
    g.refs = unique([...g.refs, ...(f.standards || [])]);
    g.ids = unique([...g.ids, f.id || key]);
  }
  const groups = [...byConcern.values()];
  const high = groups.filter(g => stageRank(g.primary.stage) >= 3);
  const evidence = g => {
    const f = g.primary;
    return {
      id: f.id || null, family: f.family || "unknown", target: f.target || null,
      stage: f.stage || "unknown", title: f.title || "Evidence requires review",
      confidence: Number.isFinite(f.confidence) ? f.confidence : null,
      evidenceQuality: f.evidenceQuality || "unknown",
      signals: (f.signals || []).slice(0, 4).map(x => ({
        name: String(x.name || "unknown"),
        value: typeof x.value === "number" || typeof x.value === "boolean" ? x.value : null
      })),
      standards: g.refs.slice(0, 8), relatedFindingIds: g.ids,
      doNow: (f.doNow || []).slice(0, 2),
      prepare: (f.prepare || []).slice(0, 2),
      doNotDoYet: (f.doNotDoYet || []).slice(0, 2),
      nextTrigger: f.nextTrigger || null,
      heuristicDisclosure: f.heuristicDisclosure || null
    };
  };
  const transitions = Array.isArray(analysis.transitions) ? analysis.transitions : [];
  const worsened = transitions.filter(t => t.type === "worsened").length;
  const improved = transitions.filter(t => t.type === "improved").length;
  const newAttention = transitions.filter(t => t.type === "new_attention").length;
  const comparable = analysis.history?.findingsComparable === true &&
    Boolean(analysis.history?.trendReferenceSnapshot);
  const trajectory = !comparable ? "insufficient-comparable-history"
    : worsened && improved ? "mixed"
    : worsened ? "deteriorating"
    : improved ? "improving"
    : newAttention ? "new-attention-needs-review"
    : "no-evident-stage-change";
  const releaseFamilies = new Set(["security-surface", "testing-verification", "reliability-recovery",
    "platform-portability", "api-contract", "distribution-scaling", "async-concurrency"]);
  const releaseRisks = high.filter(g => releaseFamilies.has(g.primary.family));
  return {
    schemaVersion: 1, kind: "vibe-coder-decision-brief",
    source: "existing-local-analysis", evidenceVersion: analysis.evidenceVersion ?? null,
    capturedAt: analysis.capturedAt ?? null,
    questions: {
      health: {
        status: high.length ? "attention-needed" : "no-high-pressure-evidence",
        highestObservedStage: ranked[0]?.stage || "S1",
        evidence: high.slice(0, 2).map(evidence),
        limitation: "Static heuristics cannot establish project safety or standards compliance."
      },
      trajectory: {
        status: trajectory, comparable, worsened, improved, newAttention,
        limitation: "Only comparable policy/evidence histories support stage trends; correlation is not causation."
      },
      nextAction: {
        status: high.length ? "action-candidates" : "no-immediate-high-pressure-action",
        priorities: high.slice(0, 2).map(evidence),
        limitation: "Any high-impact change requires human context and approval."
      },
      economics: {
        status: "not-assessed", costEvidence: null,
        limitation: "No validated token, CI, Cloud or repeated-work spend was observed by this scan."
      },
      readiness: {
        status: releaseRisks.length ? "source-risks-observed" : "not-verified",
        sourceRisks: releaseRisks.slice(0, 2).map(evidence), certification: false,
        limitation: "No runtime, deployment, penetration or launch certification was conducted."
      }
    },
    standardsBasis: {
      references: unique(groups.flatMap(g => g.refs)).slice(0, 24),
      complianceAssessed: false,
      applicability: "context-dependent",
      note: "Standards guide interpretation. Stages and thresholds remain Vibe Monitor heuristics."
    },
    presentationBudget: {maxPriorities: 2, extraScans: 0, modelCalls: 0}
  };
}
