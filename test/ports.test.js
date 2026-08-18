import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allocatePort } from '../lib/ports.js'

test('picks the lowest free port in range', () => {
  assert.equal(allocatePort([], [20001, 20999]), 20001)
  assert.equal(allocatePort([20001, 20002], [20001, 20999]), 20003)
  assert.equal(allocatePort([20003, 20001], [20001, 20999]), 20002)
})

test('throws when range exhausted', () => {
  assert.throws(() => allocatePort([20001, 20002], [20001, 20002]), /no free port/)
})
