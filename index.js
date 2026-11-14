/**
 * Host half of the mode-switch bundle.
 *
 * Registers the `/mode` command: switch the current task to another Agent preset,
 * including a task that has already started. The switch goes through
 * agentPresets.recompose(), so this plugin owns the guards itself: no switch while a
 * turn is open, switches are serialized per Session, the change is logged as
 * agent-preset/selected, and the next admitted step restarts the request series so the
 * new tool catalog is not announced as deferred additions.
 * Command text is bilingual because the Host half has no locale service.
 */
export const inject = ['commands', 'agentPresets', 'agents']

/** The command name; `mode` is free among the shipped commands. */
const COMMAND = 'mode'

/** Render one thrown value as a short message. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** Read a value, treating a throw as absent (a service may detach mid-call). */
const safely = (read) => {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Read the preset roster defensively: a deployment without the registry has none.
 * @param ctx - the plugin context carrying `agentPresets`.
 * @returns the presets that can compose a session.
 */
async function usablePresets(ctx) {
  const roster = await ctx.agentPresets.remoteExportList()
  const rows = Array.isArray(roster?.presets) ? roster.presets : []
  return rows.filter((row) => row !== null && typeof row === 'object' && typeof row.broken !== 'string')
}

/**
 * Mount the `/mode` command and the series-restart listener.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  /**
   * Sessions whose next admitted step must start a new request series: the tool
   * catalog changed under them, so the recorded series can no longer describe it.
   * Keyed by Session id, which outlives Agent re-creation.
   */
  const pendingSeries = new Set()

  /** Per-Session switch chains, so two `/mode` calls cannot interleave their binds. */
  const switches = new Map()

  // Waterfall listener: take the downstream decision first, so every other listener
  // keeps its say, and only wrap the result for a session that switched.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const agent = payload?.agent
    if (agent === undefined || agent.session === undefined) return decision
    if (decision?.kind !== 'enter') return decision
    if (!pendingSeries.has(agent.session.id)) return decision
    // A step the loop will abandon (cancelled, or an empty admission) never becomes a
    // request, so consuming the mark there would silently drop the series restart.
    if (payload.signal?.aborted === true) return decision
    if (Array.isArray(decision.messages) && decision.messages.length === 0) return decision
    pendingSeries.delete(agent.session.id)
    // Spread the downstream decision so its own fields survive; the only field this
    // listener owns is the series restart it was asked for.
    return { ...decision, startsRequestSeries: true }
  })

  // The registry's own bookkeeping, so a session that switches and never runs again
  // does not keep an entry forever.
  ctx.on('agent/disposed', ({ agent }) => {
    const id = agent?.session?.id
    if (id === undefined) return
    pendingSeries.delete(id)
    switches.delete(id)
  })

  /** True when this Agent has no open turn right now. */
  function turnIsOpen(agent) {
    if (agent.status === 'running') return true
    const boundary = safely(() => ctx.agents.turnBoundaryOf(agent.session))
    return boundary !== undefined && boundary.openTurnStartSeq !== null
  }

  /**
   * Re-compose one Agent, log the change, and arm the series restart.
   * @param agent - the receiving Agent.
   * @param target - the roster row to switch to.
   * @returns the command result the UI renders.
   */
  async function applySwitch(agent, target) {
    const sessionId = agent.session.id
    // Arm the restart BEFORE awaiting: a prompt admitted during the await must not
    // send a request built from the new catalog and the old series.
    pendingSeries.add(sessionId)
    let preset
    try {
      preset = await ctx.agentPresets.recompose(agent.ctx, target.id)
    } catch (error) {
      // `bind` may have landed before the throw (it mutates the scope parent, then
      // awaits collection), so ask the registry what the Agent now runs instead of
      // assuming nothing happened.
      const composed = safely(() => ctx.agentPresets.composedPreset(agent.ctx))
      if (composed !== target.id) {
        pendingSeries.delete(sessionId)
        return { kind: 'error', text: `切换到 ${target.id} 失败 / Failed to switch to ${target.id}: ${messageOf(error)}` }
      }
      pendingSeries.add(sessionId)
      try {
        agent.session.append('agent-preset/selected', { agentPreset: target.id })
      } catch (appendError) {
        return {
          kind: 'error',
          text: `已重新组合为 ${target.id}，但记录切换事件失败 / Re-composed to ${target.id} but logging the switch failed: ${messageOf(appendError)}`,
        }
      }
      return {
        kind: 'success',
        text: `已切换到 ${target.id}（切换过程中报告过一次错误）/ Switched to ${target.id} (one error was reported mid-switch): ${messageOf(error)}`,
      }
    }

    // Log the identity the registry actually bound, not the one that was requested.
    const bound = typeof preset?.id === 'string' && preset.id !== '' ? preset.id : target.id
    try {
      agent.session.append('agent-preset/selected', { agentPreset: bound })
    } catch (error) {
      // The composition already changed; an unlogged change would be the worse
      // outcome, so report it instead of claiming success.
      return {
        kind: 'error',
        text: `已重新组合为 ${bound}，但记录切换事件失败 / Re-composed to ${bound} but logging the switch failed: ${messageOf(error)}`,
      }
    }

    return {
      kind: 'success',
      text: `已切换到 ${bound}：工具与提示词已重新组合，下一次请求会重建工具声明 / Switched to ${bound}: tools and prompt sections were re-composed; the next request rebuilds the tool declarations.`,
    }
  }

  /**
   * Switch one live Agent to another preset.
   * @param agent - the receiving Agent (the task whose mode is being switched).
   * @param rawInput - the command's argument text: a preset id, or empty to report.
   * @returns the command result the UI renders.
   */
  async function switchPreset(agent, rawInput) {
    const requested = typeof rawInput === 'string' ? (rawInput.trim().split(/\s+/)[0] ?? '') : ''

    let presets
    try {
      presets = await usablePresets(ctx)
    } catch (error) {
      return { kind: 'error', text: `无法读取模式名册 / Cannot read the preset roster: ${messageOf(error)}` }
    }
    const ids = presets.map((preset) => preset.id)
    const current = safely(() => ctx.agentPresets.presetForSession(agent.session)) ?? 'unknown'

    if (requested === '' || requested === 'list') {
      return {
        kind: 'success',
        text:
          ids.length === 0
            ? `当前模式 / current: ${current}；没有可切换的模式 / no switchable presets`
            : `当前模式 / current: ${current}；可切换 / switchable: ${ids.join(', ')}`,
      }
    }

    const target = presets.find((preset) => preset.id === requested)
    if (target === undefined) {
      return { kind: 'error', text: `未知模式 / Unknown mode "${requested}"; switchable: ${ids.join(', ')}` }
    }
    if (turnIsOpen(agent)) {
      return {
        kind: 'error',
        text: '当前任务正在执行，等这一轮结束后再切换模式 / This task is running; switch the mode after the turn ends.',
      }
    }

    const composed = safely(() => ctx.agentPresets.composedPreset(agent.ctx))
    if (current === target.id && composed === target.id) {
      // Nothing to re-compose, but the recorded request series may still describe an
      // older catalog (a switch made before this fix, or a first request that failed on
      // all-deferred tools). One series restart is the cheapest repair, so an explicit
      // click on the current mode doubles as "rebuild the tool declarations".
      pendingSeries.add(agent.session.id)
      return {
        kind: 'success',
        text: `当前任务已经是 ${target.id}；已安排在下一次请求时重建工具声明 / Already running ${target.id}; a request-series rebuild is scheduled for the next request.`,
      }
    }

    // Serialize per Session: `recompose` mutates the scope parent and then awaits
    // collection, so two overlapping switches could bind in one order and log in
    // another, leaving the projection and the composition permanently disagreeing.
    const sessionId = agent.session.id
    const previous = switches.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => applySwitch(agent, target),
      () => applySwitch(agent, target),
    )
    switches.set(
      sessionId,
      task.then(
        () => undefined,
        () => undefined,
      ),
    )
    return task
  }

  ctx.commands.register({
    name: COMMAND,
    description: 'Switch this task to another agent preset, even after it has started.',
    input: { hint: '<preset id>' },
    // The invocation signal is intentionally not threaded into `recompose`: a UI
    // cancellation must not leave a half-applied composition, so the switch runs to
    // completion and the result still lands in the Session log.
    handler: ({ agent, rawInput }) => switchPreset(agent, rawInput),
  })
}
