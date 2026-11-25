/**
 * The plugin's own version, hand-maintained for the browser bundle.
 *
 * The card ships as `lib/client.js`, served to the host dialog as a browser
 * script: `package.json` is neither reachable nor guaranteed to be the file
 * the running build came from. A manifest lying next to the code is worse than
 * a number a test keeps honest.
 *
 * `tests/version-sync.test.ts` fails when this drifts from `package.json`, so
 * the release checklist cannot ship a card that calls itself the wrong version.
 *
 * @module dsh-xdpool/version
 */
export const POOL_VERSION = '3.2.0'

/**
 * Compare two dotted versions.
 *
 * Numeric segments compare as numbers and everything else as text, which is the ordering npm
 * itself uses for the plain `x.y.z` releases this package publishes. A prerelease tag is older
 * than its release (`2.7.3-rc.1 < 2.7.3`), which is what the `-` check below states.
 *
 * WHY IT LIVES HERE AND NOT IN update-check
 *
 * The card compares versions in the BROWSER (`shell.tsx`, `UpdatePanel.tsx`). While this lived
 * in `update-check.ts`, importing it dragged that whole module into `lib/client.js` — and once
 * the update chain started reading its own package name from disk, that meant `node:fs` in a
 * browser bundle (`tests/client-bundle-purity.test.ts` caught it). Version arithmetic is pure;
 * keeping it next to the version constant is what makes the bundle stay pure.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): { parts: number[]; pre: string } => {
    const [core, ...rest] = value.trim().replace(/^v/u, '').split('-')
    const parts = (core ?? '').split('.').map(segment => {
      const number = Number.parseInt(segment, 10)
      return Number.isFinite(number) ? number : 0
    })
    return { parts, pre: rest.join('-') }
  }
  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.parts.length, b.parts.length)
  for (let i = 0; i < length; i += 1) {
    const left1 = a.parts[i] ?? 0
    const right1 = b.parts[i] ?? 0
    if (left1 !== right1) return left1 < right1 ? -1 : 1
  }
  // Same numbers: a prerelease is older than the release it precedes.
  if (a.pre === '' && b.pre !== '') return 1
  if (a.pre !== '' && b.pre === '') return -1
  return a.pre === b.pre ? 0 : (a.pre < b.pre ? -1 : 1)
}
