'use client'
import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'

type Key = { id: number; public_key: string; label: string | null; created_at: number }

export function SshAccessSection() {
  const [keys, setKeys] = useState<Key[]>([])
  const [publicKey, setPublicKey] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try { setKeys((await apiFetch<{ keys: Key[] }>('/api/me/ssh-keys')).keys) } catch { /* ignore */ }
  }
  useEffect(() => { load() }, [])

  const add = async () => {
    setBusy(true); setError(null)
    try {
      await apiFetch('/api/me/ssh-keys', { method: 'POST', body: JSON.stringify({ public_key: publicKey, label: label || undefined }) })
      setPublicKey(''); setLabel(''); await load()
    } catch (e: any) { setError(e?.message || 'Failed to add key') } finally { setBusy(false) }
  }

  const remove = async (id: number) => {
    await apiFetch(`/api/me/ssh-keys/${id}`, { method: 'DELETE' }).catch(() => {})
    await load()
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold text-foreground">SSH Access</h3>
        <p className="text-sm text-muted-foreground">Add your SSH public key to get an isolated shell on the dev server. Connect with <code>ssh &lt;your-username&gt;@&lt;host&gt; -p 2222</code>.</p>
      </div>
      <div className="space-y-2">
        <textarea
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          rows={3}
          placeholder="ssh-ed25519 AAAA... you@device"
          className="w-full bg-surface-1 text-foreground border border-border rounded-md px-3 py-2 font-mono text-sm"
        />
        <div className="flex gap-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional, e.g. phone)"
            className="flex-1 bg-surface-1 text-foreground border border-border rounded-md px-3 py-2 text-sm" />
          <button onClick={add} disabled={busy || !publicKey.trim()}
            className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50">Add key</button>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
      <ul className="space-y-1">
        {keys.map(k => (
          <li key={k.id} className="flex items-center justify-between gap-2 text-sm border border-border/40 rounded-md px-3 py-2">
            <span className="font-mono truncate">{k.label ? `${k.label} — ` : ''}{k.public_key.slice(0, 40)}…</span>
            <button onClick={() => remove(k.id)} className="text-red-500 hover:underline shrink-0">Remove</button>
          </li>
        ))}
        {keys.length === 0 && <li className="text-sm text-muted-foreground">No keys yet.</li>}
      </ul>
    </section>
  )
}
