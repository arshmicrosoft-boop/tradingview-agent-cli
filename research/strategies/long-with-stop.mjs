/**
 * Long with the harness default risk envelope: a 2-ATR stop and a max holding
 * period. NOT buy-and-hold — it inherits the risk engine, so it gets stopped
 * out repeatedly. The real benchmark lives in gate.mjs and uses raw bars.
 */
export default function longWithStop() {
  return { side: "buy" };
}