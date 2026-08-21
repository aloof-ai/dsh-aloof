/**
 * 团队上下文下发的**契约测试**：喂一个假 ctx 和假 Aloof，检查插件到底往 dsh 里注册了什么。
 *
 * 为什么这几条值得测（而不是「读一遍代码确认」）：
 *
 * - **字段映射**。dsh 那边技能正文的字段叫 `content`，我们的接口叫 `body`。写错不会报错，
 *   只是注册上去的手册**正文是空的**——而这发生在用户的机器上，我们看不到任何异常。
 * - **重注册的时机**。技能是列表，内容变了必须整批换掉；而红线走的是「注册一个函数、每次
 *   现读」，永远不该重注册。这两条搞反的后果分别是「改了不生效」和「有一瞬间规矩是空的」，
 *   都不会抛异常。
 * - **拉不到时保持上一次的内容**。这是刻意的降级（红线多半是「不许做什么」，Aloof 一挂就
 *   把约束全撤了更危险）。一次「顺手改成清空」的重构不会让任何测试变红，除了这一条。
 *
 * 没有真 dsh 参与，所以这里**不验证** dsh 是否接受这些参数——那由 `@deepseek-ai/dsh-skill`
 * 和 `dsh-system-prompt` 的类型定义保证，实跑时也第一时间就会炸。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply } from '../index.js'

const TICKET = 'alf_TESTKEY0123@http://127.0.0.1:9999'

const RULES = '以下是你所在团队通过 Aloof 下发的规矩\n\n## 客户数据不外发\n不得外发。'

function payload(over = {}) {
  return {
    revision: 'rev-1',
    rules: RULES,
    ruleCount: 1,
    ruleChars: RULES.length,
    skills: [{ name: 'weekly-report', description: '写周报时用', body: '# 周报\n三段。' }],
    generatedAt: new Date().toISOString(),
    ...over,
  }
}

/** 让 fire-and-forget 的那次同步跑完（fetch → text → json 都是微任务链）。 */
async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 装一个够用的假 ctx，并把插件挂上去。
 *
 * 触发后续同步用的是 `credentials/updated` 事件而不是快进定时器：那个事件本来就是插件的
 * 一条真实入口（人刚换了票），拿它当测试的把手比 mock 时钟更贴近实际。
 * @param {(url: string) => any} respond 假 Aloof：返回响应体，或抛错表示这次拉取失败
 */
function harness(respond) {
  const sections = []
  const skills = []
  /** 每次 `skills.register` 的 disposer 被调用就记一笔，用来断言「有没有重注册」。 */
  const disposed = []
  const listeners = new Map()
  const teardown = []

  const service = { resolve: async () => ({ value: TICKET }) }

  const scoped = {
    effect(run) {
      const off = run()
      if (typeof off === 'function') teardown.push(off)
      return off
    },
    get: () => service,
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    skills: {
      register(skill) {
        skills.push(skill)
        return () => {
          disposed.push(skill.name)
          const at = skills.indexOf(skill)
          if (at >= 0) skills.splice(at, 1)
        }
      },
    },
    tools: { register: () => {} },
    commands: { register: () => {} },
    webServer: { register: () => () => {} },
  }

  const ctx = {
    ...scoped,
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    inject(_names, run) {
      run(scoped)
    },
    on(name, handler) {
      listeners.set(name, handler)
    },
  }

  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const body = respond(String(url))
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    }
  }

  apply(ctx, {})

  return {
    sections,
    skills,
    disposed,
    /** 模拟「人换了票」，插件应当立刻重新拉一次。 */
    async touch() {
      listeners.get('credentials/updated')?.('ALOOF_TOKEN')
      await settle()
    },
    stop() {
      globalThis.fetch = realFetch
      for (const off of teardown) off()
    },
  }
}

describe('团队上下文下发', () => {
  it('红线注册成一个可重算的 section，手册按条注册进技能目录', async () => {
    const h = harness(() => payload())
    await settle()

    const rules = h.sections.find((s) => s.name === 'aloof:team-rules')
    assert.ok(rules, '红线的 section 必须注册，哪怕这一刻还没拉到内容')
    // 排在部署人格（order 0）之后、工具指引（100+）之前
    assert.equal(rules.order, 50)
    // **必须是函数**：内容更新时靠「每次组装现读」生效，不靠重注册
    assert.equal(typeof rules.text, 'function')
    assert.match(rules.text(), /客户数据不外发/)

    assert.equal(h.skills.length, 1)
    const skill = h.skills[0]
    assert.equal(skill.name, 'weekly-report')
    assert.equal(skill.description, '写周报时用')
    // 我们的 `body` 要落到 dsh 的 `content` 上——写错的话手册正文就是空的
    assert.match(skill.content, /三段/)
    assert.equal(skill.body, undefined)
    // 出处标签，不影响优先级（rank 由 register() 写死）；同名被顶掉时的 warning 靠它说清来源
    assert.equal(skill.source, 'aloof')
    assert.equal(skill.provider, 'aloof')

    h.stop()
  })

  it('内容变了整批换掉技能，红线的 section 不重注册', async () => {
    let current = payload()
    const h = harness(() => current)
    await settle()
    const sectionsAfterFirst = h.sections.length

    current = payload({
      revision: 'rev-2',
      skills: [
        { name: 'weekly-report', description: '写周报时用', body: '# 周报\n改成两段。' },
        { name: 'code-review', description: '评审代码时用', body: '先看接口。' },
      ],
    })
    await h.touch()

    assert.deepEqual(h.skills.map((s) => s.name), ['weekly-report', 'code-review'])
    assert.match(h.skills[0].content, /两段/)
    // 旧的那份被 dispose 掉了，不是留在目录里和新的重名打架
    assert.deepEqual(h.disposed, ['weekly-report'])
    // 红线是同一个 section 从头到尾，没有「注销再注册」之间那道缝
    assert.equal(h.sections.length, sectionsAfterFirst)

    h.stop()
  })

  it('内容没变就不动技能目录', async () => {
    const h = harness(() => payload())
    await settle()
    await h.touch()

    assert.equal(h.skills.length, 1)
    assert.deepEqual(h.disposed, [], '指纹一样就不该白重注册一遍')

    h.stop()
  })

  it('拉不到的时候保持上一次的内容，不清空', async () => {
    let broken = false
    const h = harness(() => {
      if (broken) throw new Error('Aloof 挂了')
      return payload()
    })
    await settle()

    broken = true
    await h.touch()

    const rules = h.sections.find((s) => s.name === 'aloof:team-rules')
    // 红线绝大多数是「不许做什么」。Aloof 不可用的这段时间清空规矩，等于把约束全撤了——
    // 那比按一份稍旧的规矩走危险得多。
    assert.match(rules.text(), /客户数据不外发/)
    assert.equal(h.skills.length, 1)

    h.stop()
  })
})
