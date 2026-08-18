import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderLinuxJoinScript } from '../lib/join-template.js'

test('linux join script embeds base url and token, targets enroll endpoint', () => {
  const s = renderLinuxJoinScript({ baseUrl: 'https://d.trycloudflare.com', token: 'abc123abc123abc1' })
  assert.match(s, /^#!\/usr\/bin\/env bash/)
  assert.ok(s.includes("https://d.trycloudflare.com")) // 作为 BASE_URL 内联
  assert.ok(s.includes('/api/fleet/enroll'))            // 经 ${BASE_URL} 拼接
  assert.ok(s.includes('abc123abc123abc1'))
  assert.ok(s.includes('ssh-keygen'))
  assert.ok(s.includes('-R 127.0.0.1:'))
  assert.ok(s.includes('IdentitiesOnly=yes')) // 只用隧道 key,避免 agent 多 key 撞 MaxAuthTries
  assert.ok(s.includes('systemd') || s.includes('systemctl'))
})

test('token is shell-single-quote-safe (rejects injection chars)', () => {
  assert.throws(() => renderLinuxJoinScript({ baseUrl: 'https://d', token: "a'b" }), /invalid token/)
  assert.throws(() => renderLinuxJoinScript({ baseUrl: "https://d';rm -rf", token: 'abc123abc123abc1' }), /invalid baseUrl/)
})
