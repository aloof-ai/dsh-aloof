/**
 * Aloof → DeepSeek Harness（dsh）原生工具。
 *
 * **这一版只做「连上」这件事**：两个只读工具，用来确认这台 dsh 真的接到了公司那台 Aloof
 * 上、而且认出了是谁。团队资料库的读写工具跟着资料库那一期一起来。
 *
 * 写操作到时候会走 dsh 的审批闸门（`ctx.approval`）——模型不能悄悄改团队的东西。现在没有
 * 写工具，所以那段代码也不在这儿：没有调用者的「安全设施」只是让人误以为有防护。
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
}

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
    let where
    try {
      where = await resolve()
    } catch (error) {
      // 连地址都没解析出来（没配票 / 票不带地址）：这时候连「打算连哪」都说不出。
      return { connected: false, base: null, prefix: null, tokenRef: ref, user: null,
        error: error instanceof Error ? error.message : String(error) }
    }
    const shape = { base: where.base, prefix: where.prefix, tokenRef: ref }
    try {
      const me = await api('GET', '/api/auth/me', { signal })
      return { connected: true, ...shape, user: me, error: null }
    } catch (error) {
      return { connected: false, ...shape, user: null,
        error: error instanceof Error ? error.message : String(error) }
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
      description: '看这台 dsh 连的是哪个 Aloof、认出我是谁',
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
            ].join('\n'),
          }
        }
        return {
          kind: 'error',
          text: [
            'Aloof：连不上',
            ...lines,
            `报错　${s.error}`,
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
