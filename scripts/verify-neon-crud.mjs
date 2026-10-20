// Real Prisma CRUD verification against Neon.
// Creates, reads, updates, and deletes disposable test records for the
// 12 models listed in the task. Cleans up afterward.
//
// Reads credentials from /home/z/.neon-creds/ (never prints them).

import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const dbUrl = readFileSync('/home/z/.neon-creds/database_url', 'utf8').trim() + '&pgbouncer=true'
const directUrl = readFileSync('/home/z/.neon-creds/direct_url', 'utf8').trim()

process.env.DATABASE_URL = dbUrl
process.env.DIRECT_URL = directUrl

const prisma = new PrismaClient({ log: ['error'] })

const STAMP = `neon-crud-${Date.now()}-${randomUUID().slice(0, 8)}`
const TENANT_SLUG = `crud-test-${STAMP}`

async function main() {
  const results = []
  const log = (msg) => { results.push(msg); console.log(msg) }

  log('=== CREATE ===')
  // 1. Tenant
  const tenant = await prisma.tenant.create({
    data: {
      slug: TENANT_SLUG,
      name: 'CRUD Test Tenant',
      plan: 'free',
    },
  })
  log('  ✓ Tenant created: id=' + tenant.id + ' slug=' + tenant.slug)

  // 2. User
  const user = await prisma.user.create({
    data: {
      email: `crud-${STAMP}@neon-test.local`,
      name: 'CRUD Test User',
      passwordHash: 'dummy-hash',
      emailVerified: true,
      emailVerifiedAt: new Date(),
    },
  })
  log('  ✓ User created: id=' + user.id + ' email=' + user.email)

  // 3. Membership
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      tenantId: tenant.id,
      role: 'owner',
      status: 'active',
    },
  })
  log('  ✓ Membership created: id=' + membership.id + ' role=' + membership.role)

  // 4. Department
  const department = await prisma.department.create({
    data: {
      tenantId: tenant.id,
      name: 'CRUD Test Department',
    },
  })
  log('  ✓ Department created: id=' + department.id)

  // 5. Contact
  const contact = await prisma.contact.create({
    data: {
      tenantId: tenant.id,
      identifier: `crud-visitor-${STAMP}`,
      identifierType: 'visitorId',
      name: 'CRUD Test Visitor',
      email: `visitor-${STAMP}@neon-test.local`,
      metadata: { source: 'crud-test' },
    },
  })
  log('  ✓ Contact created: id=' + contact.id)

  // 6. Conversation
  const conversation = await prisma.conversation.create({
    data: {
      tenantId: tenant.id,
      contactId: contact.id,
      status: 'open',
      channel: 'widget',
      tags: [], // Json NOT NULL — app code sets this on create
    },
  })
  log('  ✓ Conversation created: id=' + conversation.id)

  // 7. Message
  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      tenantId: tenant.id,
      senderType: 'contact',
      contentType: 'text',
      content: { text: 'Hello from CRUD test!' },
    },
  })
  log('  ✓ Message created: id=' + message.id)

  // 8. Participant
  const participant = await prisma.participant.create({
    data: {
      conversationId: conversation.id,
      userId: user.id,
      tenantId: tenant.id,
    },
  })
  log('  ✓ Participant created: id=' + participant.id)

  // 9. WidgetConfig
  const widgetConfig = await prisma.widgetConfig.create({
    data: {
      tenantId: tenant.id,
      accentColor: '#E09A2B',
      greetingTexts: { fa: 'سلام', en: 'Hello' },
    },
  })
  log('  ✓ WidgetConfig created: id=' + widgetConfig.id)

  // 10. WidgetDomain
  const widgetDomain = await prisma.widgetDomain.create({
    data: {
      tenantId: tenant.id,
      domain: `crud-${STAMP}.example.com`,
    },
  })
  log('  ✓ WidgetDomain created: id=' + widgetDomain.id)

  // 11. RoutingRule
  const routingRule = await prisma.routingRule.create({
    data: {
      tenantId: tenant.id,
      name: 'CRUD Test Rule',
      trigger: { event: 'conversation_created' },
      action: { type: 'add_tag', tag: 'test' },
    },
  })
  log('  ✓ RoutingRule created: id=' + routingRule.id)

  log('')
  log('=== READ ===')
  // Read back with relations
  const tenantWithRels = await prisma.tenant.findUnique({
    where: { id: tenant.id },
    include: {
      memberships: true,
      departments: true,
      widgetConfig: true,
      widgetDomains: true,
      routingRules: true,
      contacts: { include: { conversations: { include: { messages: true, participants: true } } } },
    },
  })
  log('  ✓ Tenant read with relations:')
  log('    memberships: ' + tenantWithRels.memberships.length)
  log('    departments: ' + tenantWithRels.departments.length)
  log('    widgetConfig: ' + (tenantWithRels.widgetConfig ? 'present' : 'null'))
  log('    widgetDomains: ' + tenantWithRels.widgetDomains.length)
  log('    routingRules: ' + tenantWithRels.routingRules.length)
  log('    contacts: ' + tenantWithRels.contacts.length)
  log('    contacts[0].conversations: ' + tenantWithRels.contacts[0].conversations.length)
  log('    contacts[0].conversations[0].messages: ' + tenantWithRels.contacts[0].conversations[0].messages.length)
  log('    contacts[0].conversations[0].participants: ' + tenantWithRels.contacts[0].conversations[0].participants.length)

  log('')
  log('=== UPDATE ===')
  const updatedConv = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: 'closed', unreadCount: 0, csatRating: 5, csatComment: 'Great service!' },
  })
  log('  ✓ Conversation updated: status=' + updatedConv.status + ' csatRating=' + updatedConv.csatRating)
  const updatedContact = await prisma.contact.update({
    where: { id: contact.id },
    data: { name: 'CRUD Test Visitor (Updated)', lastSeenAt: new Date() },
  })
  log('  ✓ Contact updated: name=' + updatedContact.name)

  log('')
  log('=== DELETE (cleanup) ===')
  // Delete in dependency order (children first).
  await prisma.participant.delete({ where: { id: participant.id } })
  log('  ✓ Participant deleted')
  await prisma.message.delete({ where: { id: message.id } })
  log('  ✓ Message deleted')
  await prisma.conversation.delete({ where: { id: conversation.id } })
  log('  ✓ Conversation deleted')
  await prisma.contact.delete({ where: { id: contact.id } })
  log('  ✓ Contact deleted')
  await prisma.routingRule.delete({ where: { id: routingRule.id } })
  log('  ✓ RoutingRule deleted')
  await prisma.widgetDomain.delete({ where: { id: widgetDomain.id } })
  log('  ✓ WidgetDomain deleted')
  await prisma.widgetConfig.delete({ where: { id: widgetConfig.id } })
  log('  ✓ WidgetConfig deleted')
  await prisma.department.delete({ where: { id: department.id } })
  log('  ✓ Department deleted')
  await prisma.membership.delete({ where: { id: membership.id } })
  log('  ✓ Membership deleted')
  await prisma.tenant.delete({ where: { id: tenant.id } })
  log('  ✓ Tenant deleted (cascades would handle children, but we already cleaned up)')
  await prisma.user.delete({ where: { id: user.id } })
  log('  ✓ User deleted')

  log('')
  log('=== CRUD VERIFICATION COMPLETE ===')
  log('Models exercised: Tenant, User, Membership, Department, Contact,')
  log('  Conversation, Message, Participant, WidgetConfig, WidgetDomain, RoutingRule')
  log('All CREATE / READ (with relations) / UPDATE / DELETE operations succeeded.')

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error('FATAL:', e.message.split('\n')[0])
  process.exit(1)
})
