/** Optional launcher source; importing it never enrolls or contacts a provider. */
export {BOOTSTRAP_SH} from "./bootstrap.js";
export {CONVERGENCE_PHASES, COMPONENT_STATES, detectSystemFacts, classifyComponents, planConvergence, sanitizeCheckpoint, isSecretFreeCheckpoint} from "./convergence.js";
export {createEnrollmentTicketStore} from "./ticket.js";
export {evaluateBootstrapPreflight} from "./preflight.js";
export {createBootstrapSession, recordRootCeremony, attachPreflight, attachClaim, completeBootstrap, assertNoPostBootstrapPasswordPrompt, createBootstrapReceipt} from "./session.js";
import {BOOTSTRAP_SH} from "./bootstrap.js";

/** Render only deployment-supplied coordinates; never perform an enrollment. */
export function renderBootstrap({brokerOrigin,checkpointDir="/var/lib/fleet"}) {
  let parsed;
  try {parsed=new URL(brokerOrigin);} catch {throw new Error("BOOTSTRAP_ORIGIN_REQUIRED");}
  if(parsed.protocol!=="https:" || parsed.origin!==brokerOrigin || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("BOOTSTRAP_ORIGIN_INVALID");
  if(typeof checkpointDir!=="string" || !checkpointDir.startsWith("/") || checkpointDir.split("/").includes("..") || checkpointDir.includes("\0") || /[\r\n]/.test(checkpointDir)) throw new Error("BOOTSTRAP_PATH_INVALID");
  const quoted=value=>"'"+value.replaceAll("'","'\\''")+"'";
  return BOOTSTRAP_SH.replace('BROKER_ORIGIN="${GHOSTFLEET_BROKER_ORIGIN:-}"',"BROKER_ORIGIN="+quoted(brokerOrigin))
    .replace('CHECKPOINT_DIR="${GHOSTFLEET_CHECKPOINT_DIR:-/var/lib/fleet}"',"CHECKPOINT_DIR="+quoted(checkpointDir));
}
