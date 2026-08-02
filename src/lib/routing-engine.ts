import { db } from '@/lib/db'
import { publishToRealtime, room, EVENTS } from '@/lib/realtime-publish'

/**
 * Routing engine — evaluates trigger→action rules when a conversation is created.
 *
 * MVP triggers supported:
 *   - { event: "conversation_created", conditions: { keyword: "support" } }
 *   - { event: "conversation_created", conditions: { businessHours: { start: 9, end: 17 } } }
 *
 * MVP actions supported:
 *   - { type: "assign_department", departmentId: "..." }
 *   - { type: "assign_user", userId: "..." }
 *   - { type: "add_tag", tag: "urgent" }
 *   - { type: "send_message", text: "..." }
 *
 * Rules are evaluated in priority order. The first matching rule's action is
 * executed. Multiple rules can match if they have different action types.
 */

interface RoutingCondition {
  keyword?: string
  businessHours?: { start: number; end: number; tz?: string }
}

interface RoutingAction {
  type: 'assign_department' | 'assign_user' | 'add_tag' | 'send_message'
  departmentId?: string
  userId?: string
  tag?: string
  text?: string
}

interface RoutingRule {
  trigger: { event: string; conditions?: RoutingCondition }
  action: RoutingAction
}

/**
 * Evaluates all enabled routing rules for a tenant against a new conversation.
 * Called after conversation creation. Does NOT throw — routing failures are
 * logged but don't block the conversation.
 */
export async function evaluateRoutingRules(
  conversationId: string,
  tenantId: string,
  firstMessageText: string,
): Promise<void> {
  try {
    const rules = await db.routingRule.findMany({
      where: { tenantId, enabled: true },
      orderBy: { priority: 'asc' },
    })

    if (rules.length === 0) return

    const hour = new Date().getHours()

    for (const rule of rules) {
      const config = rule.trigger as unknown as RoutingRule['trigger']
      const conditions = config.conditions || {}
      const matches = matchConditions(conditions, firstMessageText, hour)
      if (!matches) continue

      const action = rule.action as unknown as RoutingAction
      await executeAction(action, conversationId, tenantId, firstMessageText)
    }
  } catch (e) {
    console.error('[routing] rule evaluation failed:', e instanceof Error ? e.message : e)
  }
}

function matchConditions(conditions: RoutingCondition, text: string, hour: number): boolean {
  // No conditions = always matches
  if (!conditions.keyword && !conditions.businessHours) return true

  if (conditions.keyword) {
    if (!text.toLowerCase().includes(conditions.keyword.toLowerCase())) return false
  }

  if (conditions.businessHours) {
    const { start, end } = conditions.businessHours
    if (hour < start || hour >= end) return false
  }

  return true
}

async function executeAction(
  action: RoutingAction,
  conversationId: string,
  tenantId: string,
  _firstMessageText: string,
): Promise<void> {
  switch (action.type) {
    case 'assign_department': {
      if (action.departmentId) {
        await db.conversation.updateMany({
          where: { id: conversationId, tenantId },
          data: { departmentId: action.departmentId },
        })
      }
      break
    }
    case 'assign_user': {
      if (action.userId) {
        await db.conversation.updateMany({
          where: { id: conversationId, tenantId },
          data: { assignedUserId: action.userId },
        })
        // Auto-add as participant — tenantId explicit
        await db.participant.upsert({
          where: { conversationId_userId: { conversationId, userId: action.userId } },
          create: { conversationId, userId: action.userId, tenantId },
          update: {},
        })
      }
      break
    }
    case 'add_tag': {
      if (action.tag) {
        const conv = await db.conversation.findFirst({ where: { id: conversationId, tenantId } })
        if (conv) {
          const tags = (conv.tags as string[]) || []
          if (!tags.includes(action.tag)) {
            tags.push(action.tag)
            await db.conversation.updateMany({
              where: { id: conversationId, tenantId },
              data: { tags },
            })
          }
        }
      }
      break
    }
    case 'send_message': {
      if (action.text) {
        // System message — tenantId explicit
        const message = await db.message.create({
          data: {
            conversationId,
            tenantId,
            senderType: 'system',
            senderUserId: null,
            contentType: 'text',
            content: { text: action.text },
            status: 'sent',
          },
        })
        await publishToRealtime({
          room: room.conversation(conversationId),
          event: EVENTS.MESSAGE_NEW,
          payload: { ...message },
        })
      }
      break
    }
  }

  // Notify the dashboard that the conversation was updated (assignment/tag changed)
  await publishToRealtime({
    room: room.tenant(tenantId),
    event: EVENTS.CONVERSATION_UPDATED,
    payload: { conversationId },
  })
}
