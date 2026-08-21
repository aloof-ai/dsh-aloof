/**
 * Aloof → DeepSeek Harness（dsh）。**把团队的做事方式装进这台机器的 agent。**
 *
 * 干两件事：
 *
 * 1. **下发团队上下文**（这份文件里最要紧的部分）。定时拉 Aloof 的 `/api/context`，把
 *    「红线」塞进系统提示、把「手册」注册进 dsh 的技能目录。管理员在网页上改一句话，这台
 *    机器上的 agent 下一次对话就照新的来——这是这个产品和「又一个文件柜」的分界线。
 * 2. **两个只读工具**，确认这台 dsh 真的连上了公司那台 Aloof、而且认出了是谁。
 *
 * **写操作一律不在这儿**，尤其不给改规矩的口子：agent 能改自己要遵守的红线的话，红线就
 * 只是一段可以被绕过的建议。后端那边也挡着（`_TOKEN_WRITES` 是空的 + 端点挂 `human_admin`），
 * 两边都挡是刻意的。将来真要让 AI 参与，正确形状是「它提议、人过目」。
 *
 * 为什么整份文件没有一句 import：
 * dsh 的 `defineTool` / `credentialRef` 这些都在 `@deepseek-ai/dsh-*` 包里，用了就把插件
 * 钉死在某个 dsh 内部版本上，而且插件被软链进 profile 时 Node 会从**真实路径**往上找
 * node_modules，找不到那些包。所以这里直接手写 JSON Schema、只用 ctx 上的服务。代价是
 * 少了编译期类型推导，对一个只做 HTTP 转发的薄壳来说不亏。
 */

/** loader 用它做日志和错误定位；和 cordis.patch.yml 里的 `id` 无关。 */
export const name = 'aloof'

/**
 * 只**硬**依赖工具注册表：没有它这个插件没有存在意义。
 *
 * `commands`（斜杠命令）是**可选**的，所以不写在这儿而是在 apply 里嵌套 inject：写进来的话，
 * 任何没组合命令服务的装配（无头 demo、ACP 自动化）会让整个插件不挂载——为了一个 `/aloof`
 * 把两个工具也搭进去，赔本。嵌套之后那种装配里只是没有这条命令。
 */
export const inject = ['tools']

/**
 * 配置缺省值。cordis 行里没给的键落到这儿，别让插件因为少一行 YAML 就崩。
 *
 * **`baseUrl` 不在这儿，而且正常情况下根本不用配**：地址跟着票一起来（见 `split`）。
 * 这里要是兜一个我们的域名，别家用户的令牌就会静悄悄发到我们的服务器上——那边只会回
 * 401，但票已经出网了。真需要写死时（反向代理、内网另有入口）配置里还能填，填了以它为准。
 */
const DEFAULTS = {
  tokenEnv: 'ALOOF_TOKEN',
  timeoutMs: 20000,
  /**
   * 多久去 Aloof 拉一次团队上下文。
   *
   * 五分钟是「改一句话多久生效」和「别把服务器当心跳靶子」之间的取舍。往下调没什么意义：
   * 真要秒级生效该做的是服务端推送，不是把轮询调密。
   */
  syncEveryMs: 300000,
}

/**
 * 团队红线在系统提示里的位置。
 *
 * dsh 的约定：`-100` 是 harness 自己的身份，`0` 是部署方的人格，`100`~`199` 是工具指引。
 * 团队规矩排在人格**之后**、工具指引之前——先知道「你是谁」，再知道「你在这个团队要守
 * 什么」，然后才是「手上有哪些工具」。
 */
const RULES_ORDER = 50

/** 凭据引用名的合法形状，和 dsh 的 `credentialRef` 一致（POSIX 标识符）。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 把 Aloof 复制给你的那一整串票拆成「密钥」和「发给哪台」。
 *
 * 复制出来的形状是 `alf_xxxx@https://你那台`——**密钥和它该去的地址绑在一起**。
 * 这么设计是为了消掉一整类错误：地址和票各自是一个可填的字段时，「填串了、票发到别人
 * 服务器上」就永远可能发生；合成一个字符串之后，这件事在物理上就不成立了。
 * 顺带 dsh 那头也简单了——粘一串，不用再配第二个东西。
 *
 * 切法没有歧义：后端的密钥是 `secrets.token_urlsafe` 生成的，字母表 `[A-Za-z0-9_-]`，
 * **永远不含 `@`**，所以从第一个 `@` 切开就对。
 * @param {string} raw 凭据里存的那一整串
 * @returns {{secret:string, carried:string|null}} 密钥 + 票自带的地址（没带就是 null）
 */
function split(raw) {
  const at = raw.indexOf('@')
  if (at < 0) return { secret: raw, carried: null }
  return { secret: raw.slice(0, at), carried: raw.slice(at + 1).trim().replace(/\/+$/, '') }
}

/**
 * 把紧凑参数声明编译成模型看到的 JSON Schema。
 *
 * `required` 必须收敛成根上的数组——dsh 只接受 type/oneOf/properties/required/
 * additionalProperties/items/enum/const 这个子集，在属性里挂 `required: true`
 * 会被 register 直接拒掉。
 * @param {Record<string, any>} spec 紧凑声明
 */
function toSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = raw
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  // 参数根是开放对象：模型多传一个键不该让整次调用失败。
  return {
    type: 'object',
    properties,
    additionalProperties: true,
    ...(required.length > 0 ? { required } : {}),
  }
}

/**
 * 调用前的入参校验。dsh 的 `defineTool` 免费给这一层，手写就得自己补：
 * 没有它，一个漏填的必填参数会变成一次莫名其妙的 400，模型只能瞎猜。
 * @returns {string[]} 违规说明，空数组表示通过
 */
function violations(schema, args) {
  const out = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['参数必须是一个对象']
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      out.push(`缺少必填参数 ${key}`)
    }
  }
  for (const [key, node] of Object.entries(schema.properties)) {
    const value = args[key]
    if (value === undefined || value === null) continue
    const kind = node.type
    const ok = kind === 'string' ? typeof value === 'string'
      : kind === 'integer' ? Number.isInteger(value)
        : kind === 'number' ? typeof value === 'number'
          : kind === 'boolean' ? typeof value === 'boolean'
            : kind === 'array' ? Array.isArray(value)
              : true
    if (!ok) out.push(`参数 ${key} 应为 ${kind}`)
    if (Array.isArray(node.enum) && !node.enum.includes(value)) {
      out.push(`参数 ${key} 只能是 ${node.enum.join(' / ')}`)
    }
  }
  return out
}

/** 等价于 dsh 的 `defineTool`，只做它真正干的两件事：编译 schema、execute 前验参。 */
function tool(options) {
  const parameters = toSchema(options.parameters)
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: options.output,
    async execute(args, exec) {
      const bad = violations(parameters, args)
      if (bad.length > 0) throw new Error(bad.join('；'))
      return await options.execute(args, exec)
    },
  }
}

/** 列表结果统一带 total：只报本页条数会让模型把「20 条」当成全部。 */
function page(body, limit) {
  const items = Array.isArray(body?.items) ? body.items : []
  const total = typeof body?.total === 'number' ? body.total : items.length
  return { items, total, shown: items.length, truncated: total > items.length, limit }
}

/** 时间戳给人看的形状。后端回的是 ISO 串，直接丢给模型它会照抄一长串。 */
function when(iso) {
  if (typeof iso !== 'string' || iso === '') return '从没用过'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false })
}

/** 一个开放对象的 schema，用于把后端返回原样透给模型。 */
const OPEN_OBJECT = { type: 'object', additionalProperties: true }

/**
 * 「下发了什么」这一行给人看的形状。
 *
 * 这一行要能分开三件不同的事，因为它们各自对应不同的下一步：
 *
 * - **从没拉到过**：去查连接（票 / 网络）。
 * - **拉到了但是空的**：去网页上写规矩——连接是好的，只是没人配过。这一种最容易被误读成
 *   「插件没生效」，所以必须说出来。
 * - **拉到过、最近一次失败了**：现在按旧内容跑，不用慌，但 Aloof 那边有问题。
 * @param {{revision:string|null,ruleCount:number,ruleChars:number,skills:string[],
 *   syncedAt:string|null,error:string|null}} team 下发状态
 */
function delivery(team) {
  if (team.revision === null) {
    return team.error === null ? '还没拉到（正在同步）' : `拉不到团队上下文：${team.error}`
  }

  const parts = []
  if (team.ruleCount > 0) parts.push(`${team.ruleCount} 条红线（约 ${team.ruleChars} 字）`)
  if (team.skills.length > 0) parts.push(`${team.skills.length} 份手册：${team.skills.join('、')}`)
  const what = parts.length === 0
    ? '连上了，但团队还没配任何规矩（去 Aloof 网页上加）'
    : parts.join(' · ')

  return team.error === null
    ? what
    : `${what}　⚠ 最近一次同步失败，按 ${when(team.syncedAt)} 的内容在跑：${team.error}`
}

/**
 * 「待确认」那一行，没有就不显示这一行。
 *
 * 管理员和普通人关心的不是同一个数：**管理员要知道有几条等着他动手**，普通人只关心
 * 自己交上去的那条批了没。给他看「全公司有 7 条待确认」只会让他以为自己该做点什么。
 * @param {{pending:number, minePending:number}|null} counts 后端给的两个数
 * @param {boolean} isAdmin 这个人能不能批
 * @returns {string[]} 0 或 1 行，直接展开进输出
 */
function waiting(counts, isAdmin) {
  if (counts === null) return []
  if (isAdmin && counts.pending > 0) {
    return [`待确认　${counts.pending} 条团队提案等你过目（去 Aloof 网页上接受或拒绝）`]
  }
  if (counts.minePending > 0) {
    return [`待确认　你交回的 ${counts.minePending} 条还在等管理员确认，暂未下发`]
  }
  return []
}

export function apply(ctx, config) {
  const conf = { ...DEFAULTS, ...(config ?? {}) }

  /**
   * 配置里写死的地址。**平常是空的**——地址跟着票来。
   * 填了就以它为准（而不是票里那个）：反向代理、内网另有入口时，网页的地址和 dsh 能到达的
   * 地址确实可能不是同一个，这是留给那种情形的手动覆盖口子。
   */
  const pinned = typeof conf.baseUrl === 'string' && conf.baseUrl.trim() !== ''
    ? conf.baseUrl.trim().replace(/\/+$/, '')
    : null

  const ref = String(conf.tokenEnv)
  if (!REF_PATTERN.test(ref)) {
    throw new Error(`aloof: tokenEnv "${ref}" 不是合法的凭据引用名（需匹配 ${REF_PATTERN}）`)
  }

  /**
   * 取票据。**该放的是「dsh 接入令牌」**（形如 `alf_xxxx@https://你那台`，在 Aloof 里点
   * 左下角自己的名字 → 「dsh 接入」生成，整串复制），不是网页的登录票：登录票带着这个人的
   * 全部权限、没法单独作废；接入令牌读全放行、写只走白名单，而且能按设备吊销。
   *
   * 优先走 dsh 的 credentials 服务（它把进程环境变量叠在 `$DSH_HOME/.credentials.yaml`
   * 之上），这套服务不在时退回读环境变量，让插件在裸装配里也能用。
   *
   * **每次调用现取，不缓存**——换了票下一次请求就生效（甚至换成另一家公司的实例）。
   * 这一层是真的没缓存；dsh 那层盯着 `.credentials.yaml` 热更新（实测 0.5s 内），所以
   * 改文件不用重启。**但环境变量那份是启动时冻结的，而且压在文件之上**——同名环境变量
   * 存在时，改文件永远不生效，且现象和「插件缓存了」一模一样。
   */
  async function token() {
    const service = ctx.get?.('credentials')
    if (service !== undefined) {
      const hit = await service.resolve(ref)
      if (hit?.value) return hit.value
    }
    const ambient = process.env[ref]
    if (ambient) return ambient
    throw new Error(
      `没配 ${ref}：在 Aloof 里生成一张 dsh 接入令牌（左下角自己的名字 → dsh 接入），`
      + `把复制出来的**整串**（alf_xxxx@https://你那台）放进环境变量 ${ref}，`
      + '或写进 $DSH_HOME/.credentials.yaml',
    )
  }

  /**
   * 把票解析成「密钥 + 该打哪台 + 认票用的前缀」。
   *
   * **单独抽出来是为了「失败时也报得出地址」**：这条链上最贵的一类故障是票指着一台到不了的
   * 机器（换过环境、留着旧票），此时 fetch 抛的是 `fetch failed`，看起来百分百像网络/证书
   * 问题，人和模型会一路去查 DNS、代理、TLS，而根因只是地址不对。所以任何面向人的输出都要
   * 能在**没发出任何请求**的前提下先说出「我打算连哪」。
   *
   * @returns {Promise<{secret:string, base:string, prefix:string}>} `prefix` 和后端存的那 10
   * 位一致（`alf_` + 6），拿来跟网页上的票列表对行，不是密钥。
   */
  async function resolve() {
    const { secret, carried } = split(await token())
    const base = pinned ?? carried
    if (base === null) {
      throw new Error(
        `${ref} 里那串票不带地址，配置里也没写 baseUrl。去 Aloof 里重新复制一次——`
        + '复制出来的是「alf_xxxx@https://你那台」一整串，@ 后面那截就是地址，别只粘前半截',
      )
    }
    if (!/^https?:\/\//.test(base)) {
      const from = pinned === null ? `${ref} 里 @ 后面那截` : '配置里的 baseUrl'
      throw new Error(`地址 "${base}" 不像个网址（要带 http:// 或 https://）。它来自${from}`)
    }
    return { secret, base, prefix: secret.slice(0, 10) }
  }

  /**
   * 一次 Aloof API 调用。
   * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method HTTP 方法
   * @param {string} path 形如 `/api/auth/me`
   * @param {{query?:Record<string,any>,body?:any,signal?:AbortSignal}} [options] 附加项
   */
  async function api(method, path, options = {}) {
    const { secret, base } = await resolve()

    const url = new URL(base + path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }

    // 两个终止条件缝在一起：模型这次调用被取消（exec.signal），或者后端太慢（timeoutMs）。
    // 少了前者，用户点「停止」之后这条请求还会挂着。
    const timeout = AbortSignal.timeout(Number(conf.timeoutMs))
    const signal = options.signal === undefined
      ? timeout
      : AbortSignal.any([options.signal, timeout])

    let response
    try {
      response = await fetch(url, {
        method,
        signal,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
    } catch (error) {
      // fetch 的原始错误（`TypeError: fetch failed`）对模型毫无信息量，它会开始瞎试。
      const why = error instanceof Error ? error.message : String(error)
      throw new Error(`连不上 Aloof（${base}）：${why}`)
    }

    const text = await response.text()
    if (!response.ok) {
      // 后端的 `{"detail": "..."}` 才是给人看的那句话，优先透出它。
      let detail = text.slice(0, 400)
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed?.detail === 'string') detail = parsed.detail
      } catch { /* 不是 JSON，就用原文 */ }
      throw new Error(`Aloof ${response.status}：${detail}`)
    }
    return text === '' ? null : JSON.parse(text)
  }

  /**
   * 团队上下文的本地副本。**这台机器上唯一的一份**：系统提示、技能目录、`/aloof`、界面
   * 都读它，所以「agent 看到的」和「界面上说的」不可能对不上。
   */
  const team = {
    /** 服务端算的内容指纹。`null` = 还没成功拉到过。 */
    revision: null,
    /** 拼好的红线，直接进系统提示。 */
    rules: '',
    ruleCount: 0,
    ruleChars: 0,
    /** `[{ name, description, body }]`，注册进技能目录。 */
    skills: [],
    syncedAt: null,
    error: null,
  }

  /** 内容真的换了之后要重注册技能的人（红线不用，见下面 `text` 是个函数）。 */
  const watchers = new Set()

  /**
   * 去 Aloof 拉一次团队上下文。
   *
   * **拉不到就保持上一次的内容**，不清空、不抛。两个理由：
   *
   * - 网络抖动和服务重启是最常见的失败，而红线绝大多数是「不许做什么」。清空等于在
   *   Aloof 不可用的这段时间里把 agent 的约束全撤了——那比按一份稍旧的规矩走危险得多。
   * - 一个团队规矩服务挂掉不该让全公司的 agent 停摆。这条链上任何一环都不该是硬依赖。
   *
   * @param {AbortSignal} [signal] 调用方的取消信号
   * @returns {Promise<boolean>} 内容是否真的变了（变了才值得重注册）
   */
  async function sync(signal) {
    let body
    try {
      body = await api('GET', '/api/context', { signal })
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      // **只在状态翻转时吵一次**：持续失败（比如压根没配票）刷满日志之后，人就不看日志了，
      // 于是真正的那一次翻转也被埋掉。稳定的坏状态由 `/aloof` 和界面上的红灯负责显示。
      if (team.error === null) ctx.logger?.warn?.(`拉团队上下文失败，先按上一次的走：${why}`)
      else ctx.logger?.debug?.(`拉团队上下文仍然失败：${why}`)
      team.error = why
      return false
    }

    const recovered = team.error !== null
    team.error = null
    team.syncedAt = new Date().toISOString()
    if (recovered) ctx.logger?.info?.('团队上下文恢复同步')

    if (body.revision === team.revision) return false
    team.revision = body.revision
    team.rules = typeof body.rules === 'string' ? body.rules : ''
    team.ruleCount = Number(body.ruleCount) || 0
    team.ruleChars = Number(body.ruleChars) || 0
    team.skills = Array.isArray(body.skills) ? body.skills : []
    for (const watch of watchers) watch()
    return true
  }

  /**
   * 轮询。挂在顶层（不 inject 任何服务）：不管这套装配有没有系统提示和技能目录，
   * 「现在连的是哪台、下发了什么」都该是能回答的。
   *
   * **失败要快速退避重试，不能等下一个整轮**——这条是实跑出来的，不是预防性设计：
   * 插件 apply 时立刻拉一次，而那一刻 dsh 的 credentials 服务往往还没把票加载好，于是
   * 第一次必然报「没配 ALOOF_TOKEN」。固定五分钟间隔的话，**每次开机后前五分钟都没有团队
   * 规矩**，而 `/aloof` 会理直气壮地说「已连上」（那是另一条即时请求的结论）——一个看起来
   * 一切正常、实际规矩没生效的窗口，最难查的形状。
   *
   * 退避同时覆盖了另一件事：Aloof 短暂不可用时不必等满一轮才恢复。5s 起步、每次翻倍、
   * 封顶在正常间隔——恢复得够快，又不会在长时间故障时变成对服务器的重试风暴。
   */
  ctx.effect(() => {
    const every = Number(conf.syncEveryMs)
    let timer = null
    let backoff = 0

    const schedule = (ms) => {
      timer = setTimeout(tick, ms)
      // 不让这个定时器把进程钉住（CLI 一次性跑完就该退出）
      timer.unref?.()
    }

    async function tick() {
      await sync()
      if (team.error === null) backoff = 0
      else backoff = backoff === 0 ? 5000 : Math.min(backoff * 2, every)
      schedule(backoff === 0 ? every : backoff)
    }

    void tick()
    return () => clearTimeout(timer)
  }, 'dsh-aloof: 团队上下文同步')

  // 换票（甚至换成另一家公司的实例）之后立刻重拉，不用等下一轮。
  // 换票是**人刚刚做完的动作**，他会马上去看有没有生效——让他等五分钟等于让他以为没成功。
  ctx.on?.('credentials/updated', (changed) => {
    if (changed === ref) void sync()
  })

  /**
   * 红线 → 系统提示。
   *
   * `text` 给的是**函数**而不是字符串，所以内容更新时**不用重新注册**：每次组装提示词时
   * 现读 `team.rules`。注册一次、活到插件卸载，没有「注册/注销之间那一瞬间规矩是空的」
   * 这种缝。
   *
   * 还没拉到时它是空串——dsh 组装时会把空 section 丢掉，所以不会在提示词里留一个空标题。
   */
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'aloof:team-rules',
      order: RULES_ORDER,
      text: () => team.rules,
    }), 'dsh-aloof: 团队红线')
  })

  /**
   * 手册 → 技能目录。
   *
   * 同名时谁赢：`skills.register()` 一律给 rank 250（dsh 的 `RUNTIME_RANK`，小的赢），
   * 文件系统那边是 项目 `.dsh/skills` 100 / 项目 `AGENTS.md` 旁 200 / 自定义根 300 /
   * `~/.dsh/skills` 400 / bundled 600。所以我们正好卡在「项目的赢过公司的、公司的赢过个人的」，
   * 这正是想要的位置——但**不是我们选的**：rank 由 register() 写死，插件传什么都改不了。
   *
   * 和红线不同，这里**必须重注册**：技能是一个列表，条目会增减，没法用「一个函数每次现读」
   * 表达。所以订阅内容变化，变了就整批换掉。
   */
  ctx.inject(['skills'], (scoped) => {
    let live = []
    const drop = () => {
      for (const dispose of live) dispose()
      live = []
    }
    const put = () => {
      drop()
      live = team.skills.map((s) => scoped.skills.register({
        name: s.name,
        description: s.description,
        // dsh 那边这个字段叫 `content`，我们的接口叫 `body`。映射只在这一行，
        // 后端不跟着下游改名——不然将来接第二种 agent 又要改一次。
        content: s.body,
        // source 是**出处标签**（dsh 自带的是 `project-dsh`/`user-dsh`/`bundled` 这类），
        // 只影响日志和展示、不影响优先级。写 `aloof` 是为了同名被顶掉时那句 warning
        // 能直接读成「来自 aloof 的手册被更高优先级的顶掉了」
        source: 'aloof',
        // 让 `/skills` 列表里看得出这份手册是公司下发的，不是自己写的
        provider: 'aloof',
      }))
    }

    scoped.effect(() => {
      put()
      watchers.add(put)
      return () => {
        watchers.delete(put)
        drop()
      }
    }, 'dsh-aloof: 团队手册')
  })

  const registrations = [
    tool({
      name: 'aloof_whoami',
      description:
        '确认这台 dsh 有没有连上公司的 Aloof，以及 Aloof 那边认出我是谁。'
        + '用户问「连上了吗 / 我是谁 / Aloof 通不通」时用它。'
        + '连不上或者票不对，这里会直接说是哪一种问题，照着提示改就行。',
      parameters: {},
      output: {
        schema: OPEN_OBJECT,
        render: (_args, v) => [{
          type: 'text',
          text: `连上了。Aloof 认出你是 ${v.name}（登录名 ${v.username}）`
            + `${v.isAdmin ? '，有管理权限' : ''}。`,
        }],
      },
      async execute(_args, exec) {
        return await api('GET', '/api/auth/me', { signal: exec.signal })
      },
    }),

    tool({
      name: 'aloof_devices',
      description:
        '列出我自己在 Aloof 上的 dsh 接入令牌——也就是「我有哪几台机器连着」。'
        + '每条给出设备名、最后一次用的时间和来源 IP，以及是否已吊销。'
        + '用来回答「我在哪几台机器上接了 / 那台旧电脑的票还在用吗」。'
        + '**生成新票和吊销都必须去网页上做**，这里做不了（也不该让模型代做）。',
      parameters: {
        limit: { type: 'integer', description: '最多返回几条，1~100，默认 20' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            items: { type: 'array', items: OPEN_OBJECT },
            total: { type: 'integer' },
            shown: { type: 'integer' },
            truncated: { type: 'boolean' },
          },
        },
        render: (_args, v) => [{
          type: 'text',
          text: v.total === 0
            ? '一台都没有——这不太可能，因为你正在用一张票读这条消息。'
            : `共 ${v.total} 张票，列出 ${v.shown} 张：\n`
              + v.items.map(t => `- ${t.name}（${t.prefix}…）`
                + `${t.revokedAt ? ' 已吊销' : ''}`
                + `　最后使用：${when(t.lastUsedAt)}`
                + `${t.lastIp ? `　来源 ${t.lastIp}` : ''}`).join('\n'),
        }],
      },
      async execute(args, exec) {
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
        const body = await api('GET', '/api/auth/tokens', {
          query: { limit, offset: 0 },
          signal: exec.signal,
        })
        return page(body, limit)
      },
    }),

    /**
     * 把知识交回团队。**这是这个插件里唯一的写操作。**
     *
     * 为什么允许模型写：值得沉淀的东西恰好是「谁撞上问题谁才知道」，而那个人知道的那一刻
     * 正在会话里干活。要求他打开浏览器、登录、再把刚才那段重写一遍——这件事就不会发生。
     *
     * 为什么这么写是安全的：**提上去的东西不生效**。后端落在提案表里等真人管理员接受，
     * 接受那个端点拿令牌调是 403。所以模型能贡献知识，但改不动自己要遵守的红线。
     * （后端 `core/deps.py` 的写白名单里只有这一条，就是为了这个形状。）
     *
     * 描述里那句「用户明确要求时才用」很重要：不写的话模型会在每次帮人解决完问题后热情地
     * 提一条，而审的人很快就不看待确认列表了——那时这条路就废了。
     */
    tool({
      name: 'aloof_contribute',
      description:
        '把一份做法/踩过的坑交回公司的 Aloof，让团队里其他人的 agent 也能用上。'
        + '\n\n**只在用户明确要求时才调用**——他说「把这个存成团队手册 / 记到团队里 /'
        + '分享给大家 / 以后都按这个来」之类的话。不要主动替他决定该沉淀什么：'
        + '提得太多，审的人就不看了。'
        + '\n\n**交上去不会立刻生效**，它进的是待确认列表，要公司管理员在 Aloof 网页上'
        + '接受之后，才会下发到团队每个人的 agent。所以复述结果时说「已提交给团队审核」，'
        + '别说「已经加好了」。'
        + '\n\n两类别搞混：`skill`（手册）是「要做某件事时照着办」的步骤，按需加载，'
        + '写多长都行——绝大多数贡献都是这一类。`rule`（红线）是「所有人任何时候都不许/'
        + '必须」的硬约束，它每次请求都会塞进系统提示，所以只有真正全局的约束才配得上，'
        + '而且要短。拿不准就用 `skill`。',
      parameters: {
        kind: {
          type: 'string',
          enum: ['skill', 'rule'],
          description: '`skill` = 手册（按需加载的做法，默认选它）；`rule` = 红线（全局硬约束，要短）',
        },
        name: {
          type: 'string',
          description:
            '稳定标识，**必须是 kebab-case**（小写字母数字加连字符，如 `weekly-report`）。'
            + '**如果团队里已经有同名的一份，这次就是「修改」那一份**——'
            + '想补充现有手册就用它现在的名字（你在技能目录里看到的那个名字）。',
        },
        title: { type: 'string', description: '给人看的标题，如「周报怎么写」' },
        description: {
          type: 'string',
          description:
            '**什么时候该用这份手册**（手册必填）。团队里其他人的 agent 全靠这一句决定'
            + '要不要读正文，所以要写触发场景（「写周报、月报或任何进度汇报时用」），'
            + '不要写成内容摘要。',
        },
        body: { type: 'string', description: '正文（markdown）。手册就是那份步骤本身' },
        rationale: {
          type: 'string',
          description:
            '**为什么提这一条**（必填）。审的人靠它判断，写清楚来由（「上周三个人各写一套'
            + '周报格式，对不上」）比复述内容有用。',
        },
      },
      output: {
        schema: OPEN_OBJECT,
        // 直接用后端那句话，不在这儿另写一遍。两处各写一份的话，「还没生效」这个最要紧的
        // 信息迟早有一处会被改丢。
        render: (_args, v) => [{ type: 'text', text: v.message }],
      },
      async execute(args, exec) {
        for (const key of ['kind', 'name', 'title', 'body', 'rationale']) {
          if (typeof args[key] !== 'string' || args[key].trim() === '') {
            throw new Error(`参数 ${key} 不能为空`)
          }
        }
        // kebab-case 在后端也拦（422），但那句报错是给人看的。在这儿先拦一次，模型能当场
        // 改对重试，不用往返一趟。
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(args.name)) {
          throw new Error(
            `name "${args.name}" 不是 kebab-case：只能小写字母、数字和连字符，`
            + `比如 ${args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'weekly-report'}`,
          )
        }
        return await api('POST', '/api/context/proposals', {
          body: {
            kind: args.kind === 'rule' ? 'rule' : 'skill',
            name: args.name,
            title: args.title,
            description: args.description ?? null,
            body: args.body,
            rationale: args.rationale,
          },
          signal: exec.signal,
        })
      },
    }),
  ]

  for (const t of registrations) ctx.tools.register(t)

  /**
   * 连接状态的**唯一事实来源**，`/aloof` 和界面都读它，保证两处口径一致。
   *
   * 关键约束：**返回值里绝不含密钥**。`prefix` 是明文前 10 位（`alf_` + 6），后端自己就是
   * 这么存的、网页票列表上显示的也是它，用来「认出是哪一张」——够对行，不够冒用。
   *
   * 不抛异常：连不上也是一种状态，不是错误。调用方要渲染「连不上 + 为什么」，用异常表达
   * 会让每个调用方都得写一遍 try/catch 再把 message 抠出来。
   * @param {AbortSignal} [signal] 调用方的取消信号
   */
  async function status(signal) {
    // 下发状态也报出来。**连上了不等于下发成功**：票是好的、但一条规矩都没配，或者
    // 上一次拉取失败正在按旧内容跑——这两种都要分得出来，不然「为什么 agent 没照规矩来」
    // 只能靠猜。
    const delivered = {
      revision: team.revision,
      ruleCount: team.ruleCount,
      ruleChars: team.ruleChars,
      skills: team.skills.map((s) => s.name),
      syncedAt: team.syncedAt,
      error: team.error,
    }

    let where
    try {
      where = await resolve()
    } catch (error) {
      // 连地址都没解析出来（没配票 / 票不带地址）：这时候连「打算连哪」都说不出。
      return { connected: false, base: null, prefix: null, tokenRef: ref, user: null,
        team: delivered, error: error instanceof Error ? error.message : String(error) }
    }
    const shape = { base: where.base, prefix: where.prefix, tokenRef: ref, team: delivered }
    try {
      const me = await api('GET', '/api/auth/me', { signal })
      return { connected: true, ...shape, user: me, proposals: await proposals(signal), error: null }
    } catch (error) {
      return { connected: false, ...shape, user: null, proposals: null,
        error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * 「有几条还在等人确认」。**失败就当没有，不影响状态**。
   *
   * 这个数字负责闭掉贡献那个环：交完一条之后人想知道批了没，没有它他只能去开网页——
   * 而如果他得开网页才能知道结果，那「就地贡献」省下的那点摩擦又还回去了。
   *
   * 容错到 `null` 是刻意的：对着一台**旧版 Aloof**（还没有提案功能）这里是 404，那时该显示的
   * 是「连上了」而不是「连不上」。让一个附加信息的缺失把主状态判成故障，是很常见的自伤。
   * @param {AbortSignal} [signal] 调用方的取消信号
   */
  async function proposals(signal) {
    try {
      return await api('GET', '/api/context/proposals/count', { signal })
    } catch {
      return null
    }
  }

  /**
   * `GET /dsh-aloof/status` —— 给 dsh 界面用的同源接口。
   *
   * **为什么要绕这一道，不让浏览器直连 Aloof**：票在 `$DSH_HOME/.credentials.yaml` 里，是
   * 服务端的东西。让页面自己去调 Aloof 就得把票发到浏览器，那它就会躺在 devtools、扩展、
   * 以及任何 XSS 的射程内——而且这张票的权限比页面需要的大得多。这里只把**结论**发给页面。
   *
   * 嵌套 inject 同 commands：没有 web 服务的装配（纯 CLI）不该因此整个插件挂不上。
   */
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: '/dsh-aloof/status',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        const body = JSON.stringify(await status())
        // no-store：这是「现在通不通」，缓存一份旧的等于骗人。
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(body)
      },
    }), 'dsh-aloof: status route')
  })

  /**
   * `/aloof` —— 给**人**看的连接状态。
   *
   * 为什么工具之外还要一条命令：`aloof_whoami` 是给模型的，人要看状态只能开口问，而模型会
   * 把「连不上」误诊成别的东西（真实发生过：票指着一台到不了的机器，模型一路查到 TLS 证书
   * 和代理规则，全对，但都不是根因）。这条命令是**确定性的**——同样的输入永远同样的输出，
   * 不经过模型，也不花 token。
   *
   * 挂在嵌套 inject 里：命令服务不在的装配（无头 / ACP）只是没有这条命令，两个工具照常工作。
   */
  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'aloof',
      description: '看这台 dsh 连的是哪个 Aloof、认出我是谁、下发了哪些团队规矩',
      handler: async (invocation) => {
        const s = await status(invocation.signal)

        // 地址解析都没过（没配票）：没有地址可报，直接把那句怎么配透出去。
        if (s.base === null) return { kind: 'error', text: s.error }

        const lines = [`地址　${s.base}`, `用票　${s.prefix}…`]
        if (s.connected) {
          return {
            kind: 'success',
            text: [
              'Aloof：已连上',
              ...lines,
              // 标记写「有管理权限」而不是「管理员」：显示名本身可能就叫「管理员」（种子账号
              // 就是），复述一遍读起来像卡碟。说能力则两种名字下都通顺。
              `身份　${s.user.name}（${s.user.username}）${s.user.isAdmin ? ' · 有管理权限' : ''}`,
              `下发　${delivery(s.team)}`,
              ...waiting(s.proposals, s.user.isAdmin),
            ].join('\n'),
          }
        }
        return {
          kind: 'error',
          text: [
            'Aloof：连不上',
            ...lines,
            `报错　${s.error}`,
            // 连不上时也报下发状态。**「连不上」不等于「规矩没了」**：上一次拉到的内容还在
            // 生效（刻意的——红线多半是「不许做什么」，Aloof 一挂就把约束全撤了更危险）。
            // 不说这一句，人会以为这段时间 agent 是完全放开的。
            `下发　${delivery(s.team)}`,
            '',
            '排查顺序：先看上面那个地址对不对（换过环境的话很可能是旧票），再查网络。',
            '改 .credentials.yaml 不用重启 dsh（它盯着文件热更新）；'
            + '要是改了地址还没变，多半有个同名环境变量压着它——那份只有重启才换。',
          ].join('\n'),
        }
      },
    })
  })
}
