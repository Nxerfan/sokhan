'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSession } from 'next-auth/react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { UserPlus } from 'lucide-react'
import { toast } from 'sonner'

type Member = {
  id: string
  role: string
  status: string
  user: { id: string; name: string | null; email: string }
}

const ROLES = ['owner', 'admin', 'manager', 'agent', 'viewer']

export function MembersPanel() {
  const t = useTranslations('settings')
  const tc = useTranslations('common')
  const { data: session } = useSession()
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('agent')
  const [inviting, setInviting] = useState(false)

  async function load() {
    const res = await fetch('/api/members')
    const data = await res.json()
    setMembers(data.members ?? [])
    setLoading(false)
  }

  useEffect(() => { // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [])

  async function onInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviting(true)
    const res = await fetch('/api/members', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? 'Failed to invite')
      setInviting(false)
      return
    }
    toast.success(t('saved'))
    setInviteEmail('')
    setInviting(false)
    load()
  }

  async function onRoleChange(memberId: string, role: string) {
    const res = await fetch('/api/members', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId, role }),
    })
    if (!res.ok) {
      toast.error('Failed to update role')
      return
    }
    toast.success(t('saved'))
    load()
  }

  const currentUserId = session?.user?.id

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <PanelHeader title={t('membersTitle')} hint={t('membersHint')} />

      <Card>
        <CardHeader>
          <CardTitle className="font-display text-base">{t('inviteEmail')}</CardTitle>
          <CardDescription>{t('membersHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onInvite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="invite-email" className="sr-only">
                {t('inviteEmail')}
              </Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="agent@example.com"
                required
                dir="ltr"
              />
            </div>
            <div className="w-full sm:w-40">
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.filter((r) => r !== 'owner').map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`roles.${r}` as any)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={inviting} className="gap-2">
              <UserPlus className="h-4 w-4" />
              {tc('create')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="font-display text-base">{t('membersTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">{tc('loading')}</div>
          ) : members.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">{t('noMembers')}</div>
          ) : (
            <ul className="divide-y divide-border">
              {members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 p-4">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-9 w-9">
                      <AvatarFallback className="bg-turquoise/15 text-xs">
                        {(m.user.name || m.user.email).slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {m.user.name || m.user.email}
                      </p>
                      <p className="truncate text-xs text-muted-foreground" dir="ltr">
                        {m.user.email}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {m.user.id === currentUserId && (
                      <Badge variant="outline" className="text-xs">
                        {t('roles.owner')}
                      </Badge>
                    )}
                    {m.role === 'owner' ? (
                      <Badge className="bg-saffron/20 text-saffron-foreground">
                        {t('roles.owner')}
                      </Badge>
                    ) : (
                      <Select
                        value={m.role}
                        onValueChange={(role) => onRoleChange(m.id, role)}
                      >
                        <SelectTrigger className="h-8 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.filter((r) => r !== 'owner').map((r) => (
                            <SelectItem key={r} value={r}>
                              {t(`roles.${r}` as any)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function PanelHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h1 className="font-display text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
    </div>
  )
}
