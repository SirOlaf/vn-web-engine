/** Explicit owner adapter for native particle accessors. */
export function readPrimaryFrameIndex(particle) {
  return particle.frame();
}

/** Exact whole-function route for native AokanaParticle_Advance at RVA 0x95be0. */
export function advanceParticle(particle) {
  return particle.update();
}
