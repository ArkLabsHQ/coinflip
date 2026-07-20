/**
 * House stake economics for variable-odds games. The `computeHouseStake`
 * formula is single-sourced in the `arkade-coinflip` lib (`stake-math.ts`) so
 * the server and the browser client share one copy and can't drift (a drifted
 * client shows wrong odds and gets the bet rejected here). This module keeps
 * the server's stable import path by re-exporting it under the same name.
 */

export { computeHouseStake } from 'arkade-coinflip'
