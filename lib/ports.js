/**
 * 在 [lo, hi] 闭区间里挑一个未被占用的最小端口。用于给每台入网机器分配中继环回端口。
 * @param {number[]} used 已占用端口
 * @param {[number,number]} range [lo, hi]
 * @returns {number}
 */
export function allocatePort(used, range) {
  const [lo, hi] = range
  const taken = new Set(used)
  for (let p = lo; p <= hi; p++) {
    if (!taken.has(p)) return p
  }
  throw new Error(`no free port in range ${lo}-${hi}`)
}
