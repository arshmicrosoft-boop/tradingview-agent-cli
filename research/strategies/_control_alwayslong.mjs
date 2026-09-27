/**
 * NEGATIVE CONTROL — always long, no stop, no exit logic.
 *
 * The real buy-and-hold benchmark. In a bull run it makes money; the question
 * is whether it can clear the RISK-ADJUSTED criteria. If it can, the gate is
 * rewarding raw beta rather than skill, which would be a serious defect.
 */
export default function alwaysLong() {
  return { side: "buy" };
}
export const grid = { _none: [1] };