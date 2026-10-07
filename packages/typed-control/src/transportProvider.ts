/**
 * Provider adapter interface: provider-specific resolution/observation only.
 *
 * The provider-neutral contract owns purpose, authority, target-proof, and
 * effect-state fencing. Provider adapters only materialize runtime evidence for
 * a single PlaneBinding and never decide cross-purpose authority or dispatch.
 */

import type { Candidate, Plane, PlaneBinding, TransportRequest } from "./transportContract.js";

export interface TransportProviderAdapter {
  readonly plane: Plane;
  candidates(request: TransportRequest, binding: PlaneBinding): Candidate[];
  observedTags(binding: PlaneBinding): string[];
  health(binding: PlaneBinding): string;
}
